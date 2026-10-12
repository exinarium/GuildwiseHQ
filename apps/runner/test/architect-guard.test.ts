import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  architectFetch,
  architectMergeMain,
  architectPush,
  architectVerifyMerge,
} from '../src/git/architect-git.ts';
import { mergeMainIntoCard } from '../src/git/sync-main.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { autoCommit } from '../src/shifts/autocommit.ts';
import { discardOutOfScope, runGuard, snapshotBranches } from '../src/shifts/guard.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const architect = BUILTIN_ROLES.find((r) => r.key === 'architect');
if (!architect) throw new Error('architect role missing');
const architectPerms = architect.permissions;
const BRANCH = 'aom/toy-1-x';

async function setup() {
  const repo = makeRepo();
  const other = join(tmp(), 'other');
  sh(repo.root, 'git', ['clone', repo.origin, other]);
  sh(other, 'git', ['checkout', 'main']);
  const mainPush = (file: string, text: string, message = 'main moves') => {
    sh(other, 'git', ['fetch', 'origin']);
    sh(other, 'git', ['reset', '--hard', 'origin/main']);
    mkdirSync(join(other, file, '..'), { recursive: true });
    writeFileSync(join(other, file), text);
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', message]);
    sh(other, 'git', ['push', 'origin', 'main']);
  };
  const path = join(tmp(), 'wt');
  const w = await ensureWorktree({
    repoPath: repo.clone,
    roots: ['/'],
    spec: {
      mode: 'create',
      repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'main',
      branchName: BRANCH,
    },
    defaultPath: path,
  });
  const startSha = w.headSha;
  const branchesAtStart = await snapshotBranches(path);
  const mainShas: string[] = [];
  const guard = (extra: string[] = []) =>
    runGuard({
      worktree: path,
      roleKey: 'architect',
      permissions: architectPerms,
      branchName: BRANCH,
      startSha,
      branchesAtStart,
      e2eGlobs: [],
      ...(extra.length ? { extraWritableGlobs: extra } : {}),
      ...(mainShas.length ? { mainMergeShas: mainShas } : {}),
    });
  const ctx = {
    worktree: path,
    branchName: BRANCH,
    mainBranch: 'main',
    ref: 'TOY-1',
    recordMainSha: (sha: string) => void mainShas.push(sha),
    startMainSha: () => mainShas.at(-1),
  };
  const commit = (message = 'work') => {
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', message]);
  };
  return { repo, other, mainPush, path, guard, ctx, mainShas, commit, startSha };
}

const rules = async (g: Promise<{ rule: string }[]>) => (await g).map((v) => v.rule);

