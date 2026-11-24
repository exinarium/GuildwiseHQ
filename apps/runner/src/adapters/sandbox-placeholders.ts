import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { git } from '../git/git.ts';

/**
 * Claude Code's sandbox protects a handful of dotfiles in the working directory (`.gitconfig`, `.bashrc`, `.vscode`,
 * ...) by mounting /dev/null (or an empty directory) over each of them. A name that does not exist yet is created as the
 * mount point first. When the working directory is read-only (a reviewer's worktree: the sandbox binds it read-only),
 * that creation fails and EVERY Bash command of the shift dies with
 * `bwrap: Can't create file <worktree>/.gitconfig: Read-only file system` (Claude Code 2.1.296 and later; 2.1.295 and
 * before did not mount missing names). An existing name is simply bound over, so the runner creates the missing names
 * (empty) before a read-only shift and removes the ones it made when the shift ends.
 *
 * Verified against Claude Code 2.1.300 with `apps/runner/test/claude-sandbox-real.test.ts` (real binary, real bwrap).
 */
export const SANDBOX_PROTECTED_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  // with CLAUDE_CODE_SUBPROCESS_ENV_SCRUB (on by default since 1.10.0) Claude Code 2.1.330 protects these too
  '.github',
  '.mcp.json',
  'scripts',
  '.npmrc',
  '.yarnrc',
  '.yarnrc.yml',
  'bunfig.toml',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.env',
  '.env.local',
  '.env.development',
  '.env.development.local',
  '.env.production',
  '.env.production.local',
  '.env.test',
  '.env.test.local',
] as const;
export const SANDBOX_PROTECTED_DIRS = ['.vscode', '.idea'] as const;
/**
 * With the scrub, Claude Code also mounts over these inside a `.git` DIRECTORY (a standalone repository, such as a PR
 * review checkout; a linked worktree's `.git` is a file and needs none). The runner denies writes to `.git`, so in a
 * read-only shift the mount points must already exist. Only made for read-only shifts: a stale `config.lock` would stop
 * `git config` writes, which a read-only shift never makes.
 */
/**
 * The empty folders Claude Code's scrub start-up makes in the working directory (2.1.330), deepest first: removed at
 * shift end while they are empty (`rmdir` fails on anything with content, so a real `node_modules` or `.claude` stays).
 */
export const SCRUB_STUB_DIRS = [
  join('node_modules', '.bin'),
  'node_modules',
  join('.claude', 'commands'),
  join('.claude', 'agents'),
  '.claude',
] as const;
export const SANDBOX_PROTECTED_GIT_FILES = ['config.lock', 'config.worktree.lock'] as const;

/**
 * Names (at the worktree root) of the sandbox mount stubs: the protected files, which show up in `git status` as empty
 * untracked files, and the protected directories. Claude Code's own bwrap makes a missing `.vscode` or `.idea` as an
 * EMPTY FILE (the /dev/null mount point), not a directory, so `git status` lists those too (uat-runner-fixes-3 finding 3:
 * they tripped architect_edited_non_docs; finding 4: the WIP auto-commit committed them).
 */
export const SANDBOX_STUB_NAMES: readonly string[] = [...SANDBOX_PROTECTED_FILES, ...SANDBOX_PROTECTED_DIRS];

/** The blob id of an empty file: what a committed placeholder holds. */
export const EMPTY_BLOB = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391';

/** A path at the worktree root with a sandbox stub name. */
export const isSandboxStubName = (path: string): boolean => SANDBOX_STUB_NAMES.includes(path);

/**
 * Which shifts work in which worktree right now (the supervisor registers each one). The stubs are shared by every
 * shift in a worktree: one shift ending must not take them from another that is still running in it (they were
 * removed at every shift end, which broke the next Bash call of the other shift).
 */
const worktreeUsers = new Map<string, Set<string>>();

/** When a shift last held or released each worktree (ms), for `usedSince`. */
const worktreeLastUse = new Map<string, number>();

/** Registers `shiftId` as working in `cwd`; returns the release. */
export function holdWorktree(cwd: string, shiftId: string): () => void {
  const key = resolve(cwd);
  const set = worktreeUsers.get(key) ?? new Set<string>();
  set.add(shiftId);
  worktreeUsers.set(key, set);
  worktreeLastUse.set(key, Date.now());
  return () => {
    const s = worktreeUsers.get(key);
    s?.delete(shiftId);
    if (s && s.size === 0) worktreeUsers.delete(key);
    worktreeLastUse.set(key, Date.now());
  };
}

