import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FinalizeExecutePayload, HygieneRepoSpec } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hygieneRepo } from '../src/devops/hygiene.ts';
import { NEVER_TIDY, tidyUpRefusal } from '../src/devops/tidy-up-rules.ts';
import { BranchLedger } from '../src/git/branch-ledger.ts';
import { executeCompletion } from '../src/git/completion.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

/**
 * runner-authority-fixes T1 (AC1, AC2): the branch tidy-up follows the runner's own rules. A server-supplied name,
 * prefix or "merged" answer never deletes a protected, working, default, release or foreign branch, and commits that
 * may exist only on origin are saved under refs/guildwise/saved/ before an origin-only delete.
 */

cleanupTmp();

const U = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
const CARD = (n: number) => `019e3f6a-7b1c-7a2d-8c3e-0123456789c${n}`;
const saved: Record<string, string | undefined> = {};
const GIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
beforeAll(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Card = HygieneRepoSpec['finishedCards'][number];
const spec = (repo: TestRepo, cards: Card[], over: Partial<HygieneRepoSpec> = {}): HygieneRepoSpec => ({
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
  finishedCards: cards,
  ...over,
});
const card = (n: number, branch: string, over: Partial<Card> = {}): Card => ({
  cardId: CARD(n),
  ref: `TOY-${n}`,
  branch,
  ...over,
});
const newLedger = () => new BranchLedger(join(tmp(), 'card-branches.json'));
const originHeads = (repo: TestRepo) =>
  sh(repo.origin, 'git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').sort();
const localHeads = (repo: TestRepo) =>
  sh(repo.clone, 'git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n').sort();
const savedRefs = (repo: TestRepo) =>
  sh(repo.clone, 'git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/guildwise/saved'])
    .split('\n')
    .filter(Boolean);

/** A branch with one commit, sent to origin, merged into main (origin too), back on main. */
function mergedBranch(repo: TestRepo, branch: string, file: string) {
  sh(repo.clone, 'git', ['checkout', '-b', branch, 'main']);
  writeFileSync(join(repo.clone, file), `${file}\n`);
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', `add ${file}`]);
  sh(repo.clone, 'git', ['push', 'origin', branch]);
  sh(repo.clone, 'git', ['checkout', 'main']);
  sh(repo.clone, 'git', ['merge', '--no-ff', '-m', `merge ${file}`, branch]);
  sh(repo.clone, 'git', ['push', 'origin', 'main']);
}
const recordPushed = (ledger: BranchLedger, repo: TestRepo, branch: string) =>
  ledger.record(repo.remoteNormalized, branch, 'pushed', sh(repo.origin, 'git', ['rev-parse', branch]));

