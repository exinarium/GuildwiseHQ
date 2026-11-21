import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSandboxPlaceholders,
  SANDBOX_PROTECTED_DIRS,
  SANDBOX_PROTECTED_FILES,
  SANDBOX_PROTECTED_GIT_FILES,
} from '../src/adapters/sandbox-placeholders.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

describe('sandbox placeholders for a read-only worktree (hotfix #72)', () => {
  it('creates the missing protected names, keeps existing ones, and removes only what it made', () => {
    const cwd = tmp();
    writeFileSync(join(cwd, '.gitmodules'), '[submodule "a"]\n');
    mkdirSync(join(cwd, '.vscode'));
    const drop = createSandboxPlaceholders(cwd);
    for (const n of [...SANDBOX_PROTECTED_FILES, ...SANDBOX_PROTECTED_DIRS])
      expect(existsSync(join(cwd, n))).toBe(true);
    drop();
    for (const n of SANDBOX_PROTECTED_FILES.filter((x) => x !== '.gitmodules'))
      expect(existsSync(join(cwd, n)), n).toBe(false);
    expect(existsSync(join(cwd, '.idea'))).toBe(false);
    // what was there before stays
    expect(readFileSync(join(cwd, '.gitmodules'), 'utf8')).toContain('submodule');
    expect(existsSync(join(cwd, '.vscode'))).toBe(true);
  });

  it('does not remove a placeholder the shift filled with content', () => {
    const cwd = tmp();
    const drop = createSandboxPlaceholders(cwd);
    drop();
    expect(existsSync(join(cwd, '.bashrc'))).toBe(false);
    const again = createSandboxPlaceholders(cwd);
    chmodSync(join(cwd, '.bashrc'), 0o644);
    writeFileSync(join(cwd, '.bashrc'), 'echo hi');
    again();
    expect(existsSync(join(cwd, '.bashrc'))).toBe(true);
  });

  it('with the scrub (1.10.0 default): makes its extra mount points, and the .git locks only in a standalone repository', () => {
    const cwd = tmp();
    mkdirSync(join(cwd, '.git'));
    const drop = createSandboxPlaceholders(cwd);
    for (const n of ['scripts', '.github', '.mcp.json', 'package.json', '.env', 'pnpm-lock.yaml'])
      expect(existsSync(join(cwd, n)), n).toBe(true);
    for (const n of SANDBOX_PROTECTED_GIT_FILES) expect(existsSync(join(cwd, '.git', n)), n).toBe(true);
    drop();
    for (const n of [
      'scripts',
      'package.json',
      '.env',
      join('.git', 'config.lock'),
      join('.git', 'config.worktree.lock'),
    ])
      expect(existsSync(join(cwd, n)), n).toBe(false);
    // a linked worktree: `.git` is a file, nothing is made beside or inside it
    const linked = tmp();
    writeFileSync(join(linked, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    const drop2 = createSandboxPlaceholders(linked);
    expect(readFileSync(join(linked, '.git'), 'utf8')).toContain('gitdir:');
    drop2();
  });
});