describe('architect post-shift guard', () => {
  it('the architect may write documentation and the investigation folder, nothing else', async () => {
    const t = await setup();
    expect(await t.guard()).toEqual([]);
    mkdirSync(join(t.path, 'docs', 'investigations'), { recursive: true });
    writeFileSync(join(t.path, 'docs', 'investigations', 'TOY-1-x.md'), '# report\n');
    writeFileSync(join(t.path, 'NOTES.md'), 'notes\n');
    t.commit();
    expect(await t.guard()).toEqual([]);
    writeFileSync(join(t.path, 'src.ts'), 'export const x = 1;\n');
    expect(await rules(t.guard())).toEqual(['architect_edited_non_docs']);
  });

  it('writes outside the documentation globs are refused, committed or not; the project folder is added by the runner', async () => {
    const t = await setup();
    mkdirSync(join(t.path, 'design'), { recursive: true });
    writeFileSync(join(t.path, 'design', 'TOY-1.txt'), 'a report in a folder the project named\n');
    t.commit();
    expect(await rules(t.guard())).toEqual(['architect_edited_non_docs']);
    expect(await t.guard(['design/**'])).toEqual([]);
    // editing a test file or an existing source file is product code
    writeFileSync(join(t.path, 'test', 'existing.test.ts'), '// edited\n');
    expect(await rules(t.guard(['design/**']))).toEqual(['architect_edited_non_docs']);
  });

  it('out-of-scope edits are discarded instead of auto-committed', async () => {
    const t = await setup();
    writeFileSync(join(t.path, 'code.ts'), 'x\n');
    writeFileSync(join(t.path, 'ok.md'), 'ok\n');
    const dropped = await discardOutOfScope({
      worktree: t.path,
      roleKey: 'architect',
      permissions: architectPerms,
      branchName: BRANCH,
      startSha: t.startSha,
      branchesAtStart: {},
      e2eGlobs: [],
    });
    expect(dropped).toEqual(['code.ts']);
    const who = { name: 'a', email: 'a@x.test' };
    await autoCommit({
      worktree: t.path,
      ref: 'TOY-1',
      stage: 'investigate',
      shiftId: 'abcdefgh-1',
      env: {
        ['GIT_AUTHOR_NAME']: who.name,
        ['GIT_AUTHOR_EMAIL']: who.email,
        ['GIT_COMMITTER_NAME']: who.name,
        ['GIT_COMMITTER_EMAIL']: who.email,
      },
    });
    expect(sh(t.path, 'git', ['show', '--stat', '--format=', 'HEAD'])).toContain('ok.md');
    expect(sh(t.path, 'git', ['show', '--stat', '--format=', 'HEAD'])).not.toContain('code.ts');
  });

  it('what a merge of the recorded main commit brought in is exempt; nothing else is', async () => {
    const t = await setup();
    t.mainPush('src/from-main.ts', 'export const fromMain = 1;\n');
    const r = await architectMergeMain(t.ctx);
    expect(r.ok).toBe(true);
    expect(t.mainShas).toHaveLength(1);
    // the main merge changed src/from-main.ts, but the architect did not: no violation
    expect(await t.guard()).toEqual([]);
    // the same merge with no recorded main commit is the architect's own change to product code
    const g = await runGuard({
      worktree: t.path,
      roleKey: 'architect',
      permissions: architectPerms,
      branchName: BRANCH,
      startSha: t.startSha,
      branchesAtStart: {},
      e2eGlobs: [],
    });
    expect(g.map((v) => v.rule)).toContain('architect_edited_non_docs');
    // a recorded SHA that is not the merge's second parent exempts nothing
    t.mainShas.length = 0;
    t.mainShas.push('0'.repeat(40));
    expect(await rules(t.guard())).toContain('architect_edited_non_docs');
  });

  it('an edit to a main file after the merge, committed or not, is not exempt', async () => {
    const t = await setup();
    t.mainPush('src/from-main.ts', 'export const fromMain = 1;\n');
    await architectMergeMain(t.ctx);
    expect(await t.guard()).toEqual([]);
    writeFileSync(join(t.path, 'src', 'from-main.ts'), 'export const fromMain = 2; // architect edit\n');
    expect(await rules(t.guard())).toEqual(['architect_edited_non_docs']); // uncommitted
    t.commit('sneaky');
    expect(await rules(t.guard())).toEqual(['architect_edited_non_docs']); // committed after the merge
  });

  it('a conflict resolution is exempt once committed as the merge; an unfinished merge is refused', async () => {
    const t = await setup();
    // diverge: the card branch and main both change README.md
    writeFileSync(join(t.path, 'README.md'), 'card side\n');
    t.commit('card edits readme');
    t.mainPush('README.md', 'main side\n');
    const startedAt = sh(t.path, 'git', ['rev-parse', 'HEAD']);
    const merged = await architectMergeMain(t.ctx);
    expect(merged.ok).toBe(true);
    expect(merged.ok && merged.message).toContain('README.md');
    // the merge is unfinished: the guard says so, and verify-merge agrees
    expect((await t.guard()).map((v) => v.rule)).toContain('merge_unresolved');
    const early = await architectVerifyMerge(t.ctx);
    expect(early.ok).toBe(false);
    // resolve (a documentation file here, so the global scope is not the point) and finish the merge
    writeFileSync(join(t.path, 'README.md'), 'both sides\n');
    sh(t.path, 'git', ['add', 'README.md']);
    sh(t.path, 'git', ['commit', '--no-edit']);
    expect((await architectVerifyMerge(t.ctx)).ok).toBe(true);
    expect(await t.guard()).toEqual([]);
    expect(sh(t.path, 'git', ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3);
    expect(startedAt).not.toBe(sh(t.path, 'git', ['rev-parse', 'HEAD']));
  });

  it('verify-merge refuses leftover conflict markers and a missing merge commit', async () => {
    const t = await setup();
    expect((await architectVerifyMerge(t.ctx)).ok).toBe(false); // HEAD is not a merge commit
    writeFileSync(join(t.path, 'README.md'), 'card side\n');
    t.commit('card');
    t.mainPush('README.md', 'main side\n');
    await architectMergeMain(t.ctx);
    writeFileSync(join(t.path, 'README.md'), '<<<<<<< HEAD\ncard\n=======\nmain\n>>>>>>> origin/main\n');
    sh(t.path, 'git', ['add', 'README.md']);
    sh(t.path, 'git', ['commit', '--no-edit']);
    const v = await architectVerifyMerge(t.ctx);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error).toContain('conflict markers');
  });
});