describe('AC1: a server-supplied tidy-up request never deletes a protected or foreign branch', () => {
  it('the rule list holds main, master, develop, development, trunk and release branches', () => {
    for (const b of ['main', 'master', 'develop', 'development', 'trunk']) expect(NEVER_TIDY).toContain(b);
    expect(tidyUpRefusal('release/1.2', {})).toMatch(/release/);
    expect(tidyUpRefusal('Release-2', {})).toMatch(/release/);
    expect(tidyUpRefusal('stable', { originHead: 'stable' })).toMatch(/default branch/);
    expect(tidyUpRefusal('wb', { wb: 'wb' })).toMatch(/working branch/);
    expect(tidyUpRefusal('aom/toy-1', { wb: 'main' })).toBeNull();
  });

  it('a server-claimed "merged" main (as the pull request branch) is not deleted, even when the ledger names it', async () => {
    const repo = makeRepo();
    const ledger = newLedger();
    recordPushed(ledger, repo, 'main'); // even a forged ledger entry does not open a protected branch
    sh(repo.clone, 'git', ['checkout', '-b', 'side']);
    const { result } = await hygieneRepo(
      spec(repo, [card(1, 'main', { prUrl: 'https://h/pull/1', remoteBranch: 'main' })], {
        workingBranch: 'side',
      }),
      [],
      { ledger, changeState: async () => 'merged' },
    );
    expect(result.cleaned).toEqual([]);
    expect(originHeads(repo)).toContain('main');
    expect(localHeads(repo)).toContain('main');
  });

  it('a card whose pull request branch is "main" leaves origin main alone (server-claimed merged)', async () => {
    const repo = makeRepo();
    const ledger = newLedger();
    const { result } = await hygieneRepo(
      spec(repo, [card(2, 'aom/toy-2', { prUrl: 'https://h/pull/2', remoteBranch: 'main' })]),
      [],
      { ledger, changeState: async () => 'merged' },
    );
    expect(result.cleaned).toEqual([]);
    expect(originHeads(repo)).toEqual(['main']);
  });

  it.each([
    ['develop', {}],
    ['development', {}],
    ['release/1.2', {}],
    ['work', { workingBranch: 'work' }],
  ] as const)(
    'keeps %s on origin and in the clone although it is merged and in the ledger',
    async (b, over) => {
      const repo = makeRepo();
      const ledger = newLedger();
      mergedBranch(repo, b, 'x.txt');
      recordPushed(ledger, repo, b);
      ledger.record(repo.remoteNormalized, b, 'created');
      if ('workingBranch' in over) sh(repo.clone, 'git', ['checkout', '-b', 'elsewhere']);
      const { result } = await hygieneRepo(spec(repo, [card(3, b)], over), [], {
        ledger,
        changeState: async () => 'merged',
      });
      expect(result.cleaned).toEqual([]);
      expect(originHeads(repo)).toContain(b);
      expect(localHeads(repo)).toContain(b);
    },
  );

  it("keeps origin's default branch as git reports it", async () => {
    const repo = makeRepo();
    const ledger = newLedger();
    mergedBranch(repo, 'stable', 's.txt');
    recordPushed(ledger, repo, 'stable');
    sh(repo.origin, 'git', ['symbolic-ref', 'HEAD', 'refs/heads/stable']);
    const { result } = await hygieneRepo(spec(repo, [card(4, 'stable')]), [], { ledger });
    expect(result.cleaned).toEqual([]);
    expect(originHeads(repo)).toContain('stable');
    expect(result.actions.join('\n')).toMatch(/stable kept: .*default branch/);
  });

  it('keeps a merged feature/x that this runner never pushed or created', async () => {
    const repo = makeRepo();
    mergedBranch(repo, 'feature/x', 'f.txt');
    const { result } = await hygieneRepo(spec(repo, [card(5, 'feature/x')]), [], { ledger: newLedger() });
    expect(result.cleaned).toEqual([]);
    expect(originHeads(repo)).toContain('feature/x');
    expect(localHeads(repo)).toContain('feature/x');
  });

  it('keeps an origin branch whose name the runner pushed once but which now holds other work (S-C)', async () => {
    const repo = makeRepo();
    const ledger = newLedger();
    mergedBranch(repo, 'aom/toy-6', 'a.txt');
    ledger.record(
      repo.remoteNormalized,
      'aom/toy-6',
      'pushed',
      sh(repo.origin, 'git', ['rev-parse', 'main~1']),
    );
    // a person reused the name for unrelated work that happens to be merged too
    sh(repo.clone, 'git', ['checkout', '--orphan', 'other']);
    writeFileSync(join(repo.clone, 'o.txt'), 'o\n');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'unrelated']);
    sh(repo.clone, 'git', ['push', '-f', 'origin', 'other:aom/toy-6']);
    sh(repo.clone, 'git', ['checkout', 'main']);
    sh(repo.clone, 'git', ['branch', '-D', 'aom/toy-6']);
    const { result } = await hygieneRepo(
      spec(repo, [card(6, 'aom/toy-6', { prUrl: 'https://h/pull/6' })]),
      [],
      {
        ledger,
        changeState: async () => 'merged',
      },
    );
    expect(result.cleaned).toEqual([]);
    expect(originHeads(repo)).toContain('aom/toy-6');
  });

  it('S6: a project prefix "mai" with finishedBranches ["main"] leaves the local main alone', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['checkout', '-b', 'develop']);
    sh(repo.clone, 'git', ['push', 'origin', 'develop']);
    const { result } = await hygieneRepo(
      spec(repo, [], { workingBranch: 'develop', branchPrefix: 'mai', finishedBranches: ['main'] }),
      [],
      { ledger: newLedger() },
    );
    expect(result.removedBranches).toEqual([]);
    expect(localHeads(repo)).toContain('main');
  });

  it('a merged branch under a runner prefix is still removed (from origin only when the runner pushed it)', async () => {
    const repo = makeRepo();
    const ledger = newLedger();
    mergedBranch(repo, 'guildwise/toy-7', 'g.txt');
    mergedBranch(repo, 'guildwise/toy-8', 'h.txt');
    recordPushed(ledger, repo, 'guildwise/toy-7');
    const { result } = await hygieneRepo(
      spec(repo, [card(7, 'guildwise/toy-7'), card(8, 'guildwise/toy-8')]),
      [],
      {
        ledger,
      },
    );
    expect(result.cleaned.map((c) => [c.branch, c.origin, c.local])).toEqual([
      ['guildwise/toy-7', true, true],
      ['guildwise/toy-8', false, true],
    ]);
    expect(originHeads(repo)).toEqual(['guildwise/toy-8', 'main']);
    expect(ledger.pushedSha(repo.remoteNormalized, 'guildwise/toy-7')).toBeNull();
  });
});

