import { closeSync, existsSync, mkdirSync, openSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

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
