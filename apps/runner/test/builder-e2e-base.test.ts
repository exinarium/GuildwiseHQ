import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { runGuard, snapshotBranches } from '../src/shifts/guard.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();
const builder = BUILTIN_ROLES.find((r) => r.key === 'builder')!;
const E2E = ['e2e/**'];

/** main has e2e/a.spec.ts; the card branch's earlier work (tester) changed it and the builder shift starts from there. */
async function setup() {
  const repo = makeRepo();
  mkdirSync(join(repo.clone, 'e2e'), { recursive: true });
  writeFileSync(join(repo.clone, 'e2e', 'a.spec.ts'), 'base\n');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'add e2e']);
  sh(repo.clone, 'git', ['push', 'origin', 'main']);
  const path = join(tmp(), 'wt');
  await ensureWorktree({
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
  const write = (rel: string, content: string, commit = false) => {
    mkdirSync(join(path, rel, '..'), { recursive: true });
    writeFileSync(join(path, rel), content);
    if (commit) {
      sh(path, 'git', ['add', '-A']);
      sh(path, 'git', ['commit', '-m', `edit ${rel}`]);
    }
  };
  write('e2e/a.spec.ts', 'tester change\n', true);
  const startSha = String(sh(path, 'git', ['rev-parse', 'HEAD'])).trim();
  const branchesAtStart = await snapshotBranches(path);
  const guard = (baseBranch: string | undefined = 'main') =>
    runGuard({
      worktree: path,
      roleKey: 'builder',
      permissions: builder.permissions,
      branchName: 'aom/toy-1-x',
      startSha,
      branchesAtStart,
      e2eGlobs: E2E,
      ...(baseBranch ? { baseBranch } : {}),
    });
  return { path, write, guard, startSha, branchesAtStart };
}

describe('builder_edited_e2e is judged against the branch base', () => {
  it('reverting an e2e file the branch had already changed to its base content passes (uncommitted or committed)', async () => {
    const t = await setup();
    t.write('e2e/a.spec.ts', 'base\n');
    expect(await t.guard()).toEqual([]);
    t.write('e2e/a.spec.ts', 'base\n', true);
    expect(await t.guard()).toEqual([]);
  });

  it('a net change relative to base is still flagged', async () => {
    const t = await setup();
    t.write('e2e/a.spec.ts', 'builder edit\n');
    expect((await t.guard()).map((v) => v.rule)).toEqual(['builder_edited_e2e']);
    t.write('e2e/new.spec.ts', 'new\n');
    expect((await t.guard())[0]?.detail).toContain('e2e/new.spec.ts');
  });

  it('without a base branch every changed e2e path counts (previous behaviour)', async () => {
    const t = await setup();
    t.write('e2e/a.spec.ts', 'base\n');
    expect((await t.guard('')).map((v) => v.rule)).toEqual(['builder_edited_e2e']);
  });

  it('deleting an e2e file that exists on base is flagged', async () => {
    const t = await setup();
    sh(t.path, 'git', ['rm', '-q', 'e2e/a.spec.ts']);
    expect((await t.guard()).map((v) => v.rule)).toEqual(['builder_edited_e2e']);
  });
});

describe('builder_edited_e2e counts only real test content (BLOCKERS.md section 2)', () => {
  it('editing e2e/README.md, e2e/package.json or e2e/video/screens.json passes; editing a spec fails as before', async () => {
    const t = await setup();
    t.write('e2e/README.md', '# how to run\n', true);
    t.write('e2e/package.json', '{"name":"e2e"}\n', true);
    t.write('e2e/video/screens.json', '{"screens":[]}\n');
    expect(await t.guard()).toEqual([]);
    t.write('e2e/a.spec.ts', 'builder edit\n');
    const v = await t.guard();
    expect(v.map((x) => x.rule)).toEqual(['builder_edited_e2e']);
    expect(v[0]?.detail).toContain('e2e/a.spec.ts');
    expect(v[0]?.detail).not.toContain('README');
  });

  it('a base merge that brings E2E changes, then the guard, passes', async () => {
    const t = await setup();
    // main moves on: another card's tester added and changed specs
    const repo = String(
      sh(t.path, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']),
    ).trim();
    const clone = join(repo, '..');
    mkdirSync(join(clone, 'e2e'), { recursive: true });
    writeFileSync(join(clone, 'e2e', 'b.spec.ts'), 'from main\n');
    sh(clone, 'git', ['add', '-A']);
    sh(clone, 'git', ['commit', '-m', 'another card: e2e b']);
    sh(clone, 'git', ['push', 'origin', 'main']);
    const tip = String(sh(t.path, 'git', ['rev-parse', 'origin/main'])).trim();
    sh(t.path, 'git', ['merge', '--no-edit', 'origin/main']);
    t.write('src/feature.ts', 'export const x = 1;\n', true);
    const guard = await runGuard({
      worktree: t.path,
      roleKey: 'builder',
      permissions: builder.permissions,
      branchName: 'aom/toy-1-x',
      startSha: t.startSha,
      branchesAtStart: t.branchesAtStart,
      e2eGlobs: E2E,
      baseBranch: 'main',
      baseTipShas: [tip],
    });
    expect(guard).toEqual([]);
  });
});