describe('AC2: commits that may exist only on origin are saved before an origin-only delete', () => {
  it('(a) a ledger-pushed branch that exists only on origin, with an unmerged commit, server says merged', async () => {
    const repo = makeRepo();
    const ledger = newLedger();
    const other = join(tmp(), 'other');
    sh(repo.root, 'git', ['clone', repo.origin, other]);
    sh(other, 'git', ['checkout', '-b', 'pieter/TOY-9']);
    writeFileSync(join(other, 'only-on-origin.txt'), 'x\n');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', 'only on origin']);
    sh(other, 'git', ['push', 'origin', 'pieter/TOY-9']);
    const tip = sh(repo.origin, 'git', ['rev-parse', 'pieter/TOY-9']);
    recordPushed(ledger, repo, 'pieter/TOY-9');
    const { result } = await hygieneRepo(
      spec(repo, [card(9, 'aom/toy-9', { prUrl: 'https://h/pull/9', remoteBranch: 'pieter/TOY-9' })]),
      [],
      { ledger, changeState: async () => 'merged' },
    );
    expect(result.cleaned).toEqual([
      expect.objectContaining({ branch: 'aom/toy-9', origin: true, local: false }),
    ]);
    expect(originHeads(repo)).toEqual(['main']);
    expect(savedRefs(repo)).toEqual([`refs/guildwise/saved/pieter/TOY-9-${tip.slice(0, 7)} ${tip}`]);
    // the saved commit is still reachable in the clone
    expect(sh(repo.clone, 'git', ['cat-file', '-t', tip])).toBe('commit');
  });

  it("(b) the clone's branch is behind origin's fixup: origin's tip is saved and the local branch kept", async () => {
    const repo = makeRepo();
    const ledger = newLedger();
    sh(repo.clone, 'git', ['checkout', '-b', 'aom/toy-10']);
    writeFileSync(join(repo.clone, 'a.txt'), 'a\n');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'a']);
    sh(repo.clone, 'git', ['push', 'origin', 'aom/toy-10']);
    recordPushed(ledger, repo, 'aom/toy-10');
    sh(repo.clone, 'git', ['checkout', 'main']);
    const other = join(tmp(), 'other');
    sh(repo.root, 'git', ['clone', repo.origin, other]);
    sh(other, 'git', ['checkout', 'aom/toy-10']);
    writeFileSync(join(other, 'fixup.txt'), 'f\n');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', 'fixup']);
    sh(other, 'git', ['push', 'origin', 'aom/toy-10']);
    const tip = sh(repo.origin, 'git', ['rev-parse', 'aom/toy-10']);
    const { result } = await hygieneRepo(
      spec(repo, [card(10, 'aom/toy-10', { prUrl: 'https://h/pull/10' })]),
      [],
      {
        ledger,
        changeState: async () => 'merged',
      },
    );
    expect(result.cleaned).toEqual([
      expect.objectContaining({ origin: true, local: false, worktree: false }),
    ]);
    expect(savedRefs(repo)).toEqual([`refs/guildwise/saved/aom/toy-10-${tip.slice(0, 7)} ${tip}`]);
    expect(localHeads(repo)).toContain('aom/toy-10');
    expect(result.actions.join('\n')).toContain('aom/toy-10 kept in the clone');
  });

  it('(c) the local branch contains the origin tip: no saved ref, origin removed', async () => {
    const repo = makeRepo();
    const ledger = newLedger();
    sh(repo.clone, 'git', ['checkout', '-b', 'aom/toy-11']);
    writeFileSync(join(repo.clone, 'c.txt'), 'c\n');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'c']);
    sh(repo.clone, 'git', ['push', 'origin', 'aom/toy-11']);
    recordPushed(ledger, repo, 'aom/toy-11');
    sh(repo.clone, 'git', ['checkout', 'main']);
    const { result } = await hygieneRepo(
      spec(repo, [card(11, 'aom/toy-11', { prUrl: 'https://h/pull/11' })]),
      [],
      {
        ledger,
        changeState: async () => 'merged',
      },
    );
    expect(result.cleaned).toEqual([expect.objectContaining({ origin: true, local: false })]);
    expect(savedRefs(repo)).toEqual([]);
    expect(originHeads(repo)).toEqual(['main']);
    expect(localHeads(repo)).toContain('aom/toy-11');
  });
});

