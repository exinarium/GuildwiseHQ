import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { redactSecrets } from '../redact.ts';
import { git } from './git.ts';
import { withRepoLock } from './repo-lock.ts';
import { readSubmodules } from './submodule-pin.ts';
import type { GitAuth } from './worktrees.ts';

/** Finds the registered local clone of a repository by its normalized url. */
export type FindRepo = (remoteUrlNormalized: string) => Promise<{ localPath: string } | undefined>;

export interface SubmoduleFillDeps {
  findRepo: FindRepo;
  /** Credentials per host (absent: the user's own git setup). */
  auth?: GitAuth;
}

export interface SubmoduleSource {
  /**
   * `-c` pairs for this one command: `submodule.<name>.active=true`, `submodule.<name>.url=<url>`, and
   * `protocol.file.allow=always` only for a registered local clone. Plus the host-scoped auth args.
   */
  args: string[];
  env: Record<string, string>;
  via: 'mirror' | 'remote';
}

export interface SubmoduleFill {
  path: string;
  name: string;
  status: 'filled' | 'present' | 'failed' | 'skipped';
  /** The pinned commit (when known). */
  pinned?: string;
  /** The url of the submodule as resolved from `.gitmodules` (used for nested fills). */
  url?: string;
  /** Redacted (no url userinfo, no secret shapes), at most 300 characters. */
  detail?: string;
}

export interface FillOptions {
  /** Card worktrees: leave alone every submodule whose repository already exists or whose folder holds anything. */
  onlyUninitialised?: boolean;
  /** Stop at the first failed or skipped submodule (a deploy cannot use a half-filled checkout). */
  stopOnFirstError?: boolean;
  /** `GIT_LFS_SKIP_SMUDGE=1`: no LFS download driven by the checked-out content. */
  skipLfsSmudge?: boolean;
  timeoutMs?: number;
}

const SHA_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const NAME_RE = /^[A-Za-z0-9._/-]+$/;

/** Git's error text for a log or a report: url userinfo (git repeats it in "clone of '...' failed") and secrets removed. */
export const redactGitError = (s: string): string =>
  redactSecrets(s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@'))
    .trim()
    .slice(0, 300);

/** The url without any `user:pass@` part (kept in results that may be logged). */
const withoutUserinfo = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/i, '$1');

/** A name that is safe in a `-c submodule.<name>.<key>=` setting. */
export function isSafeSubmoduleName(name: string): boolean {
  return NAME_RE.test(name) && !name.includes('..');
}

/** A path inside the worktree: relative, no `..` segment, no leading `-`. */
export function isSafeSubmodulePath(path: string): boolean {
  if (!path || isAbsolute(path) || path.startsWith('-') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]/).some((seg) => seg === '..');
}

const hasCommit = async (dir: string, commit: string): Promise<boolean> =>
  (await git(dir, ['cat-file', '-e', `${commit}^{commit}`])).exitCode === 0;

/**
 * The ONE place a submodule url is chosen (card worktrees, run worktrees, deploy checkouts): the registered local clone of
 * the submodule's repository (a pin it lacks is fetched into it first, under that clone's lock, with its origin's auth),
 * else the submodule's own url with the credentials of ITS host. The file protocol is allowed only for the local clone.
 */
export async function resolveSubmoduleSource(
  sub: { name: string; url: string; normalized: string },
  pinned: string,
  deps: SubmoduleFillDeps,
): Promise<SubmoduleSource> {
  const active = ['-c', `submodule.${sub.name}.active=true`];
  const local = await deps.findRepo(sub.normalized).catch(() => undefined);
  if (local && isAbsolute(local.localPath)) {
    const mirror = local.localPath;
    const ready = await withRepoLock(mirror, async () => {
      if (await hasCommit(mirror, pinned)) return true;
      const origin = (await git(mirror, ['remote', 'get-url', 'origin'])).stdout.trim();
      const a = deps.auth && origin ? await deps.auth(origin) : { args: [], env: {} };
      await git(mirror, [...a.args, 'fetch', 'origin'], { env: a.env, timeoutMs: 300_000 });
      if (await hasCommit(mirror, pinned)) return true;
      await git(mirror, [...a.args, 'fetch', 'origin', pinned], { env: a.env, timeoutMs: 300_000 });
      return hasCommit(mirror, pinned);
    }).catch(() => false);
    if (ready)
      return {
        args: ['-c', 'protocol.file.allow=always', ...active, '-c', `submodule.${sub.name}.url=${mirror}`],
        env: {},
        via: 'mirror',
      };
  }
  const a = deps.auth ? await deps.auth(sub.url) : { args: [], env: {} };
  return {
    args: [...a.args, ...active, '-c', `submodule.${sub.name}.url=${sub.url}`],
    env: a.env,
    via: 'remote',
  };
}

