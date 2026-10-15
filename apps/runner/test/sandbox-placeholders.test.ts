import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSandboxPlaceholders,
  SANDBOX_PROTECTED_DIRS,
  SANDBOX_PROTECTED_FILES,
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
});
