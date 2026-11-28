import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { type Executor, realExecutor } from './exec.ts';
import type { Params, Platform } from './types.ts';

/**
 * DESIGN §5 (1.10.0): DevOps installs stack tools as the runner user, in the runner account's own home only, never as
 * root and never with a package manager. Every download lands in `<root>.stage` (next to the tool folder, not in it:
 * tool-pin-lib S2), is checked against the vendor's checksum (or a pinned one, `pins.ts`), unpacked there, and only then
 * renamed into `<root>/<tool>/<version>` and linked into `<root>/bin`. `<root>` is
 * `<passwd home>/.local/share/guildwise/toolchains`, and nothing outside it is installed into (tool-pin-lib Decision 3).
 *
 * tool-pin-lib B1: the commands run with an exact environment (PATH = the verified tool folders' bins plus
 * `/usr/bin:/bin`, HOME the account home, LANG), `tar` and `unzip` by absolute path, and every absolute path a step names
 * must lie under no guarded tool folder, or under one that verified at the start of the run (`stepAllowed`).
 */

export const TOOLCHAINS_REL = ['.local', 'share', 'guildwise', 'toolchains'] as const;

/** The runner account's home from the password database (never `$HOME`). */
export const accountHome = (): string => userInfo().homedir;

/** `<home>/.local/share/guildwise/toolchains`: the only place stack tools are installed. */
export function toolchainsRoot(home: string = accountHome()): string {
  return join(home, ...TOOLCHAINS_REL);
}

/** tool-pin-lib S2: where downloads are checked and unpacked, next to the tool folder (`<root>.stage`). */
export const stageDir = (root: string): string => `${root}.stage`;

export interface Checksum {
  algo: 'sha256' | 'sha512';
  hex: string;
}

/** One verified download. */
export interface Archive {
  url: string;
  checksum: Checksum;
  /** `tar` (gz/xz by tar itself), `zip`, or a single executable `file`. */
  format: 'tar' | 'zip' | 'file';
  tool: string;
  version: string;
  /** For `file`: its name in the install folder (made executable). */
  fileName?: string;
  /** Use the single top-level folder of the archive as the install folder. */
  strip?: boolean;
  /**
   * An install folder other than `<root>/<tool>/<version>` (a .NET root, the Android SDK's `cmdline-tools/latest`).
   * Must be inside the runner account's home. `merge` adds to what is there (.NET roots hold several SDKs); `replace`
   * swaps the folder.
   */
  into?: { dir: string; mode: 'merge' | 'replace' };
  /** A path whose existence proves this archive is already installed (default: the install folder). */
  present?: string;
  /** Link name in `<root>/bin` -> path relative to the install folder. */
  bins?: Record<string, string>;
}

/** A command run as the runner user after the downloads (`uv python install`, `rustup-init -y`). */
export interface UserStep {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  /** Written to stdin (`sdkmanager --licenses` answers). */
  input?: string;
  /** A failing exit is logged, not an error (accepting licences that are already accepted). */
  mayFail?: boolean;
}

export interface UserInstallPlan {
  archives: Archive[];
  steps?: UserStep[];
  /** Extra links in `<root>/bin` (name -> absolute target inside the root), made after the steps. */
  links?: Record<string, string>;
}

export interface ResolveContext {
  params: Params;
  platform: Platform;
  /** `x64` or `arm64` (Node's `process.arch`). */
  arch: string;
  root: string;
  /** HTTPS GET as text (release metadata, checksum files). */
  fetchText(url: string): Promise<string>;
}

/** Turns a tool's request into a plan; `null` when there is no user-space install on this platform. */
export type UserInstallResolver = (ctx: ResolveContext) => Promise<UserInstallPlan | null>;

export interface UserInstallDeps {
  fetchText(url: string): Promise<string>;
  download(url: string, dest: string): Promise<void>;
  exec: Executor;
  /** The home the process would install into (`$HOME`). */
  home(): string;
  /** The runner account's home (password database). */
  accountHome(): string;
  uid(): number;
  platform: Platform;
  arch: string;
  /**
   * tool-pin-lib B1: the guarded tool folders and the ones that verified at the start of this run; a step naming a path
   * under a guarded folder that did not verify is refused. Absent: no guarded folders (tests of the installer alone).
   */
  guard?: {
    roots: readonly string[];
    before: readonly string[];
    /** gate-fixes-3: folders no step may name at all (`<tcRoot>/devops`: the DevOps tools, never written by a recipe). */
    exclude?: readonly string[];
  };
}