describe('architect git (run by the runner)', () => {
  it('pushes the card branch and nothing else', async () => {
    const t = await setup();
    writeFileSync(join(t.path, 'NOTES.md'), 'n\n');
    t.commit();
    for (const ref of ['main', 'refs/heads/main', 'origin/main', 'aom/other-card', 'HEAD:main', '--force'])
      expect(await architectPush(t.ctx, ref)).toMatchObject({ ok: false });
    expect(sh(t.repo.origin, 'git', ['branch', '--list', BRANCH])).toBe('');
    const ok = await architectPush(t.ctx);
    expect(ok).toMatchObject({ ok: true });
    expect(sh(t.repo.origin, 'git', ['rev-parse', BRANCH])).toBe(sh(t.path, 'git', ['rev-parse', 'HEAD']));
    // naming the card branch explicitly is the same thing
    expect(await architectPush(t.ctx, BRANCH)).toMatchObject({ ok: true });
    // main on origin never moved
    expect(sh(t.repo.origin, 'git', ['log', '--format=%s', 'main'])).toBe('initial');
  });

  it('refuses to push uncommitted work or an unfinished merge', async () => {
    const t = await setup();
    writeFileSync(join(t.path, 'README.md'), 'edited\n');
    expect(await architectPush(t.ctx)).toMatchObject({ ok: false });
  });

  it('fetches origin so origin/<main> can be compared', async () => {
    const t = await setup();
    t.mainPush('late.txt', 'late\n');
    expect(sh(t.path, 'git', ['log', '--format=%s', 'origin/main'])).toBe('initial');
    expect((await architectFetch(t.ctx)).ok).toBe(true);
    expect(sh(t.path, 'git', ['log', '-1', '--format=%s', 'origin/main'])).toBe('main moves');
  });

  it('merge-main merges the latest main, records its SHA, and reports "up to date" the second time', async () => {
    const t = await setup();
    t.mainPush('docs/from-main.md', 'x\n');
    const first = await architectMergeMain(t.ctx);
    expect(first.ok && first.message).toContain('Merged the latest main');
    expect(t.mainShas[0]).toBe(sh(t.repo.origin, 'git', ['rev-parse', 'main']));
    const second = await architectMergeMain(t.ctx);
    expect(second.ok && second.message).toContain('already contains');
  });

  it('merge-main will not run over uncommitted edits', async () => {
    const t = await setup();
    t.mainPush('docs/from-main.md', 'x\n');
    writeFileSync(join(t.path, 'README.md'), 'dirty\n');
    expect(await architectMergeMain(t.ctx)).toMatchObject({ ok: false });
  });
});

describe('merge into the card (shared helper)', () => {
  it('reports up to date when main is already contained', async () => {
    const t = await setup();
    expect(await mergeMainIntoCard(t.path, { mainBranch: 'main', ref: 'TOY-1' })).toMatchObject({
      result: 'up_to_date',
    });
  });
});
