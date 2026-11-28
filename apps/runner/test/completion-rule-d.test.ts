import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FinalizeExecutePayload } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeCompletion } from '../src/git/completion.ts';
import type { PrCreator, PrInput } from '../src/git/gh.ts';
import { setGitAfterHook } from '../src/git/git.ts';
import { recordTip, setTipStore, TipStore, tipStore, writerStart } from '../src/git/pushable-tips.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

/**
 * gate-fixes-2 P1b (Rule D, B3): a card is finalized only at the runner's latest record of its branch (its own shift's
 * end or a runner move), merged and sent by sha. Another card's session that moves the branch sends it back to Build.
 */
cleanupTmp();

const U = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
let saved: TipStore | null;
beforeEach(() => {
  saved = tipStore();
  setTipStore(TipStore.forRoot(mkdtempSync(join(tmp(), 'tips-'))));
});
afterEach(() => {
  setGitAfterHook(null);
  setTipStore(saved);
});

/** Card `branch` in its own worktree with one commit, recorded at its builder shift's end. */
async function card(repo: TestRepo, branch: string, ref: string, file: string) {
  const path = join(tmp(), `wt-${ref}`);
  await ensureWorktree({
    repoPath: repo.clone,
    roots: ['/'],
    spec: {
      mode: 'create',
      repoId: U,
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'main',
      branchName: branch,
    },
    defaultPath: path,
  });
  const release = await writerStart(path); // the builder shift
  writeFileSync(join(path, file), `${file}\n`);
  sh(path, 'git', ['add', '-A']);
  sh(path, 'git', ['commit', '-m', `add ${file}`]);
  await release();
  const tip = sh(path, 'git', ['rev-parse', 'HEAD']);
  await recordTip(path, `refs/heads/${branch}`, tip, 'shift-end');
  return { path, tip, branch, ref };
}

const payload = (
  repo: TestRepo,
  c: { path: string; branch: string; ref: string },
  action: FinalizeExecutePayload['action'],
  over: Partial<FinalizeExecutePayload> = {},
): FinalizeExecutePayload => ({
  cardId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
  ref: c.ref,
  title: `Card ${c.ref}`,
  projectKey: 'TOY',
  action,
  repoId: U,
  remoteUrlNormalized: repo.remoteNormalized,
  baseBranch: 'main',
  branchName: c.branch,
  worktreePath: c.path,
  ...over,
});

class FakePr implements PrCreator {
  calls: PrInput[] = [];
  async create(input: PrInput) {
    this.calls.push(input);
    return { url: 'https://example.test/pr/1' };
  }
}
const run = (repo: TestRepo, p: FinalizeExecutePayload, pr: PrCreator = new FakePr()) =>
  executeCompletion({
    payload: p,
    repoPath: repo.clone,
    worktreePath: p.worktreePath as string,
    worktreesDir: '/',
    integrationDir: join(tmp(), 'integration'),
    pr,
  });
