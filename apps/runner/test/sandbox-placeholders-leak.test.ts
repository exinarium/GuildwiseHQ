import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { removeSandboxStubs } from '../src/adapters/sandbox-placeholders.ts';
import { computeCardDiff } from '../src/git/card-diff.ts';
import { computeDiffStats } from '../src/git/diffstat.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { autoCommit, uncommittedFiles } from '../src/shifts/autocommit.ts';
import { discardOutOfScope, runGuard, snapshotBranches, snapshotDirty } from '../src/shifts/guard.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

/**
 * uat-runner-fixes-3 findings 3 and 4 (devbox, release 8e26f84e). Claude Code's sandbox mounts /dev/null over a set of
 * names in the worktree and, for a missing name, first creates it as an EMPTY FILE, `.idea` and `.vscode` included. Those
 * files tripped the architect's post-shift guard (architect_edited_non_docs, the design handoff refused 4 times), and the
 * WIP auto-commit f6179b8 committed `.idea` and `.vscode`; when the sandbox took them away again the next shift's
 * leftovers commit was refused as a tree revert.
 */

const role = (k: string) => {
  const r = BUILTIN_ROLES.find((x) => x.key === k);
  if (!r) throw new Error(k);
  return r;
};

/** What the devbox worktree showed: the scrub's placeholders, all empty files. */
const PLACEHOLDERS = ['.idea', '.vscode', '.bashrc', '.npmrc', '.mcp.json', '.github', 'scripts'];
const placeholders = (path: string) => {
  for (const n of PLACEHOLDERS) writeFileSync(join(path, n), '');
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
  const input = async () => ({
    worktree: path,
    roleKey,
    permissions: role(roleKey).permissions,
    branchName: 'aom/toy-1-x',
    startSha,
    branchesAtStart,
    dirtyAtStart: await snapshotDirty(path),
    e2eGlobs: ['e2e/**'],
    baseBranch: 'main',
  });
  return { path, startSha, input };
}

describe('finding 3: the placeholders are invisible to the post-shift guard and the dirty checks', () => {
  it('the architect hands over its design with the placeholders in the worktree (untracked)', async () => {
    const { path, input } = await setup('architect');
    const i = await input();
    placeholders(path);
    mkdirSync(join(path, 'docs'), { recursive: true });
    writeFileSync(join(path, 'docs', 'DESIGN.md'), '# Design\n');
    expect(await runGuard(i)).toEqual([]);
    expect(await uncommittedFiles(path)).toEqual(['?? docs/DESIGN.md']);
  });

  it('the architect committed them with `git add -A`: still no architect_edited_non_docs', async () => {
    const { path, input } = await setup('architect');
    const i = await input();
    placeholders(path);
    mkdirSync(join(path, 'docs'), { recursive: true });
    writeFileSync(join(path, 'docs', 'DESIGN.md'), '# Design\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'design']);
    expect(await runGuard(i)).toEqual([]);
    // and the out-of-scope discard leaves them alone (nothing to discard)
    expect((await discardOutOfScope(i)).discarded).toEqual([]);
  });

  it('a committed placeholder that the sandbox took away again is no edit and no dirt', async () => {
    const { path, input } = await setup('architect');
    writeFileSync(join(path, '.idea'), '');
    writeFileSync(join(path, '.vscode'), '');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'Work in progress']);
    const i = { ...(await input()), startSha: sh(path, 'git', ['rev-parse', 'HEAD']).trim() };
    rmSync(join(path, '.idea'));
    mkdirSync(join(path, '.vscode-tmp'));
    rmSync(join(path, '.vscode'));
    rmSync(join(path, '.vscode-tmp'), { recursive: true });
    expect(sh(path, 'git', ['status', '--porcelain'])).toMatch(/^ ?D \.idea/m);
    expect(await uncommittedFiles(path)).toEqual([]);
    expect(await runGuard(i)).toEqual([]);
  });

  it('real content under a placeholder name still counts', async () => {
    const { path, input } = await setup('architect');
    const i = await input();
    writeFileSync(join(path, '.idea'), '<project/>');
    const v = await runGuard(i);
    expect(v.map((x) => x.rule)).toEqual(['architect_edited_non_docs']);
    expect(v[0]?.detail).toContain('.idea');
  });
});

describe('finding 4: no runner-made commit carries a placeholder; a dropped one is no tree revert', () => {
  it('the WIP auto-commit leaves out .idea and .vscode (empty files) with the other placeholders', async () => {
    const { path } = await setup('builder');
    placeholders(path);
    writeFileSync(join(path, 'a.ts'), 'a');
    const r = await autoCommit({ worktree: path, env: {} });
    expect(r.committed).toBe(true);
    expect(sh(path, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('a.ts');
    await removeSandboxStubs(path);
    expect(sh(path, 'git', ['status', '--porcelain', '--untracked-files=all']).trim()).toBe('');
  });

  it('placeholders committed on the card branch (f6179b8) disappearing is not a tree revert', async () => {
    const { path } = await setup('builder');
    writeFileSync(join(path, 'a.ts'), 'a');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'work']);
    // the bad WIP commit of the old runner: only the placeholders
    writeFileSync(join(path, '.idea'), '');
    writeFileSync(join(path, '.vscode'), '');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'Work in progress']);
    const wip = sh(path, 'git', ['rev-parse', 'HEAD']).trim();
    rmSync(join(path, '.idea'));
    rmSync(join(path, '.vscode'));
    const r = await autoCommit({ worktree: path, env: {} });
    expect(r.refused).toBeUndefined();
    expect(r).toMatchObject({ committed: false, skipped: 'clean' });
    // with real work beside it: committed, never refused, and the commit is the work only
    writeFileSync(join(path, 'b.ts'), 'b');
    const r2 = await autoCommit({ worktree: path, env: {} });
    expect(r2.refused).toBeUndefined();
    expect(r2.committed).toBe(true);
    expect(sh(path, 'git', ['show', '--name-status', '--format=', 'HEAD']).trim()).toBe('A\tb.ts');
    expect(sh(path, 'git', ['rev-parse', 'HEAD~1']).trim()).toBe(wip);
  });

  it('the diff and the stats sent to the reviewers leave the committed placeholders out', async () => {
    const { path } = await setup('builder');
    placeholders(path);
    writeFileSync(join(path, 'a.ts'), 'a\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'work with placeholders']);
    const d = await computeCardDiff(path, 'main');
    expect(d.changedPaths).toEqual(['a.ts']);
    expect(d.diff.text).not.toContain('.idea');
    expect(d.diff.text).not.toContain('.bashrc');
    expect(d.diff.text).toContain('a.ts');
    const s = await computeDiffStats({ worktree: path, baseBranch: 'main', architecturalGlobs: [] });
    expect(s.files).toBe(1);
    // a real file under a placeholder name is shown
    writeFileSync(join(path, '.npmrc'), 'save-exact=true\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'npmrc']);
    expect((await computeCardDiff(path, 'main')).changedPaths.sort()).toEqual(['.npmrc', 'a.ts']);
  });
});