describe('T1: the ledger records only what the runner made or pushed', () => {
  const BRANCH = 'aom/toy-1-add-thing';
  async function cardWorktree(ledger: BranchLedger, repo = makeRepo()) {
    const path = join(tmp(), 'wt');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: U,
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'main',
        branchName: BRANCH,
      },
      defaultPath: path,
      ledger,
    });
    writeFileSync(join(path, 'thing.txt'), 'thing\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'add thing']);
    return { repo, path };
  }
  const payload = (repo: TestRepo, path: string, over: Partial<FinalizeExecutePayload> = {}) =>
    ({
      cardId: CARD(1),
      ref: 'TOY-1',
      title: 'Add thing',
      projectKey: 'TOY',
      action: 'pr',
      repoId: U,
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'main',
      branchName: BRANCH,
      worktreePath: path,
      ...over,
    }) as FinalizeExecutePayload;
  const run = (repo: TestRepo, p: FinalizeExecutePayload, ledger: BranchLedger) =>
    executeCompletion({
      payload: p,
      repoPath: repo.clone,
      worktreePath: p.worktreePath as string,
      worktreesDir: '/',
      integrationDir: join(tmp(), 'integration'),
      pr: { create: async () => ({}) },
      ledger,
    });

  it('a created card branch and a pull request branch whose name was free are recorded, with the pushed sha', async () => {
    const ledger = newLedger();
    const { repo, path } = await cardWorktree(ledger);
    expect(ledger.has(repo.remoteNormalized, BRANCH)).toBe(true);
    const res = await run(repo, payload(repo, path, { prBranchPrefix: 'pieter', ticket: 'DCPL-1' }), ledger);
    expect(res).toMatchObject({ ok: true, pushedBranch: 'pieter/DCPL-1' });
    expect(ledger.pushedSha(repo.remoteNormalized, 'pieter/DCPL-1')).toBe(
      sh(path, 'git', ['rev-parse', 'HEAD']),
    );
  });

  it('a server-named pull request branch that already exists on origin and is not in the ledger is not recorded', async () => {
    const ledger = newLedger();
    const { repo, path } = await cardWorktree(ledger);
    // a person's branch of that name: the push fast-forwards it, but the runner never claims it
    sh(repo.clone, 'git', ['push', 'origin', 'main:refs/heads/alice/work']);
    const res = await run(repo, payload(repo, path, { remoteBranch: 'alice/work' }), ledger);
    expect(res).toMatchObject({ ok: true, pushedBranch: 'alice/work' });
    expect(ledger.pushedSha(repo.remoteNormalized, 'alice/work')).toBeNull();
  });

  it('a ledger that cannot be written never fails the push', async () => {
    const blocker = join(tmp(), 'a-file');
    writeFileSync(blocker, 'x');
    const bad = new BranchLedger(join(blocker, 'sub', 'card-branches.json')); // a file where its folder should be
    const { repo, path } = await cardWorktree(bad);
    const res = await run(repo, payload(repo, path, { prBranchPrefix: 'pieter', ticket: 'DCPL-2' }), bad);
    expect(res).toMatchObject({ ok: true, pushedBranch: 'pieter/DCPL-2' });
  });
});
