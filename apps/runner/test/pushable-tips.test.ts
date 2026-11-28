import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HygieneRepoSpec } from '@aom/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hygieneRepo } from '../src/devops/hygiene.ts';
import { git, setGitAfterHook } from '../src/git/git.ts';
import {
  cloneKey,
  latestTip,
  recoverActiveClones,
  ruleA,
  seedOnce,
  setTipStore,
  TipStore,
  tipStore,
  writerStart,
} from '../src/git/pushable-tips.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

/**
 * gate-fixes-2 P1 (Rule A, D2, D3, R3-B1, R3-B2, B1, S11) through hygiene: the runner pushes only tips it made or
 * recorded, or the user's own idle commits on a trusted tip; outside commits on origin are still taken.
 */
cleanupTmp();

const U = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const spec = (repo: TestRepo, over: Partial<HygieneRepoSpec> = {}): HygieneRepoSpec => ({
  repoId: U,
  projectId: U,
  projectKey: 'TOY',
  projectName: 'Toy',
  name: 'toy',
  localPath: repo.clone,
  remoteUrl: repo.origin,
  workingBranch: 'main',
  branchSource: 'repo',
  branchPrefix: 'aom/',
  finishedBranches: [],
  mainBranch: null,
  finishedCards: [],
  ...over,
});
const originHead = (repo: TestRepo, b = 'main') => sh(repo.origin, 'git', ['rev-parse', b]);
const head = (repo: TestRepo, ref = 'main') => sh(repo.clone, 'git', ['rev-parse', ref]);
const commit = (cwd: string, file: string, msg = `commit ${file}`) => {
  writeFileSync(join(cwd, file), file);
  sh(cwd, 'git', ['add', '-A']);
  sh(cwd, 'git', ['commit', '-m', msg]);
  return sh(cwd, 'git', ['rev-parse', 'HEAD']);
};
/** A commit object on top of `parent` made without moving any branch (what a session can write into objects/). */
const looseCommit = (repo: TestRepo, parent: string, msg: string) =>
  sh(repo.clone, 'git', ['commit-tree', `${parent}^{tree}`, '-p', parent, '-m', msg]);
/** Another clone pushes to origin (a person or a tool outside Guildwise). */
function outsidePush(repo: TestRepo, file: string, branch = 'main') {
  const other = join(tmp(), 'outside');
  sh(repo.root, 'git', ['clone', '-q', repo.origin, other]);
  sh(other, 'git', ['checkout', branch]);
  commit(other, file, `outside ${file}`);
  sh(other, 'git', ['push', '-q', 'origin', branch]);
  return sh(other, 'git', ['rev-parse', 'HEAD']);
}

let store: TipStore;
let saved: TipStore | null;
beforeEach(() => {
  saved = tipStore();
  store = TipStore.forRoot(mkdtempSync(join(tmp(), 'tips-')));
  setTipStore(store);
});
afterEach(() => setTipStore(saved));