/**
 * tool-pin-lib B1 / review S3: the installer's executor: exactly this environment (nothing inherited), PATH = the bins of
 * the verified tool folders plus `/usr/bin:/bin`, HOME the account home (uv and rustup-init need it), LANG, then the
 * step's own variables (which cannot change PATH, HOME or LANG).
 */
export function installerExecutor(base: Executor, binDirs: readonly string[], home: string): Executor {
  return {
    run(cmd, args, opts = {}) {
      return base.run(cmd, args, {
        ...opts,
        exactEnv: true,
        env: {
          ...(opts.env ?? {}),
          HOME: home,
          LANG: 'C.UTF-8',
          PATH: [...binDirs, '/usr/bin', '/bin'].join(':'),
        },
      });
    },
  };
}

const isUnder = (p: string, dir: string): boolean => {
  const rel = relative(resolve(dir), resolve(p));
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * tool-pin-lib B1: may this step run? Every absolute path in `cmd`, `args` and the step's variables (also the value of
 * `--name=/path`) lies under
 * no guarded tool folder, or under one that verified. Returns null when allowed, else the reason.
 */
export function stepRefusal(
  step: Pick<UserStep, 'cmd' | 'args' | 'env'>,
  guard: UserInstallDeps['guard'],
): string | null {
  if (!guard) return null;
  // pre-review 3: the step's variables too (UV_TOOL_DIR, CARGO_HOME, ...)
  const paths = [step.cmd, ...step.args, ...Object.values(step.env ?? {})]
    .flatMap((a) => [a, ...(a.includes('=') ? [a.slice(a.indexOf('=') + 1)] : [])])
    .filter((a) => isAbsolute(a));
  for (const p of paths) {
    const hole = guard.exclude?.find((e) => isUnder(p, e));
    if (hole) return `refused: ${p} lies in ${hole}, the DevOps tools, which an install never names`;
    const root = guard.roots.find((r) => isUnder(p, r));
    if (root && !guard.before.some((b) => resolve(b) === resolve(root)))
      return `refused: ${p} lies in the tool folder ${root}, which changed outside Guildwise's own installs`;
  }
  return null;
}

export class UserInstallError extends Error {}

const httpsOnly = (url: string): void => {
  if (!url.startsWith('https://')) throw new UserInstallError(`refused: ${url} is not an https URL`);
};

async function defaultFetchText(url: string): Promise<string> {
  httpsOnly(url);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new UserInstallError(`${url}: HTTP ${r.status}`);
  return r.text();
}

async function defaultDownload(url: string, dest: string): Promise<void> {
  httpsOnly(url);
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok || !r.body) throw new UserInstallError(`${url}: HTTP ${r.status}`);
  await pipeline(Readable.fromWeb(r.body as WebReadableStream), createWriteStream(dest, { mode: 0o600 }));
}

export function defaultUserInstallDeps(): UserInstallDeps {
  return {
    fetchText: defaultFetchText,
    download: defaultDownload,
    exec: installerExecutor(realExecutor, [join(toolchainsRoot(), 'bin')], accountHome()),
    home: homedir,
    accountHome,
    uid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
    platform: process.platform as Platform,
    arch: process.arch,
  };
}

/**
 * The account check: never as root, and only when `$HOME` is the runner account's own home (a foreign HOME would put
 * tools into another user's folder). Returns the toolchains root.
 */
export function checkAccount(deps: Pick<UserInstallDeps, 'uid' | 'home' | 'accountHome'>): string {
  if (deps.uid() === 0)
    throw new UserInstallError('refused: Guildwise never installs stack tools as root (uid 0)');
  const passwd = resolve(deps.accountHome());
  const home = resolve(deps.home());
  if (home !== passwd)
    throw new UserInstallError(
      `refused: HOME (${home}) is not the runner account's home (${passwd}); tools go only into the runner's own home`,
    );
  return toolchainsRoot(passwd);
}

