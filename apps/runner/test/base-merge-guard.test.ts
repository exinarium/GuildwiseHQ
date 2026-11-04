import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILTIN_ROLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { autoCommit } from '../src/shifts/autocommit.ts';
import {
  discardOutOfScope,
  fetchedRemoteTip,
  type GuardInput,
  runGuard,
  snapshotBranches,
  uncommittedOutOfScope,
} from '../src/shifts/guard.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const architect = BUILTIN_ROLES.find((r) => r.key === 'architect');
if (!architect) throw new Error('architect role missing');
const architectPerms = architect.permissions;
const BRANCH = 'aom/toy-1-x';
const REL = 'release/x';

const write = (dir: string, file: string, text: string) => {
  mkdirSync(join(dir, file, '..'), { recursive: true });
  writeFileSync(join(dir, file), text);
};

/** A repo whose card branch is cut from release/x; release/x then moves on origin and is fetched into the card clone. */
async function setup(opts: { fetched?: boolean } = {}) {
  const repo = makeRepo();
  const other = join(tmp(), 'other');
  sh(repo.root, 'git', ['clone', repo.origin, other]);
  sh(other, 'git', ['checkout', '-b', REL, 'origin/main']);
  write(other, 'src/existing.ts', 'export const a = 1;\n');
  write(other, 'rel/old.ts', 'old\n');
  write(other, 'src/other.ts', 'other\n');
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-m', 'release start']);
  sh(other, 'git', ['push', 'origin', REL]);
  const path = join(tmp(), 'wt');
  sh(repo.clone, 'git', ['fetch', 'origin']);
  sh(repo.clone, 'git', ['worktree', 'add', '-b', BRANCH, path, `origin/${REL}`]);
  const startSha = sh(path, 'git', ['rev-parse', 'HEAD']);
  const startedAtMs = Date.now() - 5000;
  const branchesAtStart = await snapshotBranches(path);
  const releasePush = (changes: Record<string, string | null>, message = 'release moves') => {
    for (const [f, t] of Object.entries(changes)) {
      if (t === null) sh(other, 'git', ['rm', '-q', f]);
      else write(other, f, t);
    }
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', message]);
    sh(other, 'git', ['push', 'origin', REL]);
    sh(path, 'git', ['fetch', 'origin']);
  };
  const input = (extra: Partial<GuardInput> = {}): GuardInput => ({
    worktree: path,
    roleKey: 'architect',
    permissions: architectPerms,
    branchName: BRANCH,
    startSha,
    branchesAtStart,
    e2eGlobs: [],
    startedAtMs,
    ...extra,
  });
  const tips = () => [sh(path, 'git', ['rev-parse', `origin/${REL}`])];
  const commit = (message = 'work') => {
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', message]);
  };
  void opts;
  return { repo, other, path, startSha, input, tips, commit, releasePush };
}

const rules = async (g: Promise<{ rule: string }[]>) => (await g).map((v) => v.rule);
const tree = (path: string) => sh(path, 'git', ['ls-files', '-s']);

