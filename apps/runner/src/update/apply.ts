import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type RunnerReleaseResponse, RunnerReleaseResponseSchema } from '@aom/shared';
import type { Policy } from '../policy/schema.ts';
import { MIN_TRUSTED_RUNNER } from './floor.ts';
import { type InstallLayout, installedVersions } from './layout.ts';
import { type FetchedRelease, verifyUpdate } from './verify.ts';

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** Refuse a download that is larger than this (the runner is ~50 MB with its dependencies). */
export const MAX_RELEASE_BYTES = 500 * 1024 * 1024;

export class ChecksumMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `the download did not match its checksum (expected ${expected.slice(0, 12)}..., got ${actual.slice(0, 12)}...)`,
    );
    this.name = 'ChecksumMismatchError';
  }
}

/** `GET <server>/api/runner/release`: the version the server offers, its sha256, its download URL and the kill switch. */
export async function fetchRelease(
  serverUrl: string,
  f: typeof fetch = fetch,
  timeoutMs = 15_000,
  /** Safe mode: ask for exactly this release (an older one too) instead of the latest. */
  version?: string,
): Promise<RunnerReleaseResponse> {
  const url = new URL('/api/runner/release', serverUrl);
  if (version) url.searchParams.set('version', version);
  const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`the server answered HTTP ${res.status} for the runner release`);
  return RunnerReleaseResponseSchema.parse(await res.json());
}

export type Fetcher = typeof fetch;

/** The 1.10.0 release paths (R21): every 1.10.0 runner uses these; the legacy `/api/runner/release` is for old runners. */
export const RELEASES_PATH = '/api/runner/releases';
/**
 * The kill switch on the new paths: the server sets this header on `manifest.json` while a super admin pauses runner
 * auto-updates (the legacy JSON carried `autoUpdatePaused`).
 */
export const UPDATES_PAUSED_HEADER = 'x-runner-updates-paused';

export class UntrustedReleaseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UntrustedReleaseError';
  }
}

/** A release the runner has verified (signature or allowed unsigned origin, floor, no downgrade) and may download. */
export interface VerifiedRelease extends RunnerReleaseResponse {
  proof: { manifestText: string; minisig: string | null };
  signed: boolean;
  keyId: string | null;
}

async function getText(
  url: URL,
  f: Fetcher,
  timeoutMs: number,
): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, text: res.ok ? await res.text() : '', headers: res.headers };
}

/**
 * Reads the offered release from the 1.10.0 paths (`manifest.json` and `manifest.json.minisig`), falling back to the
 * legacy JSON only when the server has no new paths (an older server, 404); then verifies it (`verifyUpdate`). Throws
 * `UntrustedReleaseError` when it must not be installed.
 */
export async function fetchVerifiedRelease(
  serverUrl: string,
  opts: {
    current: string;
    pin: string | null;
    trustedKey: string;
    policy: Pick<Policy, 'allowUnsignedUpdatesFrom' | 'legacyUpdateOrigin'>;
    fetch?: Fetcher;
    timeoutMs?: number;
  },
): Promise<VerifiedRelease> {
  const f = opts.fetch ?? fetch;
  const timeout = opts.timeoutMs ?? 15_000;
  const origin = new URL(serverUrl).origin;
  const at = (file: string): URL => {
    const u = new URL(`${RELEASES_PATH}/${file}`, serverUrl);
    if (opts.pin) u.searchParams.set('version', opts.pin);
    return u;
  };
  const m = await getText(at('manifest.json'), f, timeout);
  let fetched: FetchedRelease;
  let paused = false;
  let url: string;
  if (m.status === 200) {
    const sig = await getText(at('manifest.json.minisig'), f, timeout);
    if (sig.status !== 200 && sig.status !== 404)
      throw new Error(`the server answered HTTP ${sig.status} for the release signature`);
    fetched = { manifestText: m.text, minisig: sig.status === 200 ? sig.text : null, origin };
    paused = (m.headers.get(UPDATES_PAUSED_HEADER) ?? '').toLowerCase() === 'true';
    url = '';
  } else if (m.status === 404) {
    // an older server: its legacy answer has no manifest and no signature, so it is unsigned
    const legacy = await fetchRelease(serverUrl, f, timeout, opts.pin ?? undefined);
    fetched = {
      manifestText: JSON.stringify({
        version: legacy.version,
        file: `aom-runner-${legacy.version}.tgz`,
        sha256: legacy.sha256,
        minRunner: legacy.version,
        floor: MIN_TRUSTED_RUNNER,
        allowDowngrade: false,
        nodeRuntime: {},
      }),
      minisig: null,
      origin,
    };
    paused = legacy.autoUpdatePaused;
    url = new URL(legacy.url, serverUrl).toString();
  } else throw new Error(`the server answered HTTP ${m.status} for the runner release`);
  const verdict = verifyUpdate({
    fetched,
    current: opts.current,
    pin: opts.pin,
    trustedKey: opts.trustedKey,
    policy: opts.policy,
  });
  if (!verdict.ok) throw new UntrustedReleaseError(verdict.reason);
  const file = verdict.manifest.file;
  return {
    version: verdict.manifest.version,
    sha256: verdict.manifest.sha256,
    size: 0,
    url: url || new URL(`${RELEASES_PATH}/${encodeURIComponent(file)}`, serverUrl).toString(),
    autoUpdatePaused: paused,
    proof: { manifestText: fetched.manifestText, minisig: fetched.minisig },
    signed: verdict.signed,
    keyId: verdict.keyId,
  };
}