describe('Rule A through hygiene', () => {
  it('a wb tip forged with update-ref while a session runs is never pushed: NOT PUSHED, an error finding', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo)); // the clone is known (seeded) before any session
    const before = originHead(repo);
    const release = await writerStart(repo.clone);
    const forged = looseCommit(repo, before, 'forged by a session');
    sh(repo.clone, 'git', ['update-ref', 'refs/heads/main', forged]);
    // busy (the session still runs) ...
    const busy = await hygieneRepo(spec(repo));
    expect(busy.result.notPushed).toMatch(/changed while an agent session could write/);
    expect(busy.result.problem).toMatchObject({ kind: 'error' });
    expect(busy.result.problem?.detail).toMatch(/^NOT PUSHED: /);
    expect(originHead(repo)).toBe(before);
    // ... and idle (the session ended, its leftover stays untrusted)
    await release();
    const idle = await hygieneRepo(spec(repo));
    expect(idle.result.notPushed).toMatch(/left by an agent session/);
    expect(idle.result.pushed).toBe(false);
    expect(originHead(repo)).toBe(before);
  });

  it('a wb tip forged in packed-refs is never pushed', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    const before = originHead(repo);
    const release = await writerStart(repo.clone);
    const forged = looseCommit(repo, before, 'forged in packed-refs');
    sh(repo.clone, 'git', ['pack-refs', '--all']);
    const packed = join(repo.clone, '.git', 'packed-refs');
    writeFileSync(
      packed,
      readFileSync(packed, 'utf8').replace(`${before} refs/heads/main`, `${forged} refs/heads/main`),
    );
    await release();
    expect(head(repo)).toBe(forged);
    const r = await hygieneRepo(spec(repo));
    expect(r.result.notPushed).toBeTruthy();
    expect(originHead(repo)).toBe(before);
  });

  it('S11: an older recorded tip (after a reflog wipe) is not the latest record and is not pushed', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    const a = commit(repo.clone, 'a.txt'); // idle user commit: recorded `user` and pushed
    expect((await hygieneRepo(spec(repo))).result.pushed).toBe(true);
    const b = commit(repo.clone, 'b.txt');
    expect((await hygieneRepo(spec(repo))).result.pushed).toBe(true);
    expect(originHead(repo)).toBe(b);
    // a session moves main back to a (an old record) and on top of it; origin is reset to a by "someone"
    const release = await writerStart(repo.clone);
    const forged = looseCommit(repo, a, 'on an old tip');
    sh(repo.clone, 'git', ['update-ref', 'refs/heads/main', forged]);
    sh(repo.clone, 'git', ['reflog', 'expire', '--expire=now', '--all']);
    sh(repo.origin, 'git', ['update-ref', 'refs/heads/main', a]);
    const r = await hygieneRepo(spec(repo));
    await release();
    expect(r.result.pushed).toBe(false);
    expect(r.result.notPushed).toBeTruthy();
    expect(originHead(repo)).toBe(a);
  });

  it('ruleA without a store, or with a damaged one, fails closed', async () => {
    const repo = makeRepo();
    const tip = commit(repo.clone, 'x.txt');
    setTipStore(null);
    expect(await ruleA(repo.clone, 'main', tip, originHead(repo))).toMatchObject({ push: false });
    setTipStore(store);
    writeFileSync(store.file, '{ not json');
    expect(await ruleA(repo.clone, 'main', tip, originHead(repo))).toMatchObject({
      push: false,
      notPushed: expect.stringMatching(/damaged/),
    });
  });
});

