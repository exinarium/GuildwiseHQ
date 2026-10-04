import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { autoCommit } from '../src/shifts/autocommit.ts';
import { discardOutOfScope, resetReadOnlyWorktree, runGuard, snapshotBranches } from '../src/shifts/guard.ts';
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
  return { repo, path, guard };
}

describe('guard', () => {
  it('a clean builder worktree passes, committed or not', async () => {
    const { path, guard } = await setup('builder');
    expect(await guard()).toEqual([]);
    writeFileSync(join(path, 'a.ts'), 'a');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'a']);
    writeFileSync(join(path, 'b.ts'), 'b');
    expect(await guard()).toEqual([]);
  });

  it('reviewer: uncommitted file, edited file or new commit is reviewer_modified_code', async () => {
    const a = await setup('reviewer');
    expect(await a.guard()).toEqual([]);
    writeFileSync(join(a.path, 'x.txt'), 'x');
    expect((await a.guard()).map((v) => v.rule)).toEqual(['reviewer_modified_code']);

    const b = await setup('reviewer');
    writeFileSync(join(b.path, 'README.md'), 'edited');
    expect((await b.guard())[0]?.rule).toBe('reviewer_modified_code');

    const c = await setup('reviewer');
    writeFileSync(join(c.path, 'x.txt'), 'x');
    sh(c.path, 'git', ['add', '-A']);
    sh(c.path, 'git', ['commit', '-m', 'sneaky']);
    expect((await c.guard())[0]?.rule).toBe('reviewer_modified_code');
  });

  it('tester: only e2e paths may change', async () => {
    const { path, guard } = await setup('tester');
    mkdirSync(join(path, 'e2e'), { recursive: true });
    writeFileSync(join(path, 'e2e', 'a.spec.ts'), 'ok');
    expect(await guard()).toEqual([]);
    writeFileSync(join(path, 'src.ts'), 'not e2e');
    const v = await guard();
    expect(v.map((x) => x.rule)).toEqual(['tester_edited_non_e2e']);
    expect(v[0]?.detail).toContain('src.ts');
  });

  it('any role: switching branches or committing on another branch is flagged', async () => {
    const { repo, path, guard } = await setup('builder');
    sh(path, 'git', ['checkout', '-b', 'rogue']);
    expect((await guard()).map((v) => v.rule)).toContain('wrong_branch');
    sh(path, 'git', ['checkout', 'aom/toy-1-x']);
    expect((await guard()).map((v) => v.rule)).toEqual(['commits_on_other_branch']); // the new branch itself
    sh(path, 'git', ['branch', '-D', 'rogue']);
    expect(await guard()).toEqual([]);
    // commit on main in the main clone while the shift runs
    writeFileSync(join(repo.clone, 'm.txt'), 'm');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'on main']);
    expect((await guard()).map((v) => v.rule)).toContain('commits_on_other_branch');
  });
});

describe('guard with concurrent shifts', () => {
  it("commits on another card's linked worktree branch are not a violation", async () => {
    const { repo, guard } = await setup('builder');
    const otherPath = join(tmp(), 'wt-other');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        remoteUrlNormalized: 'x',
        baseBranch: 'main',
        branchName: 'aom/toy-2-y',
      },
      defaultPath: otherPath,
    });
    writeFileSync(join(otherPath, 'o.txt'), 'o');
    sh(otherPath, 'git', ['add', '-A']);
    sh(otherPath, 'git', ['commit', '-m', 'other card']);
    expect(await guard()).toEqual([]);
  });
});

describe('autocommit', () => {
  it('commits leftovers with the agent identity and a conventional message; no-op when clean', async () => {
    const { path } = await setup('builder');
    const env = {
      GIT_AUTHOR_NAME: 'Ada (aom)',
      GIT_AUTHOR_EMAIL: 'a@agents.aom.invalid',
      GIT_COMMITTER_NAME: 'Ada (aom)',
      GIT_COMMITTER_EMAIL: 'a@agents.aom.invalid',
    };
    const input = {
      worktree: path,
      ref: 'TOY-1',
      stage: 'build',
      shiftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      env,
    };
    expect(await autoCommit(input)).toBe(false);
    writeFileSync(join(path, 'left.txt'), 'l');
    expect(await autoCommit(input)).toBe(true);
    expect(sh(path, 'git', ['log', '-1', '--format=%s|%an'])).toBe(
      'aom: TOY-1 build leftovers (shift 019e3f6a)|Ada (aom)',
    );
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
  });
});

describe('writable globs are enforced for every role (review M3)', () => {
  it('a custom role with writableGlobs may only change matching paths', async () => {
    const { path, repo } = await setup('builder');
    const startSha = sh(path, 'git', ['rev-parse', 'HEAD']);
    const input = (globs: string[] | null) => ({
      worktree: path,
      roleKey: 'release-notes',
      permissions: { mayCommit: true, writableGlobs: globs },
      branchName: 'aom/toy-1-x',
      startSha,
      branchesAtStart: {},
      e2eGlobs: [],
    });
    mkdirSync(join(path, 'notes'), { recursive: true });
    writeFileSync(join(path, 'notes', 'a.md'), 'ok');
    expect((await runGuard(input(['notes/**']))).map((v) => v.rule)).not.toContain(
      'edited_outside_writable_globs',
    );
    writeFileSync(join(path, 'src.ts'), 'nope');
    const v = await runGuard(input(['notes/**']));
    expect(v.map((x) => x.rule)).toContain('edited_outside_writable_globs');
    expect(v.find((x) => x.rule === 'edited_outside_writable_globs')?.detail).toContain('src.ts');
    // null means the whole worktree; an empty list means nothing
    expect((await runGuard(input(null))).map((x) => x.rule)).not.toContain('edited_outside_writable_globs');
    expect((await runGuard(input([]))).map((x) => x.rule)).toContain('edited_outside_writable_globs');
    // and the runner throws the out-of-scope edit away instead of committing it
    const dropped = await discardOutOfScope(input(['notes/**']));
    expect(dropped).toEqual(['src.ts']);
    expect(repo.clone).toBeTruthy();
  });
});

describe('read-only roles are rolled back (review M4)', () => {
  it('reset --hard to the start sha and clean, also after a commit or a stray branch', async () => {
    const { path } = await setup('reviewer');
    const startSha = sh(path, 'git', ['rev-parse', 'HEAD']);
    const input = { worktree: path, branchName: 'aom/toy-1-x', startSha };
    expect(await resetReadOnlyWorktree(input)).toBe(false);

    writeFileSync(join(path, 'x.txt'), 'untracked');
    writeFileSync(join(path, 'README.md'), 'edited');
    mkdirSync(join(path, 'newdir'));
    writeFileSync(join(path, 'newdir', 'n.txt'), 'n');
    sh(path, 'git', ['checkout', '-b', 'rogue']);
    writeFileSync(join(path, 'c.txt'), 'c');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'sneaky']);
    writeFileSync(join(path, 'again.txt'), 'dirty');

    expect(await resetReadOnlyWorktree(input)).toBe(true);
    expect(sh(path, 'git', ['rev-parse', 'HEAD'])).toBe(startSha);
    expect(sh(path, 'git', ['branch', '--show-current'])).toBe('aom/toy-1-x');
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(path, 'newdir'))).toBe(false);
    expect(existsSync(join(path, 'x.txt'))).toBe(false);
  });
});
