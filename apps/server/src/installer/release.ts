import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPlaceholderReleaseKey,
  OFFICIAL_RUNNER_RELEASE_PUBKEY,
  parseMinisignPublicKey,
  RELEASE_MANIFEST_MAX_BYTES,
  RELEASE_MINISIG_MAX_BYTES,
  type RunnerReleaseManifest,
  RunnerReleaseManifestSchema,
  type RunnerUpdateSettings,
  runnerAtLeast,
  type SignedReleaseProof,
  type WorkstationRelease,
} from '@aom/shared';
import type { Config } from '../config.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, type Queryable } from '../db/sql.ts';

/**
 * The runner release the app serves (`aom-runner-<version>.tgz`, built by `pnpm package:runner`), with its sha256.
 * The directory comes from `AOM_RUNNER_RELEASE_DIR`; otherwise `release/` next to the working directory or the repo.
 */
export interface RunnerRelease {
  version: string;
  file: string;
  sha256: string;
  size: number;
}

const FILE = /^aom-runner-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\.tgz$/;
export const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function releaseDirs(config: Pick<Config, 'runnerReleaseDir'>): string[] {
  if (config.runnerReleaseDir) return [resolve(config.runnerReleaseDir)];
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(process.cwd(), 'release'),
    resolve(process.cwd(), '../../release'),
    resolve(here, '../../../../release'), // apps/server/src/installer -> repo root
    resolve(here, '../../../release'), // apps/server/dist -> repo root
  ];
}