describe('D2: the user’s own commits', () => {
  it('gate item 8: a hand commit made while no session runs, on a pushed wb, is pushed as before', async () => {
    const repo = makeRepo();
    // a card session ran and ended (its 1->0 snapshot is the pushed main)
    const release = await writerStart(repo.clone);
    await release();
    const hand = commit(repo.clone, 'hand.txt', 'by hand');
    const r = await hygieneRepo(spec(repo));
    expect(r.result).toMatchObject({ problem: null, pushed: true });
    expect(originHead(repo)).toBe(hand);
    expect((await latestTip(repo.clone, 'refs/heads/main'))?.how).toBe('user');
  });

  it('a commit made while a session runs is NOT PUSHED (an error finding)', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    const release = await writerStart(repo.clone);
    const before = originHead(repo);
    commit(repo.clone, 'during.txt');
    const r = await hygieneRepo(spec(repo));
    await release();
    expect(r.result.problem?.kind).toBe('error');
    expect(r.result.notPushed).toBeTruthy();
    expect(originHead(repo)).toBe(before);
  });

  it('an idle commit on top of a tip a session left is NOT PUSHED', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    const release = await writerStart(repo.clone);
    const before = originHead(repo);
    sh(repo.clone, 'git', ['update-ref', 'refs/heads/main', looseCommit(repo, before, 'left by a session')]);
    sh(repo.clone, 'git', ['reset', '-q', '--hard', 'main']);
    await release();
    commit(repo.clone, 'mine.txt', 'by hand on top');
    const r = await hygieneRepo(spec(repo));
    expect(r.result.notPushed).toMatch(/sits on top of a commit an agent session left/);
    expect(originHead(repo)).toBe(before);
  });

  it('R3-B1: a runner restart during a session distrusts what the session left (no 1->0)', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    await writerStart(repo.clone); // never released: the runner "stops" here
    const before = originHead(repo);
    sh(repo.clone, 'git', ['update-ref', 'refs/heads/main', looseCommit(repo, before, 'left at the crash')]);
    // the restart: a new store object over the same files, at count 0
    const restarted = new TipStore(store.file, store.marker);
    setTipStore(restarted);
    const key = (await cloneKey(repo.clone)) as string;
    expect(restarted.clone(key)?.active).toBe(true);
    await recoverActiveClones(restarted);
    expect(restarted.clone(key)?.active).toBe(false);
    expect(restarted.clone(key)?.idleTips?.['refs/heads/main']).toBe(head(repo));
    const r = await hygieneRepo(spec(repo));
    expect(r.result.notPushed).toBeTruthy();
    expect(originHead(repo)).toBe(before);
    // and a hand commit on top of it is not pushed either (its idle tip is untrusted)
    commit(repo.clone, 'after.txt');
    expect((await hygieneRepo(spec(repo))).result.notPushed).toBeTruthy();
  });

  it('R3-B2: two clones of one origin; a session in clone 1 forges main; clone 2 keeps its count and idle tips', async () => {
    const repo = makeRepo();
    const clone2 = join(repo.scanRoot, 'toy2');
    sh(repo.scanRoot, 'git', ['clone', '-q', repo.origin, clone2]);
    const repo2 = { ...repo, clone: clone2 };
    await hygieneRepo(spec(repo));
    await hygieneRepo(spec(repo2));
    const k1 = (await cloneKey(repo.clone)) as string;
    const k2 = (await cloneKey(clone2)) as string;
    expect(k1).not.toBe(k2);
    const idle2 = store.clone(k2)?.idleTips;
    const release = await writerStart(repo.clone);
    expect(store.count(k1)).toBe(1);
    expect(store.count(k2)).toBe(0);
    const before = originHead(repo);
    sh(repo.clone, 'git', ['update-ref', 'refs/heads/main', looseCommit(repo, before, 'forged in clone 1')]);
    await release();
    expect((await hygieneRepo(spec(repo))).result.notPushed).toBeTruthy();
    expect(store.clone(k2)?.idleTips).toEqual(idle2);
    // clone 2: an idle hand commit there is still pushed
    const hand = commit(clone2, 'clone2.txt');
    expect((await hygieneRepo(spec(repo2))).result.pushed).toBe(true);
    expect(originHead(repo)).toBe(hand);
  });
});

describe('D3: one-time seeding', () => {
  it('the first start seeds every clone; the second start does not seed again', async () => {
    const repo = makeRepo();
    const tip = head(repo);
    await seedOnce(store, [repo.clone]);
    expect(store.seeded).toBe(true);
    expect((await latestTip(repo.clone, 'refs/heads/main'))?.how).toBe('seed');
    // a later tip is not re-seeded at the next start
    const release = await writerStart(repo.clone);
    sh(repo.clone, 'git', ['update-ref', 'refs/heads/main', looseCommit(repo, tip, 'session')]);
    await release();
    await seedOnce(store, [repo.clone]);
    expect((await latestTip(repo.clone, 'refs/heads/main'))?.sha).toBe(tip);
  });

  it('R3-S2: the store missing while the marker exists fails closed', async () => {
    const repo = makeRepo();
    await seedOnce(store, [repo.clone]);
    writeFileSync(store.file, '');
    sh(repo.root, 'rm', ['-f', store.file]);
    const tip = commit(repo.clone, 'y.txt');
    expect(await ruleA(repo.clone, 'main', tip, originHead(repo))).toMatchObject({
      push: false,
      notPushed: expect.stringMatching(/cannot be read/),
    });
  });
});