let runnerOps = 0;
/**
 * Runs `fn` with `cwd` registered as in use by the runner's own git work (a finalize or run-start rebase, a worktree being
 * made, an @mention turn): the DevOps card-worktree fence never takes that work for the DevOps engineer's (REVIEW B1).
 */
export async function withWorktreeHeld<T>(cwd: string, what: string, fn: () => Promise<T>): Promise<T> {
  const release = holdWorktree(cwd, `runner:${what}:${++runnerOps}`);
  try {
    return await fn();
  } finally {
    release();
  }
}

/** Did any shift work in `cwd` at some point since `sinceMs` (or does one now)? */
export function usedSince(cwd: string, sinceMs: number): boolean {
  const key = resolve(cwd);
  return (worktreeUsers.get(key)?.size ?? 0) > 0 || (worktreeLastUse.get(key) ?? -1) >= sinceMs;
}

/** Does a shift other than `shiftId` work in `cwd`? */
export function otherShiftsUse(cwd: string, shiftId: string): boolean {
  const s = worktreeUsers.get(resolve(cwd));
  return !!s && [...s].some((id) => id !== shiftId);
}

const isDir = (p: string): boolean => {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isEmptyFile = (p: string): boolean => {
  try {
    const st = lstatSync(p);
    return st.isFile() && st.size === 0;
  } catch {
    return false;
  }
};

/** The stub names present in `cwd` as empty files that git does not track: exactly what the sandbox leaves behind. */
export async function untrackedSandboxStubs(cwd: string): Promise<string[]> {
  const out: string[] = [];
  for (const n of SANDBOX_STUB_NAMES) {
    if (!isEmptyFile(join(cwd, n))) continue;
    // a tracked file (even an empty one) is the project's own
    if ((await git(cwd, ['ls-files', '--error-unmatch', '--', n])).exitCode === 0) continue;
    out.push(n);
  }
  return out;
}

/**
 * Placeholders that a commit already put on the branch (an empty file with a stub name tracked at `rev`, like the WIP
 * commit f6179b8 did with `.idea` and `.vscode`). When the sandbox takes one away again, its deletion is not work either.
 */
export async function trackedSandboxStubs(cwd: string, rev = 'HEAD'): Promise<string[]> {
  const r = await git(cwd, ['ls-tree', '-z', rev, '--', ...SANDBOX_STUB_NAMES]);
  if (r.exitCode !== 0) return [];
  const out: string[] = [];
  for (const entry of r.stdout.split('\0')) {
    // <mode> SP <type> SP <object> TAB <path>
    const m = /^100\d{3} blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
    if (m && m[1] === EMPTY_BLOB && isSandboxStubName(m[2] as string)) out.push(m[2] as string);
  }
  return out;
}

/** Every sandbox stub `git status` may show in `cwd`: untracked empty stubs, and committed empty placeholders. */
export async function sandboxStubNoise(cwd: string): Promise<string[]> {
  return [...new Set([...(await untrackedSandboxStubs(cwd)), ...(await trackedSandboxStubs(cwd))])];
}

/**
 * `git status --porcelain` lines without the entries for the given stubs: an untracked stub (`??`), and a committed
 * empty placeholder that is gone or was replaced by an empty folder (`D` in the index or the worktree column).
 */
export function withoutSandboxStubs(lines: string[], stubs: readonly string[]): string[] {
  if (stubs.length === 0) return lines;
  const names = new Set(stubs);
  return lines.filter((l) => {
    const t = l.trimEnd();
    if (t.length < 4 || !names.has(t.slice(3))) return true;
    const xy = t.slice(0, 2);
    return !(xy === '??' || xy === ' D' || xy === 'D ');
  });
}

/** Porcelain status lines of `cwd` (untracked files included) minus the sandbox stubs. */
export async function statusLinesWithoutStubs(
  cwd: string,
  opts: { untracked?: boolean } = {},
): Promise<{ ok: boolean; lines: string[] }> {
  const r = await git(cwd, [
    'status',
    '--porcelain',
    opts.untracked === false ? '--untracked-files=no' : '--untracked-files=all',
  ]);
  if (r.exitCode !== 0) return { ok: false, lines: [] };
  const lines = r.stdout.split('\n').filter((l) => l.trim());
  return { ok: true, lines: withoutSandboxStubs(lines, await sandboxStubNoise(cwd)) };
}

/**
 * Of `paths` changed between `a` and `b`, the sandbox placeholders: a stub name that is an empty file or absent on
 * both sides (a placeholder committed, or a committed placeholder deleted). They are never work.
 */
export async function placeholderPathsBetween(
  cwd: string,
  a: string,
  b: string,
  paths: Iterable<string>,
): Promise<Set<string>> {
  const out = new Set<string>();
  const candidates = [...paths].filter(isSandboxStubName);
  if (candidates.length === 0) return out;
  const blobs = async (rev: string): Promise<Map<string, string>> => {
    const m = new Map<string, string>();
    const r = await git(cwd, ['ls-tree', '-z', rev, '--', ...candidates]);
    for (const e of r.stdout.split('\0')) {
      const x = /^\d+ (\w+) ([0-9a-f]{40,64})\t(.+)$/.exec(e);
      if (x) m.set(x[3] as string, x[1] === 'blob' ? (x[2] as string) : `tree:${x[2]}`);
    }
    return m;
  };
  const [ba, bb] = [await blobs(a), await blobs(b)];
  const emptyOrAbsent = (m: Map<string, string>, p: string) => !m.has(p) || m.get(p) === EMPTY_BLOB;
  for (const p of candidates) if (emptyOrAbsent(ba, p) && emptyOrAbsent(bb, p)) out.add(p);
  return out;
}

/** `:(exclude,top)` pathspecs for the given placeholders (none: an empty list). */
export const excludeStubs = (stubs: Iterable<string>): string[] =>
  [...stubs].map((n) => `:(exclude,top,literal)${n}`);

/**
 * Removes the sandbox stubs in `cwd`, whoever made them (our placeholders or Claude Code's own bwrap): empty untracked
 * files and empty directories with the protected names. Tracked and non-empty entries are never touched.
 */
export async function removeSandboxStubs(cwd: string): Promise<string[]> {
  const removed: string[] = [];
  for (const n of await untrackedSandboxStubs(cwd)) {
    try {
      unlinkSync(join(cwd, n));
      removed.push(n);
    } catch {}
  }
  for (const n of [...SANDBOX_PROTECTED_DIRS, ...SCRUB_STUB_DIRS]) {
    try {
      rmdirSync(join(cwd, n)); // fails unless empty
      removed.push(n);
    } catch {}
  }
  await restoreTrackedSandboxStubs(cwd).catch(() => []);
  return removed;
}

/**
 * Puts back the committed empty placeholders that went missing (deleted, or replaced by an empty folder): exactly the
 * empty file the branch already holds, so `git rebase` does not stop on an unstaged deletion (REVIEW S2). Real content is
 * never touched: only names whose committed blob is empty and that are absent or an empty folder now.
 */
export async function restoreTrackedSandboxStubs(cwd: string): Promise<string[]> {
  const restored: string[] = [];
  for (const n of await trackedSandboxStubs(cwd)) {
    const p = join(cwd, n);
    try {
      if (isDir(p)) rmdirSync(p); // fails unless empty
    } catch {
      continue;
    }
    if (existsSync(p)) continue;
    if ((await git(cwd, ['checkout', 'HEAD', '--', n])).exitCode === 0) restored.push(n);
  }
  return restored;
}

/** Creates the missing protected names in `cwd`; returns a function that removes exactly what it created. */
export function createSandboxPlaceholders(cwd: string, shiftId?: string): () => void {
  const files: string[] = [];
  const dirs: string[] = [];
  try {
    for (const n of SANDBOX_PROTECTED_FILES) {
      const p = join(cwd, n);
      if (existsSync(p)) continue;
      closeSync(openSync(p, 'wx', 0o444));
      files.push(p);
    }
    for (const n of SANDBOX_PROTECTED_DIRS) {
      const p = join(cwd, n);
      if (existsSync(p)) continue;
      mkdirSync(p);
      dirs.push(p);
    }
    const gitDir = join(cwd, '.git');
    if (isDir(gitDir))
      for (const n of SANDBOX_PROTECTED_GIT_FILES) {
        const p = join(gitDir, n);
        if (existsSync(p)) continue;
        closeSync(openSync(p, 'wx', 0o444));
        files.push(p);
      }
  } catch {
    // best effort: a worktree that cannot be written to is as before
  }
  return () => {
    // another shift of this worktree still runs: it may be using these as mount points; the last one to end cleans up
    if (shiftId && otherShiftsUse(cwd, shiftId)) return;
    for (const p of files) {
      try {
        if (statSync(p).size === 0) unlinkSync(p);
      } catch {}
    }
    for (const p of dirs) {
      try {
        rmdirSync(p);
      } catch {}
    }
  };
}
