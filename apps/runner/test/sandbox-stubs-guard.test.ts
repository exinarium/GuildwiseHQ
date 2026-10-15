import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { removeSandboxStubs } from '../src/adapters/sandbox-placeholders.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { autoCommit, uncommittedFiles } from '../src/shifts/autocommit.ts';
import { resetReadOnlyWorktree, runGuard, snapshotBranches } from '../src/shifts/guard.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();
const role = (k: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === k);
  if (!r) throw new Error(k);
  return r;
};

async function setup(roleKey: string) {
  const repo = makeRepo();
  const path = join(tmp(), 'wt');
  const w = await ensureWorktree({
    repoPath: repo.clone,
    roots: ['/'],
    spec: {
      mode: 'create',
      repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      remoteUrlNormalized: 'x',
      baseBranch: 'main',
      branchName: 'aom/toy-1-x',
    },
    defaultPath: path,
  });
  const startSha = w.headSha;
  const branchesAtStart = await snapshotBranches(path);
  const guard = () =>
    runGuard({
      worktree: path,
      roleKey,
      permissions: role(roleKey).permissions,
      branchName: 'aom/toy-1-x',
      startSha,
      branchesAtStart,
      e2eGlobs: ['e2e/**'],
    });
  return { path, startSha, guard };
}

const names = ['.bash_profile', '.gitmodules', '.profile', '.ripgreprc', '.zprofile', '.zshrc'];
const stubs = (path: string) => {
  for (const n of names) writeFileSync(join(path, n), '');
  mkdirSync(join(path, '.vscode'));
};

describe('sandbox dotfile stubs (hotfix #77)', () => {
  it('a read-only role with empty untracked stubs passes the guard', async () => {
    for (const r of ['reviewer', 'scout']) {
      const { path, guard } = await setup(r);
      stubs(path);
      expect(await guard(), r).toEqual([]);
      expect(await uncommittedFiles(path)).toEqual([]);
    }
  });

  it('a real .gitmodules content, or an edit of a tracked stub name, still counts', async () => {
    const a = await setup('reviewer');
    writeFileSync(join(a.path, '.gitmodules'), '[submodule "x"]\n');
    writeFileSync(join(a.path, '.zshrc'), '');
    const v = await a.guard();
    expect(v.map((x) => x.rule)).toEqual(['reviewer_modified_code']);
    expect(v[0]?.detail).toContain('.gitmodules');
    expect(v[0]?.detail).not.toContain('.zshrc');

    const b = await setup('reviewer');
    writeFileSync(join(b.path, '.profile'), '');
    sh(b.path, 'git', ['add', '-f', '.profile']);
    sh(b.path, 'git', ['commit', '-m', 'p']);
    writeFileSync(join(b.path, '.profile'), 'x');
    const vb = await b.guard();
    expect(vb.length).toBeGreaterThan(0);
    expect(vb[0]?.detail).toContain('.profile');
  });

  it('builder autocommit never commits the stubs, and a stub-only worktree makes no commit', async () => {
    const { path } = await setup('builder');
    stubs(path);
    expect(await autoCommit({ worktree: path, env: {} })).toBe(false);
    writeFileSync(join(path, 'a.ts'), 'a');
    expect(await autoCommit({ worktree: path, env: {} })).toBe(true);
    const files = sh(path, 'git', ['show', '--name-only', '--format=', 'HEAD']);
    expect(files.trim()).toBe('a.ts');
  });

  it('a builder that really adds content to .gitmodules has it committed', async () => {
    const { path } = await setup('builder');
    writeFileSync(join(path, '.gitmodules'), '[submodule "x"]\n');
    expect(await autoCommit({ worktree: path, env: {} })).toBe(true);
    expect(sh(path, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('.gitmodules');
  });

  it('a read-only worktree with only stubs is not rolled back', async () => {
    const { path, startSha } = await setup('reviewer');
    stubs(path);
    expect(await resetReadOnlyWorktree({ worktree: path, branchName: 'aom/toy-1-x', startSha })).toBe(false);
  });

  it('removeSandboxStubs removes empty untracked stubs only', async () => {
    const { path } = await setup('builder');
    stubs(path);
    writeFileSync(join(path, '.bashrc'), 'echo hi');
    writeFileSync(join(path, '.gitconfig'), '');
    sh(path, 'git', ['add', '-f', '.gitconfig']);
    sh(path, 'git', ['commit', '-m', 'c']);
    await removeSandboxStubs(path);
    for (const n of names) expect(existsSync(join(path, n)), n).toBe(false);
    expect(existsSync(join(path, '.vscode'))).toBe(false);
    expect(existsSync(join(path, '.bashrc'))).toBe(true);
    expect(existsSync(join(path, '.gitconfig'))).toBe(true);
  });
});
