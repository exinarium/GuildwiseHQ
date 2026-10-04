import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { runGuard, snapshotBranches } from '../src/shifts/guard.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();
const role = (k: string) => BUILTIN_ROLES.find((r) => r.key === k)!;
const E2E = ['e2e/**', 'tests/e2e/**', 'playwright/**'];

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
  const branchesAtStart = await snapshotBranches(path);
  const guard = () =>
    runGuard({
      worktree: path,
      roleKey,
      permissions: role(roleKey).permissions,
      branchName: 'aom/toy-1-x',
      startSha: w.headSha,
      branchesAtStart,
      e2eGlobs: E2E,
    });
  const write = (rel: string, content = 'x', commit = false) => {
    mkdirSync(join(path, rel, '..'), { recursive: true });
    writeFileSync(join(path, rel), content);
    if (commit) {
      sh(path, 'git', ['add', '-A']);
      sh(path, 'git', ['commit', '-m', `edit ${rel}`]);
    }
  };
  return { path, guard, write };
}

describe('tester guard: E2E globs only', () => {
  it('E2E files, committed or not, are fine', async () => {
    const t = await setup('tester');
    t.write('e2e/login.spec.ts', 'test', true);
    t.write('tests/e2e/other.spec.ts');
    t.write('playwright/config.ts');
    expect(await t.guard()).toEqual([]);
  });

  it('an edit outside the E2E globs is tester_edited_non_e2e, committed or not', async () => {
    const dirty = await setup('tester');
    dirty.write('e2e/ok.spec.ts');
    dirty.write('src/app.ts');
    const v = await dirty.guard();
    expect(v.map((x) => x.rule)).toEqual(['tester_edited_non_e2e']);
    expect(v[0]?.detail).toContain('src/app.ts');
    expect(v[0]?.detail).not.toContain('e2e/ok.spec.ts');

    const committed = await setup('tester');
    committed.write('src/app.ts', 'x', true);
    expect((await committed.guard()).map((x) => x.rule)).toEqual(['tester_edited_non_e2e']);
  });

  it('unit tests are not E2E: a tester changing one is rejected', async () => {
    const t = await setup('tester');
    t.write('test/existing.test.ts', '// changed\n');
    expect((await t.guard()).map((x) => x.rule)).toContain('tester_edited_non_e2e');
  });

  it('with no E2E globs configured every change is a violation', async () => {
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
    writeFileSync(join(path, 'e2e.txt'), 'x');
    const v = await runGuard({
      worktree: path,
      roleKey: 'tester',
      permissions: role('tester').permissions,
      branchName: 'aom/toy-1-x',
      startSha: w.headSha,
      branchesAtStart: await snapshotBranches(path),
      e2eGlobs: [],
    });
    expect(v.map((x) => x.rule)).toEqual(['tester_edited_non_e2e']);
  });
});

describe('builder and writer ownership rules', () => {
  it('a builder touching E2E paths is rejected (builders do no E2E testing)', async () => {
    const t = await setup('builder');
    t.write('src/feature.ts');
    t.write('test/feature.test.ts');
    expect(await t.guard()).toEqual([]);
    t.write('e2e/feature.spec.ts');
    const v = await t.guard();
    expect(v.map((x) => x.rule)).toEqual(['builder_edited_e2e']);
  });

  it('a writer may only change documentation', async () => {
    const t = await setup('writer');
    t.write('docs/guide.md');
    t.write('README.md');
    expect(await t.guard()).toEqual([]);
    t.write('src/code.ts');
    const v = await t.guard();
    expect(v.map((x) => x.rule)).toEqual(['writer_edited_non_docs']);
  });
});