/** The hex checksum of a file. */
export async function fileDigest(file: string, algo: Checksum['algo']): Promise<string> {
  const h = createHash(algo);
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

/**
 * The checksum in a vendor checksum file: the line naming `fileName` (SHASUMS style, `<hex>  [*]<name>`), else the
 * first hex token (a `.sha256` beside the file).
 */
export function sumFromText(text: string, fileName?: string): string {
  const lines = text.split('\n').map((l) => l.trim());
  if (fileName)
    for (const l of lines) {
      const [hex, name] = l.split(/\s+/);
      if (hex && name && name.replace(/^\*/, '') === fileName && /^[0-9a-f]+$/i.test(hex))
        return hex.toLowerCase();
    }
  if (!fileName || lines.length === 1 || lines.filter(Boolean).length === 1) {
    const m = /\b([0-9a-f]{64}|[0-9a-f]{128})\b/i.exec(text);
    if (m?.[1]) return m[1].toLowerCase();
  }
  throw new UserInstallError(`no checksum for ${fileName ?? 'the download'} in the vendor's checksum file`);
}

const inside = (dir: string, p: string): boolean => {
  const rel = relative(dir, p);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
};

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * `<root>/bin/<name>` -> target. A link that is not there is made; a link that points into the root is replaced; a
 * file or a link pointing elsewhere is left alone (not ours).
 */
export function linkInto(root: string, name: string, target: string, log: (l: string) => void): boolean {
  if (name.includes('/') || name.startsWith('.')) throw new UserInstallError(`bad link name ${name}`);
  const bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true, mode: 0o755 });
  const link = join(bin, name);
  if (exists(link)) {
    const st = lstatSync(link);
    if (!st.isSymbolicLink()) {
      log(`  left ${link} alone: it is not a link made by Guildwise`);
      return false;
    }
    const cur = resolve(bin, readlinkSync(link));
    if (!inside(root, cur)) {
      log(`  left ${link} alone: it points outside the toolchains folder (${cur})`);
      return false;
    }
    unlinkSync(link);
  }
  symlinkSync(target, link);
  return true;
}

/** Adds `src`'s entries to `dest`: missing entries are moved, folders merged, files replaced. */
function mergeInto(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dest, name);
    const sDir = lstatSync(s).isDirectory();
    if (!exists(d)) renameSync(s, d);
    else if (sDir && lstatSync(d).isDirectory()) mergeInto(s, d);
    else {
      rmSync(d, { recursive: true, force: true });
      renameSync(s, d);
    }
  }
}

const tail = (s: string): string => s.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 400);

async function installArchive(
  a: Archive,
  root: string,
  home: string,
  deps: UserInstallDeps,
  log: (l: string) => void,
): Promise<void> {
  httpsOnly(a.url);
  if (!/^[\w.+-]+$/.test(a.tool) || !/^[\w.+-]+$/.test(a.version))
    throw new UserInstallError(`bad tool or version name: ${a.tool} ${a.version}`);
  const dest = a.into ? resolve(a.into.dir) : join(root, a.tool, a.version);
  if (!inside(home, dest))
    throw new UserInstallError(`refused: ${dest} is outside the runner's home (${home})`);
  // tool-pin-lib Decision 3: the user's own tool folders are read-only to Guildwise
  if (!inside(root, dest))
    throw new UserInstallError(
      `refused: ${dest} is outside the Guildwise tool folder (${root}); Guildwise installs nowhere else`,
    );
  const present = a.present ?? dest;
  if (existsSync(present)) {
    log(`  ${a.tool} ${a.version}: already installed`);
  } else {
    // tool-pin-lib S2: downloaded and unpacked next to the tool folder (same filesystem, so the rename stays atomic)
    const tmp = stageDir(root);
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const file = join(tmp, `${a.tool}-${a.version}-${basename(new URL(a.url).pathname)}`);
    rmSync(file, { force: true });
    log(`  downloading ${a.url}`);
    await deps.download(a.url, file);
    const got = await fileDigest(file, a.checksum.algo);
    if (got !== a.checksum.hex.toLowerCase()) {
      rmSync(file, { force: true });
      throw new UserInstallError(
        `checksum mismatch: refused (${a.url}: ${a.checksum.algo} ${got}, expected ${a.checksum.hex.toLowerCase()})`,
      );
    }
    log(`  ${a.checksum.algo} verified`);
    const partial = join(tmp, `${a.tool}-${a.version}.partial`);
    rmSync(partial, { recursive: true, force: true });
    mkdirSync(partial, { recursive: true, mode: 0o755 });
    try {
      if (a.format === 'file') {
        const name = a.fileName ?? basename(file);
        copyFileSync(file, join(partial, name));
        chmodSync(join(partial, name), 0o755);
      } else {
        const r =
          a.format === 'tar'
            ? await deps.exec.run('/usr/bin/tar', ['-xf', file, '-C', partial], { timeoutMs: 20 * 60_000 })
            : await deps.exec.run('/usr/bin/unzip', ['-q', '-o', file, '-d', partial], {
                timeoutMs: 20 * 60_000,
              });
        if (r.exitCode !== 0)
          throw new UserInstallError(`unpacking ${basename(file)} failed: ${tail(r.stderr || r.stdout)}`);
      }
      let content = partial;
      if (a.strip) {
        const entries = readdirSync(partial);
        const only = entries.length === 1 && entries[0] ? join(partial, entries[0]) : null;
        if (!only || !statSync(only).isDirectory())
          throw new UserInstallError(`${basename(file)} does not have a single top-level folder`);
        content = only;
      }
      if (a.into?.mode === 'merge') mergeInto(content, dest);
      else {
        mkdirSync(dirname(dest), { recursive: true });
        rmSync(dest, { recursive: true, force: true });
        renameSync(content, dest);
      }
    } finally {
      rmSync(partial, { recursive: true, force: true });
      rmSync(file, { force: true });
    }
    log(`  ${a.tool} ${a.version}: installed in ${dest}`);
  }
  for (const [name, rel] of Object.entries(a.bins ?? {})) {
    const target = join(dest, rel);
    if (!inside(dest, target)) throw new UserInstallError(`bad link target ${rel}`);
    linkInto(root, name, target, log);
  }
}