/** Downloads `url` to `dest` and returns its sha256 (hex) and size. Streams, so a big file never sits in memory. */
export async function downloadTo(
  url: string,
  dest: string,
  f: Fetcher = fetch,
  timeoutMs = 10 * 60_000,
): Promise<{ sha256: string; size: number }> {
  const res = await f(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok || !res.body) throw new Error(`the download failed (HTTP ${res.status})`);
  const hash = createHash('sha256');
  let size = 0;
  const body = Readable.fromWeb(res.body as never);
  body.on('data', (chunk: Buffer) => {
    size += chunk.length;
    hash.update(chunk);
    if (size > MAX_RELEASE_BYTES) body.destroy(new Error('the download is larger than expected'));
  });
  await pipeline(body, createWriteStream(dest));
  return { sha256: hash.digest('hex'), size };
}

export function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', ['-xzf', archive, '-C', into], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err += String(d);
    });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`could not unpack the runner (tar exit ${code}): ${err.slice(0, 200)}`)),
    );
  });
}

export interface StageDeps {
  download?: typeof downloadTo;
  unpack?: typeof untar;
}

/**
 * Downloads a release, verifies its sha256 and unpacks it next to the running version as `<root>/<version>/aom-runner`.
 * Nothing is unpacked unless the checksum matches; the folder appears under its final name only once complete, so an
 * interrupted download never leaves a half version that could be switched to. Returns the package folder.
 */
export async function stageRelease(
  layout: InstallLayout,
  release: Pick<RunnerReleaseResponse, 'version' | 'sha256' | 'url'> & {
    proof?: { manifestText: string; minisig: string | null };
  },
  f: Fetcher = fetch,
  deps: StageDeps = {},
): Promise<string> {
  const finalDir = layout.versionDir(release.version);
  const pkg = join(finalDir, 'aom-runner');
  if (existsSync(join(pkg, 'dist')) && readText(join(finalDir, '.sha256')) === release.sha256) return pkg;

  const work = join(layout.root, `.update-${release.version}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const file = join(work, `aom-runner-${release.version}.tgz`);
    const got = await (deps.download ?? downloadTo)(release.url, file, f);
    if (got.sha256 !== release.sha256.toLowerCase())
      throw new ChecksumMismatchError(release.sha256, got.sha256);
    const unpacked = join(work, 'unpacked');
    mkdirSync(unpacked);
    await (deps.unpack ?? untar)(file, unpacked);
    if (!existsSync(join(unpacked, 'aom-runner', 'dist', 'aom-runner.mjs')))
      throw new Error('the downloaded archive does not hold a runner (no aom-runner/dist/aom-runner.mjs)');
    writeFileSync(join(unpacked, '.sha256'), release.sha256);
    // The verified manifest and signature go with the version: the signed-release proof this version sends in `hello`.
    if (release.proof) {
      writeFileSync(join(unpacked, 'manifest.json'), release.proof.manifestText);
      if (release.proof.minisig)
        writeFileSync(join(unpacked, 'manifest.json.minisig'), release.proof.minisig);
    }
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(unpacked, finalDir);
    return pkg;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Replaces the symlink `link` so it points at `target`, atomically (a new link next to it, renamed over it). */
export function replaceLink(link: string, target: string): void {
  const tmp = `${link}.new-${process.pid}`;
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
}

/** Points `current` at the new package and `previous` at the one that was running, so a rollback has somewhere to go. */
export function switchTo(layout: InstallLayout, newPackageDir: string, oldPackageDir: string): void {
  replaceLink(layout.previous, oldPackageDir);
  replaceLink(layout.current, newPackageDir);
}

/** Points `current` back at the `previous` package. Throws when there is none. */
export function switchBack(layout: InstallLayout, oldPackageDir: string): void {
  if (!existsSync(join(oldPackageDir, 'dist', 'aom-runner.mjs')))
    throw new Error(`the previous version is gone (${oldPackageDir}); cannot roll back`);
  replaceLink(layout.current, oldPackageDir);
}

/**
 * Removes every unpacked version except the ones named in `keep` (the running one and the one to roll back to). Called
 * once the new version has connected, never earlier.
 */
export function pruneVersions(layout: InstallLayout, keep: string[]): string[] {
  const removed: string[] = [];
  for (const v of installedVersions(layout)) {
    if (keep.includes(v)) continue;
    rmSync(layout.versionDir(v), { recursive: true, force: true });
    removed.push(v);
  }
  return removed;
}

export type ServiceMode = 'systemd' | 'launchd' | 'background';

/**
 * How this runner is kept running, which decides how it is restarted: the installer writes `service-mode`; for a 0.1.0
 * install that has no such file it is guessed from the environment the service manager sets. Null: unknown (started by
 * hand), so the runner does not update itself rather than switch versions and leave nobody to start the new one.
 */
export function detectServiceMode(
  layout: InstallLayout,
  env: NodeJS.ProcessEnv = process.env,
  launchdLabel = 'com.guildwisehq.runner',
): ServiceMode | null {
  const written = readText(layout.modeFile)?.trim();
  if (written === 'systemd' || written === 'launchd' || written === 'background') return written;
  if (env.INVOCATION_ID && env.JOURNAL_STREAM) return 'systemd';
  if (env.XPC_SERVICE_NAME === launchdLabel) return 'launchd';
  if (existsSync(layout.fallbackLauncher)) return 'background';
  return null;
}

/**
 * Starts whatever must bring the runner back after this process exits. systemd (`Restart=always`) and launchd
 * (`KeepAlive`) restart a runner that exits by themselves, so nothing is spawned; the background fallback has no
 * supervisor, so a detached helper runs `start-runner.sh` a few seconds after this process is gone.
 */
export function scheduleRestart(
  layout: InstallLayout,
  mode: ServiceMode,
  spawnFn: typeof spawn = spawn,
): void {
  if (mode !== 'background') return;
  const child = spawnFn('sh', ['-c', 'sleep 5; exec "$1"', 'sh', layout.fallbackLauncher], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}