/** The gitlinks of the worktree's index (mode 160000, stage 0): path -> pinned commit. */
async function gitlinks(worktree: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const r = await git(worktree, ['ls-files', '-s', '-z']);
  if (r.exitCode !== 0) return out;
  for (const entry of r.stdout.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [mode, sha, stage] = entry.slice(0, tab).split(' ');
    if (mode === '160000' && sha && stage === '0') out.set(entry.slice(tab + 1), sha);
  }
  return out;
}

/** An existing path of any kind (a dangling symbolic link counts). */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** The folder is absent, or a plain, empty directory. */
function emptyOrAbsent(p: string): boolean {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch {
    return true;
  }
  if (!st.isDirectory() || st.isSymbolicLink()) return false;
  return readdirSync(p).length === 0;
}

async function gitPath(worktree: string, rel: string): Promise<string | null> {
  const r = await git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', rel]);
  const p = r.stdout.trim();
  return r.exitCode === 0 && p ? p : null;
}

/**
 * Fills each submodule of the worktree's `.gitmodules` at the commit its index pins, without writing any git
 * configuration: activation and url are one-shot `-c` options of `git submodule update` (no `--init`, no `--recursive`),
 * through the hardened `git()`. Never throws. Without `.gitmodules` it is one existence check.
 */
export async function fillSubmodules(
  worktree: string,
  deps: SubmoduleFillDeps,
  opts: FillOptions = {},
): Promise<SubmoduleFill[]> {
  if (!existsSync(join(worktree, '.gitmodules'))) return [];
  const out: SubmoduleFill[] = [];
  try {
    const origin = (await git(worktree, ['remote', 'get-url', 'origin'])).stdout.trim();
    const subs = await readSubmodules(worktree, origin);
    const pins = await gitlinks(worktree);
    for (const s of subs) {
      const fill = await fillOne(worktree, s, pins.get(s.path), deps, opts);
      out.push(fill);
      if (opts.stopOnFirstError && (fill.status === 'failed' || fill.status === 'skipped')) break;
    }
  } catch (err) {
    out.push({
      name: '',
      path: '',
      status: 'failed',
      detail: redactGitError(err instanceof Error ? err.message : String(err)),
    });
  }
  return out;
}

async function fillOne(
  worktree: string,
  s: { name: string; path: string; url: string; normalized: string },
  pinned: string | undefined,
  deps: SubmoduleFillDeps,
  opts: FillOptions,
): Promise<SubmoduleFill> {
  const base = { name: s.name, path: s.path, url: withoutUserinfo(s.url) };
  if (!isSafeSubmoduleName(s.name)) return { ...base, status: 'skipped', detail: 'unsafe submodule name' };
  if (!isSafeSubmodulePath(s.path)) return { ...base, status: 'skipped', detail: 'unsafe submodule path' };
  if (!pinned || !SHA_RE.test(pinned)) return { ...base, status: 'skipped', detail: 'no pinned commit' };
  const withPin = { ...base, pinned };
  if (opts.onlyUninitialised) {
    const root = await gitPath(worktree, 'modules');
    if (!root) return { ...withPin, status: 'skipped', detail: 'the git directory could not be read' };
    try {
      if (lstatSync(root).isSymbolicLink())
        return { ...withPin, status: 'skipped', detail: 'the modules folder is a symbolic link' };
    } catch {
      // not created yet
    }
    const repo = await gitPath(worktree, `modules/${s.name}`);
    if (!repo) return { ...withPin, status: 'skipped', detail: 'the git directory could not be read' };
    // An existing submodule repository (or anything in the folder) is left as it is: no git runs inside it.
    if (lexists(repo) || !emptyOrAbsent(join(worktree, s.path))) return { ...withPin, status: 'present' };
  }
  const src = await resolveSubmoduleSource(s, pinned, deps);
  const env = { ...src.env, ...(opts.skipLfsSmudge ? { GIT_LFS_SKIP_SMUDGE: '1' } : {}) };
  const r = await git(worktree, [...src.args, 'submodule', 'update', '--', s.path], {
    env,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });
  if (r.exitCode !== 0)
    return {
      ...withPin,
      status: 'failed',
      detail: redactGitError(r.stderr || r.stdout || `exit code ${r.exitCode}`),
    };
  const head = (await git(join(worktree, s.path), ['rev-parse', 'HEAD'])).stdout.trim();
  if (head !== pinned)
    return {
      ...withPin,
      status: 'failed',
      detail: `is at ${head.slice(0, 10) || 'no commit'}, not the pinned ${pinned.slice(0, 10)}`,
    };
  return { ...withPin, status: 'filled' };
}