const cmp = (a: string, b: string): number => {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

const sums = new Map<string, { key: string; sha256: string }>();

async function sha256File(file: string, key: string): Promise<string> {
  const hit = sums.get(file);
  if (hit && hit.key === key) return hit.sha256;
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  const sha256 = h.digest('hex');
  sums.set(file, { key, sha256 });
  return sha256;
}

/** The release directory this server serves from (the first candidate that exists), or null. */
export function releaseDir(config: Pick<Config, 'runnerReleaseDir'>): string | null {
  return releaseDirs(config).find((d) => existsSync(d)) ?? null;
}

/** All releases in the directory, newest first. */
export async function listReleases(config: Pick<Config, 'runnerReleaseDir'>): Promise<RunnerRelease[]> {
  const dir = releaseDirs(config).find((d) => existsSync(d));
  if (!dir) return [];
  const out: RunnerRelease[] = [];
  for (const name of readdirSync(dir)) {
    const m = FILE.exec(name);
    if (!m?.[1]) continue;
    const file = join(dir, name);
    const st = statSync(file);
    if (!st.isFile()) continue;
    out.push({
      version: m[1],
      file,
      size: st.size,
      sha256: await sha256File(file, `${st.size}:${st.mtimeMs}`),
    });
  }
  return out.sort((a, b) => cmp(b.version, a.version));
}

export async function latestRelease(config: Pick<Config, 'runnerReleaseDir'>): Promise<RunnerRelease | null> {
  return (await listReleases(config))[0] ?? null;
}

/** The kill switch for runner auto-updates (a super admin sets it on the platform Runners page). */
export const RUNNER_UPDATES_PAUSED_KEY = 'runners.auto_update_paused';

export async function runnerUpdatesPaused(db: Queryable): Promise<boolean> {
  const r = await one(db, 'SELECT value FROM platform_settings WHERE key=$1', [RUNNER_UPDATES_PAUSED_KEY]);
  return r?.value === true;
}

export async function setRunnerUpdatesPaused(ctx: Ctx, paused: boolean, by: string): Promise<void> {
  await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1,$2::jsonb,$3,$4)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at`,
    [RUNNER_UPDATES_PAUSED_KEY, JSON.stringify(paused), by, ctx.clock.now()],
  );
  ctx.log.info({ paused, by }, 'runner auto-updates switch changed');
}

export async function runnerUpdateSettings(ctx: Ctx): Promise<RunnerUpdateSettings> {
  const row = await one(ctx.pool, 'SELECT value, updated_at FROM platform_settings WHERE key=$1', [
    RUNNER_UPDATES_PAUSED_KEY,
  ]);
  return {
    paused: row?.value === true,
    updatedAt: iso(row?.updated_at ?? null),
    latestVersion: (await latestRelease(ctx.config))?.version ?? null,
  };
}

export async function findRelease(
  config: Pick<Config, 'runnerReleaseDir'>,
  version: string,
): Promise<RunnerRelease | null> {
  return (await listReleases(config)).find((r) => r.version === version) ?? null;
}

// ------------------------------------------------------------------------------------------ signed releases (R18-U, R21, R27)

/**
 * The oldest runner a server with "Only signed runners" on lets pair or connect (`MIN_PAIRABLE_RUNNER`). Runner and
 * product share one number space from 1.10.0 on (coordinator decision): the runner's `RUNNER_VERSION` jumps from 0.1.77
 * to 1.10.0, which semver still sees as newer. Equal to the runner's compiled-in `MIN_TRUSTED_RUNNER`
 * (`apps/runner/src/update/floor.ts`) and to `RUNNER_FLOOR` of the root-owned admin tool (`guildwise-admin.cjs`).
 * `signed-runner-setting.test.ts` keeps the three equal.
 */
export const MIN_PAIRABLE_RUNNER = '1.10.0';

/** 409 for a runner pin below `MIN_PAIRABLE_RUNNER` (stored or asked for on the new paths). */
export const RUNNER_PIN_BELOW_FLOOR = 'runner_pin_below_floor';

/** The product release from which "Only signed runners" refuses older runners: what the user text names. */
export const SIGNED_RUNNERS_SINCE = 'Guildwise 1.10.0';

/** The new release paths 1.10.0 runners and installers use (`/api/runner/releases/<file>`). */
export const RELEASE_MANIFEST_FILE = 'manifest.json';
export const RELEASE_MINISIG_FILE = 'manifest.json.minisig';
/** A retained release's own signed manifest (`?version=<v>` on the new paths, for pinned runners). */
export const versionManifestFile = (version: string): string => `manifest-${version}.json`;
export const versionMinisigFile = (version: string): string => `manifest-${version}.json.minisig`;

/**
 * The minisign public key this server trusts for runner releases: `AOM_RUNNER_RELEASE_PUBKEY` (own-key mode), else the
 * official key, else null while the official key is still the placeholder (then nothing verifies).
 */
export function trustedReleaseKey(config: Pick<Config, 'runnerReleasePubkey'>): string | null {
  if (config.runnerReleasePubkey) return config.runnerReleasePubkey;
  if (isPlaceholderReleaseKey(OFFICIAL_RUNNER_RELEASE_PUBKEY)) return null;
  return OFFICIAL_RUNNER_RELEASE_PUBKEY;
}

/**
 * Verifies a minisign signature (`.minisig` text) over `message` with a public key line (`RW...`). Both the legacy
 * (`Ed`) and the default pre-hashed (`ED`, BLAKE2b-512) signatures are accepted; the global signature over the trusted
 * comment must verify too. Returns the key id, or null for anything that does not verify.
 */
export function verifyMinisign(
  message: Buffer,
  minisig: string,
  publicKeyLine: string,
): { keyId: string; trustedComment: string } | null {
  try {
    const pub = parseMinisignPublicKey(publicKeyLine);
    if (!pub) return null;
    const lines = minisig.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length < 4 || !lines[0]?.startsWith('untrusted comment:')) return null;
    const sig = Buffer.from(lines[1] as string, 'base64');
    if (sig.length !== 74) return null;
    const alg = sig.subarray(0, 2).toString('latin1');
    if (alg !== 'Ed' && alg !== 'ED') return null;
    const keyId = Buffer.from(sig.subarray(2, 10)).reverse().toString('hex').toUpperCase();
    if (keyId !== pub.keyId) return null;
    const signature = sig.subarray(10);
    const trusted = lines[2] as string;
    if (!trusted.startsWith('trusted comment: ')) return null;
    const trustedComment = trusted.slice('trusted comment: '.length);
    const global = Buffer.from(lines[3] as string, 'base64');
    if (global.length !== 64) return null;
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(pub.publicKey).toString('base64url') },
      format: 'jwk',
    });
    const data = alg === 'ED' ? createHash('blake2b512').update(message).digest() : message;
    if (!verify(null, data, key, signature)) return null;
    if (!verify(null, Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]), key, global))
      return null;
    return { keyId, trustedComment };
  } catch {
    return null;
  }
}

export type ReleaseProofVerdict =
  | { ok: true; release: WorkstationRelease & { keyId: string }; manifest: RunnerReleaseManifest }
  | {
      ok: false;
      reason:
        | 'missing'
        | 'no_trusted_key'
        | 'bad_signature'
        | 'bad_manifest'
        | 'version_mismatch'
        | 'below_floor';
    };

/**
 * Checks a runner's signed-release proof (pairing `release`, `hello.release`): the manifest's signature verifies with the
 * trusted key, the manifest parses, its version equals the version the runner reports and is at or above
 * `MIN_PAIRABLE_RUNNER`. It cannot attest the code the machine runs (Q10): it keeps unsigned and outdated builds out.
 */
export function checkReleaseProof(
  config: Pick<Config, 'runnerReleasePubkey'>,
  runnerVersion: string,
  proof: SignedReleaseProof | undefined | null,
): ReleaseProofVerdict {
  if (!proof) return { ok: false, reason: 'missing' };
  const key = trustedReleaseKey(config);
  if (!key) return { ok: false, reason: 'no_trusted_key' };
  const manifestBytes = Buffer.from(proof.manifest, 'utf8');
  if (manifestBytes.length > RELEASE_MANIFEST_MAX_BYTES || proof.minisig.length > RELEASE_MINISIG_MAX_BYTES)
    return { ok: false, reason: 'bad_signature' };
  const v = verifyMinisign(manifestBytes, proof.minisig, key);
  if (!v) return { ok: false, reason: 'bad_signature' };
  let manifest: RunnerReleaseManifest;
  try {
    const parsed = RunnerReleaseManifestSchema.safeParse(JSON.parse(proof.manifest));
    if (!parsed.success) return { ok: false, reason: 'bad_manifest' };
    manifest = parsed.data;
  } catch {
    return { ok: false, reason: 'bad_manifest' };
  }
  if (manifest.version !== runnerVersion) return { ok: false, reason: 'version_mismatch' };
  if (!runnerAtLeast(manifest.version, MIN_PAIRABLE_RUNNER)) return { ok: false, reason: 'below_floor' };
  return {
    ok: true,
    release: { version: manifest.version, sha256: manifest.sha256, keyId: v.keyId },
    manifest,
  };
}

/** Whether a stored runner version is below the floor (an unknown version counts as below). */
export const belowPairableFloor = (version: string | null | undefined): boolean =>
  !runnerAtLeast(version ?? null, MIN_PAIRABLE_RUNNER);

/** One of the files the new release paths serve, by its published name; null when it is not there. */
export function servedReleaseFile(config: Pick<Config, 'runnerReleaseDir'>, name: string): string | null {
  const dir = releaseDir(config);
  if (!dir) return null;
  const file = join(dir, name);
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

/**
 * The signed manifest and signature the new paths serve for `version` (a pinned runner's `?version=`): the latest
 * release's `manifest.json` when it names that version, else the retained release's own `manifest-<v>.json` and
 * `.minisig`. Null when this server keeps no signed manifest for that version.
 */
export function manifestFilesFor(
  config: Pick<Config, 'runnerReleaseDir'>,
  version: string | undefined,
): { manifest: string; minisig: string | null } | null {
  const latest = servedReleaseFile(config, RELEASE_MANIFEST_FILE);
  const latestSig = servedReleaseFile(config, RELEASE_MINISIG_FILE);
  if (version === undefined) return latest ? { manifest: latest, minisig: latestSig } : null;
  if (latest) {
    try {
      if ((JSON.parse(readFileSync(latest, 'utf8')) as { version?: unknown }).version === version)
        return { manifest: latest, minisig: latestSig };
    } catch {
      // an unreadable latest manifest: fall through to the per-version files
    }
  }
  const own = servedReleaseFile(config, versionManifestFile(version));
  return own ? { manifest: own, minisig: servedReleaseFile(config, versionMinisigFile(version)) } : null;
}

/**
 * The release this server serves verifies: `manifest.json` and its `.minisig` exist and verify with the trusted key, and
 * the tarball the manifest names exists with that sha256. With "Only signed runners" on, boot refuses otherwise
 * (R18-U: an image built with `RUNNER_RELEASE=dev` cannot enforce), and the setting cannot be turned on.
 */
export async function verifyServedRelease(
  config: Pick<Config, 'runnerReleaseDir' | 'runnerReleasePubkey'>,
): Promise<{ ok: true; version: string; keyId: string } | { ok: false; reason: string }> {
  const key = trustedReleaseKey(config);
  if (!key)
    return {
      ok: false,
      reason:
        'no trusted release key: the official key is still the placeholder and AOM_RUNNER_RELEASE_PUBKEY is not set',
    };
  const mf = servedReleaseFile(config, RELEASE_MANIFEST_FILE);
  const sf = servedReleaseFile(config, RELEASE_MINISIG_FILE);
  if (!mf || !sf)
    return { ok: false, reason: 'the runner release has no manifest.json and manifest.json.minisig' };
  const bytes = readFileSync(mf);
  const v = verifyMinisign(bytes, readFileSync(sf, 'utf8'), key);
  if (!v) return { ok: false, reason: 'the runner release manifest is not signed by the trusted key' };
  let manifest: RunnerReleaseManifest;
  try {
    manifest = RunnerReleaseManifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch {
    return { ok: false, reason: 'the runner release manifest is not valid' };
  }
  const tgz = servedReleaseFile(config, manifest.file);
  if (!tgz || manifest.file !== `aom-runner-${manifest.version}.tgz`)
    return { ok: false, reason: `the runner release ${manifest.file} is missing` };
  const st = statSync(tgz);
  if ((await sha256File(tgz, `${st.size}:${st.mtimeMs}`)) !== manifest.sha256)
    return { ok: false, reason: `the runner release ${manifest.file} does not match the signed sha256` };
  return { ok: true, version: manifest.version, keyId: v.keyId };
}