const originHeads = (repo: TestRepo) =>
  sh(repo.origin, 'git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);

/** Card A's session (a writer) moves card B's branch onto a commit of its own. */
async function aForgesB(a: { path: string }, b: { path: string; branch: string; tip: string }) {
  const release = await writerStart(a.path);
  const forged = sh(a.path, 'git', ['commit-tree', `${b.tip}^{tree}`, '-p', b.tip, '-m', 'slipped into B']);
  sh(a.path, 'git', ['update-ref', `refs/heads/${b.branch}`, forged]);
  sh(b.path, 'git', ['reset', '-q', '--hard', b.branch]);
  await release();
  return forged;
}

describe('Rule D: a card branch another session moved is never finalized', () => {
  for (const action of ['merge', 'pr'] as const)
    for (const expected of [false, true])
      it(`${action}, ${expected ? 'with' : 'without'} expectedSha: headMoved, nothing merged or sent`, async () => {
        const repo = makeRepo();
        const a = await card(repo, 'aom/toy-1-a', 'TOY-1', 'a.txt');
        const b = await card(repo, 'aom/toy-2-b', 'TOY-2', 'b.txt');
        const forged = await aForgesB(a, b);
        const before = originHeads(repo);
        // with expectedSha: the server reviewed what is there now (the forged tip); Rule D still refuses
        const res = await run(repo, payload(repo, b, action, expected ? { expectedSha: forged } : {}));
        expect(res).toMatchObject({ ok: false, headMoved: true, headSha: forged });
        expect(res.error).toMatch(/changed outside this card's shifts/);
        expect(originHeads(repo)).toBe(before);
      });

  it('a branch this runner never recorded asks for a new shift here', async () => {
    const repo = makeRepo();
    const a = await card(repo, 'aom/toy-1-a', 'TOY-1', 'a.txt');
    // a branch made after the clone was known, without any shift of this runner
    const path = join(tmp(), 'wt-elsewhere');
    sh(repo.clone, 'git', ['worktree', 'add', '-q', '-b', 'aom/toy-3-c', path]);
    writeFileSync(join(path, 'c.txt'), 'c\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-qm', 'c']);
    const res = await run(repo, payload(repo, { path, branch: 'aom/toy-3-c', ref: 'TOY-3' }, 'merge'));
    expect(res).toMatchObject({ ok: false, headMoved: true });
    expect(res.error).toMatch(/no record of the card branch \(its last shift ran elsewhere\)/);
    expect(a.tip).toBeTruthy();
  });

  it('a matching tip lands: merged by sha and sent', async () => {
    const repo = makeRepo();
    const b = await card(repo, 'aom/toy-2-b', 'TOY-2', 'b.txt');
    const res = await run(repo, payload(repo, b, 'merge', { expectedSha: b.tip }));
    expect(res).toMatchObject({ ok: true, action: 'merge' });
    expect(sh(repo.origin, 'git', ['rev-parse', 'main'])).toBe(res.mergeCommit);
    expect(sh(repo.origin, 'git', ['merge-base', '--is-ancestor', b.tip, 'main'])).toBe('');
  });

  it('B3 (S8 seam): the branch moved right after the runner’s rebase never lands', async () => {
    const repo = makeRepo();
    const b = await card(repo, 'aom/toy-2-b', 'TOY-2', 'b.txt');
    // origin moved (an outside commit), so the finalize rebases
    const other = join(tmp(), 'outside');
    sh(repo.root, 'git', ['clone', '-q', repo.origin, other]);
    writeFileSync(join(other, 'o.txt'), 'o\n');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-qm', 'outside']);
    sh(other, 'git', ['push', '-q', 'origin', 'main']);
    const outsideTip = sh(other, 'git', ['rev-parse', 'HEAD']);
    let fired = false;
    setGitAfterHook(async (args, cwd) => {
      if (fired || args[0] !== 'rebase' || cwd !== b.path) return;
      fired = true;
      // a session's write lands between the rebase and the compare-and-swap
      const sneak = sh(b.path, 'git', ['commit-tree', `${b.tip}^{tree}`, '-p', b.tip, '-m', 'sneaked']);
      sh(b.path, 'git', ['update-ref', `refs/heads/${b.branch}`, sneak]);
    });
    const res = await run(repo, payload(repo, b, 'merge'));
    expect(fired).toBe(true);
    expect(res.ok).toBe(false);
    expect(sh(repo.origin, 'git', ['rev-parse', 'main'])).toBe(outsideTip);
  });
});

describe('Rework 2 (B3): the integration worktree is detached', () => {
  it('S8 seam: an integration branch a session writes after `worktree add` and after `merge` changes nothing sent', async () => {
    const repo = makeRepo();
    const b = await card(repo, 'aom/toy-2-b', 'TOY-2', 'b.txt');
    const base = sh(repo.origin, 'git', ['rev-parse', 'main']);
    const forged = sh(repo.clone, 'git', [
      'commit-tree',
      `${base}^{tree}`,
      '-p',
      base,
      '-m',
      'forged integration',
    ]);
    const fired: string[] = [];
    setGitAfterHook(async (args) => {
      if (args[0] === 'worktree' && args[1] === 'add' && !fired.includes('add')) fired.push('add');
      else if (args[0] === 'merge' && args.includes('--no-ff') && !fired.includes('merge'))
        fired.push('merge');
      else return;
      // the name the integration branch had, and any ref a session can reach
      sh(repo.clone, 'git', ['update-ref', 'refs/heads/guildwise/integration/toy-2', forged]);
    });
    const res = await run(repo, payload(repo, b, 'merge'));
    expect(fired).toEqual(['add', 'merge']);
    expect(res).toMatchObject({ ok: true, action: 'merge' });
    const main = sh(repo.origin, 'git', ['rev-parse', 'main']);
    expect(main).toBe(res.mergeCommit);
    expect(sh(repo.origin, 'git', ['rev-list', '--parents', '-n1', main]).split(' ').slice(1)).toEqual([
      base,
      b.tip,
    ]);
    expect(sh(repo.origin, 'git', ['rev-list', main])).not.toContain(forged);
  });
});

describe('outside commits are taken (the owner’s question)', () => {
  it('a card finalizes on top of an outside push to origin: rebased onto it, merged, sent', async () => {
    const repo = makeRepo();
    const b = await card(repo, 'aom/toy-2-b', 'TOY-2', 'b.txt');
    const other = join(tmp(), 'outside');
    sh(repo.root, 'git', ['clone', '-q', repo.origin, other]);
    writeFileSync(join(other, 'outside.txt'), 'outside\n');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-qm', 'outside']);
    sh(other, 'git', ['push', '-q', 'origin', 'main']);
    const outsideTip = sh(other, 'git', ['rev-parse', 'HEAD']);
    const res = await run(repo, payload(repo, b, 'merge'));
    expect(res).toMatchObject({ ok: true, action: 'merge' });
    const main = sh(repo.origin, 'git', ['rev-parse', 'main']);
    expect(sh(repo.origin, 'git', ['merge-base', '--is-ancestor', outsideTip, main])).toBe('');
    expect(sh(repo.origin, 'git', ['show', `${main}:b.txt`])).toBe('b.txt');
    expect(sh(repo.origin, 'git', ['show', `${main}:outside.txt`])).toBe('outside');
  });

  it('an outside commit that conflicts with the card: the card goes back with a conflict, never headMoved', async () => {
    const repo = makeRepo();
    const b = await card(repo, 'aom/toy-2-b', 'TOY-2', 'README.md');
    const other = join(tmp(), 'outside-c');
    sh(repo.root, 'git', ['clone', '-q', repo.origin, other]);
    writeFileSync(join(other, 'README.md'), '# theirs\n');
    sh(other, 'git', ['commit', '-qam', 'theirs']);
    sh(other, 'git', ['push', '-q', 'origin', 'main']);
    const res = await run(repo, payload(repo, b, 'merge'));
    expect(res).toMatchObject({ ok: false, conflict: true, conflictedFiles: ['README.md'] });
    expect(res.headMoved).toBeUndefined();
    expect(sh(b.path, 'git', ['branch', '--show-current'])).toBe(b.branch);
  });
});