describe('B1: replace refs and grafts do not make a forged tip trusted', () => {
  /** A session leaves F on main, and makes origin's tip O look like it descends from F. */
  const setup = async (how: 'replace' | 'graft') => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    const o = originHead(repo);
    const release = await writerStart(repo.clone);
    const f = looseCommit(repo, o, 'forged F');
    sh(repo.clone, 'git', ['update-ref', 'refs/heads/main', f]);
    sh(repo.clone, 'git', ['reset', '-q', '--hard', 'main']);
    if (how === 'replace') {
      const fake = sh(repo.clone, 'git', ['commit-tree', `${o}^{tree}`, '-p', f, '-m', 'fake O']);
      sh(repo.clone, 'git', ['replace', o, fake]);
    } else writeFileSync(join(repo.clone, '.git', 'info', 'grafts'), `${o} ${f}\n`);
    await release();
    commit(repo.clone, 'on-top.txt', 'idle commit on F');
    return { repo, o };
  };
  for (const how of ['replace', 'graft'] as const)
    it(`${how}: the idle commit on the forged F is NOT PUSHED`, async () => {
      const { repo, o } = await setup(how);
      const r = await hygieneRepo(spec(repo));
      expect(r.result.notPushed).toBeTruthy();
      expect(originHead(repo)).toBe(o);
    });
});

describe('outside commits on origin are still taken (the owner’s question)', () => {
  it('an outside push to origin, hygiene takes it: fast-forwarded and recorded; a commit on top is pushed', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    const outside = outsidePush(repo, 'outside.txt');
    const r = await hygieneRepo(spec(repo));
    expect(r.result).toMatchObject({ problem: null });
    expect(head(repo)).toBe(outside);
    expect(await latestTip(repo.clone, 'refs/heads/main')).toMatchObject({ sha: outside, how: 'merged' });
    // a session ran meanwhile (its snapshot is the fetched tip), then a hand commit on top: pushed
    const release = await writerStart(repo.clone);
    await release();
    const mine = commit(repo.clone, 'mine.txt');
    expect((await hygieneRepo(spec(repo))).result).toMatchObject({ problem: null, pushed: true });
    expect(originHead(repo)).toBe(mine);
  });

  it('a local branch equal to origin needs no record: nothing to push, no finding', async () => {
    const repo = makeRepo();
    const tip = head(repo);
    expect(await ruleA(repo.clone, 'main', tip, tip)).toEqual({ push: false, nothing: true });
    const release = await writerStart(repo.clone); // even while a session runs
    expect(await ruleA(repo.clone, 'main', tip, tip)).toEqual({ push: false, nothing: true });
    await release();
  });

  it('while busy, an outside commit is fetched and the update waits; the next idle run takes it', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    const wt = join(tmp(), 'card');
    sh(repo.clone, 'git', ['worktree', 'add', '-q', '-b', 'aom/toy-1-x', wt]);
    const outside = outsidePush(repo, 'outside.txt');
    const busy = await hygieneRepo(spec(repo), [wt]);
    expect(busy.result.problem).toBeNull();
    expect(busy.result.deferred).toContain('update main from origin');
    const idle = await hygieneRepo(spec(repo));
    expect(idle.result.problem).toBeNull();
    expect(head(repo)).toBe(outside);
  });

  it('a conflicting outside commit takes the conflict path: a conflict request, never NOT PUSHED', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    writeFileSync(join(repo.clone, 'README.md'), '# mine\n');
    sh(repo.clone, 'git', ['commit', '-qam', 'mine']);
    const other = join(tmp(), 'outside-c');
    sh(repo.root, 'git', ['clone', '-q', repo.origin, other]);
    writeFileSync(join(other, 'README.md'), '# theirs\n');
    sh(other, 'git', ['commit', '-qam', 'theirs']);
    sh(other, 'git', ['push', '-q', 'origin', 'main']);
    // checked out: the rebase conflicts
    const here = await hygieneRepo(spec(repo));
    expect(here.result.problem?.kind).toBe('conflict');
    expect(here.result.notPushed).toBeUndefined();
    expect(here.conflict).toBeTruthy();
    // not checked out: diverged is a conflict too
    sh(repo.clone, 'git', ['checkout', '-q', '-b', 'feature/x']);
    const away = await hygieneRepo(spec(repo));
    expect(away.result.problem?.kind).toBe('conflict');
    expect(away.result.notPushed).toBeUndefined();
    expect(away.conflict?.originHead).toBe(originHead(repo));
  });
});