describe('base-branch merges by the architect', () => {
  it('a merge of origin/<base> is accepted and nothing it brought in is discarded', async () => {
    const t = await setup();
    t.releasePush({ 'rel/new.ts': 'new\n', 'src/existing.ts': 'export const a = 2;\n', 'rel/old.ts': null });
    sh(t.path, 'git', ['merge', '--no-ff', '-m', 'merge release', `origin/${REL}`]);
    const input = t.input({ baseTipShas: t.tips() });
    expect(await rules(runGuard(input))).toEqual([]);
    // without the recorded tips the same merge is the architect's own change to product code
    expect(await rules(runGuard(t.input()))).toContain('architect_edited_non_docs');
    const before = tree(t.path);
    const r = await discardOutOfScope(input);
    expect(r).toEqual({ discarded: [], kept: [] });
    expect(tree(t.path)).toBe(before);
    expect(existsSync(join(t.path, 'rel/new.ts'))).toBe(true);
    expect(existsSync(join(t.path, 'rel/old.ts'))).toBe(false);
    expect(sh(t.path, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('a merge with a conflict resolved by combining both sides is accepted', async () => {
    const t = await setup();
    write(t.path, 'src/existing.ts', 'export const a = 1;\nexport const card = 1;\n');
    // the card side changed a product file earlier (before the shift): part of the baseline
    t.commit('card work');
    const start = sh(t.path, 'git', ['rev-parse', 'HEAD']);
    t.releasePush({ 'src/existing.ts': 'export const a = 1;\nexport const rel = 1;\n', 'rel/new.ts': 'n\n' });
    expect(() => sh(t.path, 'git', ['merge', `origin/${REL}`])).toThrow();
    write(t.path, 'src/existing.ts', 'export const a = 1;\nexport const card = 1;\nexport const rel = 1;\n');
    sh(t.path, 'git', ['add', '-A']);
    sh(t.path, 'git', ['commit', '--no-edit']);
    const input = t.input({ startSha: start, baseTipShas: t.tips() });
    expect(await rules(runGuard(input))).toEqual([]);
    expect(await discardOutOfScope(input)).toEqual({ discarded: [], kept: [] });
    expect(readFileSync(join(t.path, 'src/existing.ts'), 'utf8')).toContain('rel');
  });

  it('a hand edit on top of the merge is reported and discarded alone; merge content survives', async () => {
    const t = await setup();
    t.releasePush({ 'rel/new.ts': 'new\n', 'src/existing.ts': 'export const a = 2;\n' });
    sh(t.path, 'git', ['merge', '--no-ff', '-m', 'merge release', `origin/${REL}`]);
    // committed hand edit of a file the merge changed, plus an uncommitted one of an untouched file
    write(t.path, 'src/existing.ts', 'export const a = 3; // hand\n');
    t.commit('hand edit');
    write(t.path, 'src/other.ts', 'hand edited\n');
    const input = t.input({ baseTipShas: t.tips() });
    const v = await runGuard(input);
    expect(v.map((x) => x.rule)).toEqual(['architect_edited_non_docs']);
    const detail = v[0]?.detail ?? '';
    expect(detail).toContain('src/existing.ts');
    expect(detail).toContain('src/other.ts');
    expect(detail).not.toContain('rel/new.ts');
    const r = await discardOutOfScope(input);
    expect(r.discarded.sort()).toEqual(['src/existing.ts', 'src/other.ts']);
    expect(r.kept).toEqual([]);
    // restored to the merge's content, not to the pre-merge start
    expect(readFileSync(join(t.path, 'src/existing.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(readFileSync(join(t.path, 'src/other.ts'), 'utf8')).toBe('other\n');
    expect(existsSync(join(t.path, 'rel/new.ts'))).toBe(true);
  });

  it('a hand edit inside the merge commit is reported', async () => {
    const t = await setup();
    t.releasePush({ 'rel/new.ts': 'new\n' });
    sh(t.path, 'git', ['merge', '--no-commit', '--no-ff', `origin/${REL}`]);
    write(t.path, 'src/other.ts', 'sneaked into the merge\n');
    sh(t.path, 'git', ['add', '-A']);
    sh(t.path, 'git', ['commit', '-m', 'merge release']);
    const input = t.input({ baseTipShas: t.tips() });
    const v = await runGuard(input);
    expect(v.map((x) => x.rule)).toEqual(['architect_edited_non_docs']);
    expect(v[0]?.detail).toContain('src/other.ts');
    expect(v[0]?.detail).not.toContain('rel/new.ts');
    const r = await discardOutOfScope(input);
    expect(r.discarded).toEqual(['src/other.ts']);
    expect(readFileSync(join(t.path, 'src/other.ts'), 'utf8')).toBe('other\n');
    expect(existsSync(join(t.path, 'rel/new.ts'))).toBe(true);
  });

  it('a fast-forward onto the base is accepted too', async () => {
    const t = await setup();
    t.releasePush({ 'rel/new.ts': 'new\n' });
    sh(t.path, 'git', ['merge', `origin/${REL}`]);
    expect(sh(t.path, 'git', ['rev-list', '--merges', '--count', `${t.startSha}..HEAD`])).toBe('0');
    const input = t.input({ baseTipShas: t.tips() });
    expect(await rules(runGuard(input))).toEqual([]);
    expect(await discardOutOfScope(input)).toEqual({ discarded: [], kept: [] });
    expect(existsSync(join(t.path, 'rel/new.ts'))).toBe(true);
  });

  it('files another process put on the branch are kept even when no base tip is known', async () => {
    const t = await setup();
    t.releasePush({ 'rel/new.ts': 'new\n', 'src/existing.ts': 'export const a = 2;\n' });
    sh(t.path, 'git', ['merge', '--ff-only', `origin/${REL}`]); // reflog: Fast-forward, not the shift's own commit
    write(t.path, 'mine.ts', 'mine\n');
    t.commit('own out-of-scope commit');
    write(t.path, 'dirty.ts', 'dirty\n');
    const before = tree(t.path);
    const r = await discardOutOfScope(t.input());
    expect(r.kept.sort()).toEqual(['rel/new.ts', 'src/existing.ts']);
    expect(r.discarded.sort()).toEqual(['dirty.ts', 'mine.ts']);
    expect(existsSync(join(t.path, 'rel/new.ts'))).toBe(true);
    expect(readFileSync(join(t.path, 'src/existing.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(tree(t.path)).not.toBe(before); // mine.ts is gone from the index
    expect(existsSync(join(t.path, 'mine.ts'))).toBe(false);
  });

  it('a main merge and a base merge in the same shift are both exempt', async () => {
    const t = await setup();
    t.releasePush({ 'rel/new.ts': 'new\n' });
    sh(t.path, 'git', ['merge', '--no-ff', '-m', 'merge release', `origin/${REL}`]);
    sh(t.other, 'git', ['checkout', 'main']);
    write(t.other, 'src/from-main.ts', 'm\n');
    sh(t.other, 'git', ['add', '-A']);
    sh(t.other, 'git', ['commit', '-m', 'main moves']);
    sh(t.other, 'git', ['push', 'origin', 'main']);
    sh(t.path, 'git', ['fetch', 'origin']);
    sh(t.path, 'git', ['merge', '--no-ff', '-m', 'merge main', 'origin/main']);
    const main = sh(t.path, 'git', ['rev-parse', 'origin/main']);
    const input = t.input({ baseTipShas: t.tips(), mainMergeShas: [main] });
    expect(await rules(runGuard(input))).toEqual([]);
    expect(await discardOutOfScope(input)).toEqual({ discarded: [], kept: [] });
  });
});

describe('HEAD moved outside the shift', () => {
  it('a reset to an ancestor discards nothing on disk', async () => {
    const t = await setup();
    write(t.path, 'NOTES.md', 'notes\n');
    t.commit('c1');
    const c1 = sh(t.path, 'git', ['rev-parse', 'HEAD']);
    write(t.path, 'src/x.ts', 'x\n');
    t.commit('c2');
    sh(t.path, 'git', ['reset', '--hard', t.startSha]);
    const input = t.input({ startSha: c1 });
    write(t.path, 'stray.ts', 'stray\n');
    const before = tree(t.path);
    const r = await discardOutOfScope(input);
    expect(r.discarded).toEqual([]);
    expect(r.skipped).toEqual({ reason: 'head_moved', from: c1, to: t.startSha });
    expect(tree(t.path)).toBe(before);
    expect(existsSync(join(t.path, 'stray.ts'))).toBe(true);
    expect(await uncommittedOutOfScope(input)).toEqual(['stray.ts']);
  });
});

describe('plain out-of-scope edits are unchanged', () => {
  it('uncommitted and committed out-of-scope edits (no merge) are discarded and refused', async () => {
    const t = await setup();
    write(t.path, 'committed.ts', 'c\n');
    t.commit('own');
    write(t.path, 'src/existing.ts', 'export const a = 9;\n');
    write(t.path, 'ok.md', 'ok\n');
    const input = t.input({ baseTipShas: t.tips() });
    expect(await rules(runGuard(input))).toEqual(['architect_edited_non_docs']);
    const r = await discardOutOfScope(input);
    expect(r.discarded.sort()).toEqual(['committed.ts', 'src/existing.ts']);
    expect(r.kept).toEqual([]);
    expect(existsSync(join(t.path, 'committed.ts'))).toBe(false);
    expect(readFileSync(join(t.path, 'src/existing.ts'), 'utf8')).toBe('export const a = 1;\n');
  });
});

describe('the shift-end sequence after a base merge (GWP-63 replay)', () => {
  const who = {
    GIT_AUTHOR_NAME: 'a',
    GIT_AUTHOR_EMAIL: 'a@x.test',
    GIT_COMMITTER_NAME: 'a',
    GIT_COMMITTER_EMAIL: 'a@x.test',
  };

  it('discard then autoCommit commits no revert of the release files, also after a reset to the merge', async () => {
    const t = await setup();
    t.releasePush({ 'rel/new.ts': 'new\n', 'src/existing.ts': 'export const a = 2;\n', 'rel/old.ts': null });
    sh(t.path, 'git', ['merge', '--no-ff', '-m', 'merge release', `origin/${REL}`]);
    const merge = sh(t.path, 'git', ['rev-parse', 'HEAD']);
    const files = sh(t.path, 'git', ['ls-files']);

    // shift 1: rejected (a hand edit), shift-end discard + autoCommit
    write(t.path, 'src/other.ts', 'hand\n');
    write(t.path, 'ok.md', 'ok\n');
    const i1 = t.input({ baseTipShas: t.tips() });
    expect((await discardOutOfScope(i1)).discarded).toEqual(['src/other.ts']);
    await autoCommit({ worktree: t.path, env: who });
    expect(sh(t.path, 'git', ['diff', '--name-status', merge, 'HEAD'])).toBe('A\tok.md');

    // shift 2 starts on that commit; the branch is reset to the merge during the shift (a repair)
    const start2 = sh(t.path, 'git', ['rev-parse', 'HEAD']);
    sh(t.path, 'git', ['reset', '--hard', merge]);
    write(t.path, 'src/other.ts', 'hand again\n');
    const i2 = t.input({ startSha: start2, baseTipShas: t.tips(), startedAtMs: Date.now() - 1000 });
    const r2 = await discardOutOfScope(i2);
    expect(r2.skipped?.to).toBe(merge);
    const hold = await uncommittedOutOfScope(i2);
    expect(hold).toEqual(['src/other.ts']);
    expect(sh(t.path, 'git', ['diff', '--name-only', merge, 'HEAD'])).toBe('');
    expect(sh(t.path, 'git', ['ls-files'])).toBe(files);
  });
});

describe('the base moves while the shift runs', () => {
  it('a merge of a newer origin/<base> than the start tip is exempt once the tip is refreshed; the discard and autoCommit revert nothing', async () => {
    const t = await setup();
    t.releasePush({ 'rel/early.ts': 'early\n' });
    const startTips = t.tips();
    // another shift of the same clone fetches a newer release while this architect shift runs
    t.releasePush({ 'rel/late.ts': 'late\n', 'src/existing.ts': 'export const a = 5;\n', 'rel/old.ts': null }, 'later');
    sh(t.path, 'git', ['merge', '--no-ff', '-m', 'merge release', `origin/${REL}`]);
    const fresh = await fetchedRemoteTip(t.path, REL);
    expect(fresh).toBe(t.tips()[0]);
    expect(startTips).not.toContain(fresh);
    const input = t.input({ baseTipShas: [...startTips, fresh as string] });
    expect(await rules(runGuard(input))).toEqual([]);
    write(t.path, 'ok.md', 'ok\n');
    const before = sh(t.path, 'git', ['rev-parse', 'HEAD']);
    expect(await discardOutOfScope(input)).toEqual({ discarded: [], kept: [] });
    await autoCommit({
      worktree: t.path,
      env: { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@x.test', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@x.test' },
    });
    expect(sh(t.path, 'git', ['diff', '--name-status', before, 'HEAD'])).toBe('A\tok.md');
    expect(existsSync(join(t.path, 'rel/late.ts'))).toBe(true);
  });

  it('only a fetch makes origin/<base> a trusted tip; a hand-moved ref is not', async () => {
    const t = await setup();
    t.releasePush({ 'rel/x.ts': 'x\n' });
    expect(await fetchedRemoteTip(t.path, REL)).toBe(t.tips()[0]);
    // the agent moves the remote-tracking ref to its own commit
    write(t.path, 'mine.ts', 'mine\n');
    t.commit('mine');
    sh(t.path, 'git', ['update-ref', `refs/remotes/origin/${REL}`, 'HEAD']);
    expect(await fetchedRemoteTip(t.path, REL)).toBeNull();
    expect(await fetchedRemoteTip(t.path, 'no-such-branch')).toBeNull();
  });
});
