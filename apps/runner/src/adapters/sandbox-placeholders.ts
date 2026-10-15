import { closeSync, existsSync, lstatSync, mkdirSync, openSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
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
] as const;
export const SANDBOX_PROTECTED_DIRS = ['.vscode', '.idea'] as const;

/**
 * Names (at the worktree root) of the sandbox mount stubs: the protected files, which show up in `git status` as empty
 * untracked files. (The protected directories are empty, which git never lists.)
 */
export const SANDBOX_STUB_NAMES: readonly string[] = [...SANDBOX_PROTECTED_FILES];

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

/** `git status --porcelain` lines without the untracked entries for the given stubs. */
export function withoutSandboxStubs(lines: string[], stubs: readonly string[]): string[] {
  if (stubs.length === 0) return lines;
  const drop = new Set(stubs.map((n) => `?? ${n}`));
  return lines.filter((l) => !drop.has(l.trimEnd()));
}

/** Porcelain status lines of `cwd` (untracked files included) minus the sandbox stubs. */
export async function statusLinesWithoutStubs(cwd: string): Promise<{ ok: boolean; lines: string[] }> {
  const r = await git(cwd, ['status', '--porcelain', '--untracked-files=all']);
  if (r.exitCode !== 0) return { ok: false, lines: [] };
  const lines = r.stdout.split('\n').filter((l) => l.trim());
  return { ok: true, lines: withoutSandboxStubs(lines, await untrackedSandboxStubs(cwd)) };
}

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
  for (const n of SANDBOX_PROTECTED_DIRS) {
    try {
      rmdirSync(join(cwd, n)); // fails unless empty
      removed.push(n);
    } catch {}
  }
  return removed;
}

/** Creates the missing protected names in `cwd`; returns a function that removes exactly what it created. */
export function createSandboxPlaceholders(cwd: string): () => void {
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
  } catch {
    // best effort: a worktree that cannot be written to is as before
  }
  return () => {
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