describe('Rework 1: B1 commit-graph, D5 never seeding after a writer, B3 seams in hygiene', () => {
  /** Patches the commit-graph so that `child`'s first parent reads as `fakeParent` (a forged graph file). */
  function forgeGraph(repo: TestRepo, child: string, fakeParent: string, commits: string[]) {
    // topological generations only (v1), so the patch below decides git's reachability shortcut too
    execFileSync(
      'git',
      ['-C', repo.clone, '-c', 'commitGraph.generationVersion=1', 'commit-graph', 'write', '--stdin-commits'],
      {
        input: `${commits.join('\n')}\n`,
      },
    );
    const p = join(repo.clone, '.git', 'objects', 'info', 'commit-graph');
    chmodSync(p, 0o644);
    const b = readFileSync(p);
    const chunks = new Map<string, number>();
    for (let i = 0; i <= b[6]!; i++)
      chunks.set(
        b.subarray(8 + 12 * i, 12 + 12 * i).toString('latin1'),
        Number(b.readBigUInt64BE(12 + 12 * i)),
      );
    const oidl = chunks.get('OIDL') as number;
    const cdat = chunks.get('CDAT') as number;
    const oids = Array.from({ length: (cdat - oidl) / 20 }, (_, i) =>
      b.subarray(oidl + 20 * i, oidl + 20 * i + 20).toString('hex'),
    );
    const ci = oids.indexOf(child);
    const pi = oids.indexOf(fakeParent);
    b.writeUInt32BE(pi, cdat + ci * 36 + 20);
    // generations: the fake parent must look older than the child, or git's reachability check stops early
    const genAt = (i: number) => cdat + i * 36 + 28;
    const dateHi = (i: number) => b.readUInt32BE(genAt(i)) & 0b11;
    b.writeUInt32BE((1000 << 2) | dateHi(ci), genAt(ci));
    const gda2 = chunks.get('GDA2');
    if (gda2 !== undefined) {
      b.writeUInt32BE(0, gda2 + pi * 4);
      b.writeUInt32BE(0x7fffffff, gda2 + ci * 4);
    }
    writeFileSync(p, b);
  }

  it('B1: the runner’s git ignores a forged commit-graph (plain git believes it)', async () => {
    const repo = makeRepo();
    const o = originHead(repo);
    const f = looseCommit(repo, o, 'forged F');
    const o2 = outsidePush(repo, 'outside.txt');
    sh(repo.clone, 'git', ['fetch', '-q', 'origin']);
    // a session's graph file claims origin's new tip O2 has F as its parent
    forgeGraph(repo, o2, f, [o, f, o2]);
    const plain = spawnSync('git', ['-C', repo.clone, 'rev-list', '--parents', '-n1', o2], {
      encoding: 'utf8',
    });
    expect(plain.stdout.trim(), 'plain git reads the forged parent').toBe(`${o2} ${f}`);
    const hardened = await git(repo.clone, ['rev-list', '--parents', '-n1', o2]);
    expect(hardened.stdout.trim()).toBe(`${o2} ${o}`);
    expect((await git(repo.clone, ['rev-list', o2])).stdout).not.toContain(f);
  });

  it('D5: a clone a writer ran in is never seeded later, even when the store lost its entry (NOT PUSHED)', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    const before = originHead(repo);
    const release = await writerStart(repo.clone);
    sh(repo.clone, 'git', [
      'update-ref',
      'refs/heads/main',
      looseCommit(repo, before, 'forged in a session'),
    ]);
    await release();
    // the store is lost (a fresh data dir, or the clone moved): no entry for this clone, no D3 marker
    setTipStore(TipStore.forRoot(mkdtempSync(join(tmp(), 'tips-lost-'))));
    const r = await hygieneRepo(spec(repo));
    expect(r.result.notPushed).toBeTruthy();
    expect(r.result.problem?.detail).toMatch(/^NOT PUSHED: /);
    expect(originHead(repo)).toBe(before);
    // D3 seeding at a first start does not trust it either
    const fresh = TipStore.forRoot(mkdtempSync(join(tmp(), 'tips-first-')));
    setTipStore(fresh);
    await seedOnce(fresh, [repo.clone]);
    expect(await latestTip(repo.clone, 'refs/heads/main')).toBeNull();
    expect((await hygieneRepo(spec(repo))).result.notPushed).toBeTruthy();
  });

  it('D5: a forged tip in a clone no writer ever ran in, created before its first session, is seeded (b9b59218 trust)', async () => {
    // the counterpart: without any writer mark the clone's tips are the user's (D3 trusts exactly that)
    const repo = makeRepo();
    const mine = commit(repo.clone, 'mine.txt');
    expect((await hygieneRepo(spec(repo))).result.pushed).toBe(true);
    expect(originHead(repo)).toBe(mine);
  });

  it('B3 (S8 seam): main moved right after hygiene’s fast-forward is not recorded and never sent', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    const outside = outsidePush(repo, 'outside.txt');
    // the race is a session writing while hygiene works: it counts as a writer
    const release = await writerStart(repo.clone);
    let fired = false;
    let sneak = '';
    setGitAfterHook((args, cwd) => {
      if (fired || args[0] !== 'merge' || cwd !== repo.clone) return;
      fired = true;
      sneak = sh(repo.clone, 'git', ['commit-tree', `${outside}^{tree}`, '-p', outside, '-m', 'sneaked']);
      sh(repo.clone, 'git', ['update-ref', 'refs/heads/main', sneak]);
    });
    const r = await hygieneRepo(spec(repo));
    setGitAfterHook(null);
    expect(fired).toBe(true);
    expect(r.result.problem?.kind).toBe('error');
    expect(r.result.actions.join(' ')).not.toContain('pulled main');
    expect((await latestTip(repo.clone, 'refs/heads/main'))?.sha).not.toBe(sneak);
    await release();
    const next = await hygieneRepo(spec(repo));
    expect(originHead(repo)).toBe(outside);
    expect(next.result.pushed).toBe(false);
    expect(next.result.notPushed).toBeTruthy();
  });

  it('B3 (S8 seam): main moved right after hygiene’s rebase is not recorded, not sent, and not a conflict request', async () => {
    const repo = makeRepo();
    await hygieneRepo(spec(repo));
    commit(repo.clone, 'mine.txt'); // idle user commit (trusted)
    const outside = outsidePush(repo, 'outside.txt');
    const release = await writerStart(repo.clone);
    let fired = false;
    setGitAfterHook((args, cwd) => {
      if (fired || args[0] !== 'rebase' || cwd !== repo.clone) return;
      fired = true;
      const head = sh(repo.clone, 'git', ['rev-parse', 'refs/heads/main']);
      sh(repo.clone, 'git', [
        'update-ref',
        'refs/heads/main',
        sh(repo.clone, 'git', ['commit-tree', `${head}^{tree}`, '-p', head, '-m', 'sneaked']),
      ]);
    });
    const r = await hygieneRepo(spec(repo));
    setGitAfterHook(null);
    expect(fired).toBe(true);
    expect(r.result.problem?.kind).toBe('error');
    expect(r.conflict).toBeUndefined();
    expect(r.result.pushed).toBe(false);
    expect(originHead(repo)).toBe(outside);
    await release();
  });
});