/** Runs a plan: every archive verified before it is unpacked, then the steps, then the extra links. */
export async function runUserInstall(
  plan: UserInstallPlan,
  deps: UserInstallDeps,
  log: (l: string) => void,
): Promise<void> {
  const root = checkAccount(deps);
  const home = resolve(deps.accountHome());
  mkdirSync(root, { recursive: true, mode: 0o755 });
  for (const a of plan.archives) await installArchive(a, root, home, deps, log);
  for (const s of plan.steps ?? []) {
    const refused = stepRefusal(s, deps.guard);
    if (refused) throw new UserInstallError(refused);
    log(`  $ ${s.cmd} ${s.args.join(' ')}`);
    const r = await deps.exec.run(s.cmd, s.args, {
      timeoutMs: 30 * 60_000,
      ...(s.env ? { env: s.env } : {}),
      ...(s.input !== undefined ? { input: s.input } : {}),
    });
    if (r.exitCode !== 0 && s.mayFail) {
      log(`  exit ${r.exitCode} (not needed)`);
      continue;
    }
    if (r.exitCode !== 0)
      throw new UserInstallError(
        `${basename(s.cmd)} failed: ${tail(r.stderr || r.stdout) || `exit ${r.exitCode}`}`,
      );
  }
  for (const [name, target] of Object.entries(plan.links ?? {})) {
    if (!inside(root, target)) throw new UserInstallError(`bad link target ${target}`);
    if (existsSync(target)) linkInto(root, name, target, log);
  }
}

export type UserInstallResult = { ok: true; detail: string } | { ok: false; detail: string };

/** What `env.ensure` uses: resolves and runs a tool's plan. */
export interface UserInstaller {
  /** `null`: no user-space install on this platform. */
  install(
    toolId: string,
    resolver: UserInstallResolver,
    params: Params,
    log: (l: string) => void,
  ): Promise<UserInstallResult | null>;
}

export function createUserInstaller(over: Partial<UserInstallDeps> = {}): UserInstaller {
  const deps: UserInstallDeps = { ...defaultUserInstallDeps(), ...over };
  return {
    async install(toolId, resolver, params, log) {
      try {
        const root = checkAccount(deps);
        const plan = await resolver({
          params,
          platform: deps.platform,
          arch: deps.arch,
          root,
          fetchText: deps.fetchText,
        });
        if (!plan) return null;
        log(`${toolId}: user-space install into ${root}`);
        await runUserInstall(plan, deps, log);
        return { ok: true, detail: `installed in ${root} (checksum verified)` };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        log(`  ${detail}`);
        return { ok: false, detail: detail.slice(0, 600) };
      }
    },
  };
}
