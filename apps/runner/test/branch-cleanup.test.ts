import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HygieneRepoSpec } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hygieneRepo } from '../src/devops/hygiene.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

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
const card = (n: number, branch: string, prUrl?: string, remoteBranch?: string): Card => ({
  cardId: CARD(n),
  ref: `TOY-${n}`,
  branch,
  ...(prUrl ? { prUrl } : {}),
  ...(remoteBranch ? { remoteBranch } : {}),
});

/** A card branch with one commit, pushed to origin (as `pr` / `push_branch` do), back on main in the clone. */
function pushedBranch(repo: TestRepo, branch: string, file: string) {
  sh(repo.clone, 'git', ['checkout', '-b', branch, 'main']);
  writeFileSync(join(repo.clone, file), `${file}\n`);
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', `add ${file}`]);
  sh(repo.clone, 'git', ['push', '-u', 'origin', branch]);
  sh(repo.clone, 'git', ['checkout', 'main']);
}
const originHeads = (repo: TestRepo) =>
  sh(repo.origin, 'git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n');
const localHeads = (repo: TestRepo) =>
  sh(repo.clone, 'git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).split('\n');

describe('hygiene removes the branches of finished cards', () => {
  it.each([
    ['guildwise/', 'guildwise/toy-1-a'],
    ['aom/', 'aom/toy-1-a'],
    ['guildwise/', 'aom/toy-1-a'],
    ['aom/', 'guildwise/toy-1-a'],
    ['aom/', 'guildwise/integration/toy-1'],
    ['guildwise/', 'aom-integration/toy-1'],
  ])(
    'recognises the branch under both the new and the legacy names (project prefix %s, branch %s)',
    async (prefix, branch) => {
      const repo = makeRepo();
      pushedBranch(repo, branch, 'a.txt');
      sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge a', branch]);
      const { result } = await hygieneRepo(spec(repo, [card(1, branch)], { branchPrefix: prefix }));
      expect(result.cleaned.map((c) => c.branch)).toEqual([branch]);
      expect(localHeads(repo)).not.toContain(branch);
    },
  );

  it('deletes a merged branch from origin and the clone, and says why', async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-1-a', 'a.txt');
    sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge a', 'aom/toy-1-a']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const { result, commands } = await hygieneRepo(spec(repo, [card(1, 'aom/toy-1-a')]));
    expect(result.problem).toBeNull();
    expect(result.cleaned).toEqual([
      expect.objectContaining({
        cardId: CARD(1),
        branch: 'aom/toy-1-a',
        reason: 'merged into main',
        origin: true,
        local: true,
      }),
    ]);
    expect(originHeads(repo)).toEqual(['main']);
    expect(localHeads(repo)).toEqual(['main']);
    expect(result.actions.join('\n')).toContain('removed 1 finished card branch(es): aom/toy-1-a');
    expect(commands.join('\n')).toContain('push --delete origin aom/toy-1-a');
  });

  it('deletes a migrated branch (rebased onto the working branch, so not an ancestor)', async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-2-b', 'b.txt');
    // the same patch lands on main as a new commit (cherry-pick), then main moves on
    writeFileSync(join(repo.clone, 'earlier.txt'), 'earlier\n');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'earlier']);
    sh(repo.clone, 'git', ['cherry-pick', 'aom/toy-2-b']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const { result } = await hygieneRepo(spec(repo, [card(2, 'aom/toy-2-b')]));
    expect(result.cleaned[0]).toMatchObject({ branch: 'aom/toy-2-b', origin: true, local: true });
    expect(result.cleaned[0]?.reason).toContain('rebased or cherry-picked');
    expect(originHeads(repo)).toEqual(['main']);
  });

  it('keeps a branch with a commit found nowhere else, and a branch that is not a Guildwise one', async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-3-c', 'c.txt');
    pushedBranch(repo, 'feature/mine', 'm.txt');
    sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge', 'feature/mine']); // merged, but not ours
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const { result } = await hygieneRepo(
      spec(repo, [card(3, 'aom/toy-3-c'), card(4, 'feature/mine'), card(5, 'main')]),
    );
    expect(result.cleaned).toEqual([]);
    expect(originHeads(repo).sort()).toEqual(['aom/toy-3-c', 'feature/mine', 'main']);
    expect(localHeads(repo).sort()).toEqual(['aom/toy-3-c', 'feature/mine', 'main']);
  });

  it('keeps a branch that is not in the finished list (an open or reopened card), even when merged', async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-6-d', 'd.txt');
    sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge d', 'aom/toy-6-d']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const { result } = await hygieneRepo(spec(repo, []));
    expect(result.cleaned).toEqual([]);
    expect(originHeads(repo)).toContain('aom/toy-6-d');
  });

  it('uses the pull request: merged releases the branch, open and declined (with unmerged commits) keep it, unknown falls back to the commits', async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-7-merged', '7.txt'); // squash-merged on the host: not in main's history
    pushedBranch(repo, 'aom/toy-8-open', '8.txt');
    pushedBranch(repo, 'aom/toy-9-declined', '9.txt');
    pushedBranch(repo, 'aom/toy-10-unknown', '10.txt');
    const states: Record<string, 'open' | 'merged' | 'closed' | null> = {
      'https://h/pull/7': 'merged',
      'https://h/pull/8': 'open',
      'https://h/pull/9': 'closed',
      'https://h/pull/10': null,
    };
    const asked: string[] = [];
    const { result } = await hygieneRepo(
      spec(repo, [
        card(7, 'aom/toy-7-merged', 'https://h/pull/7'),
        card(8, 'aom/toy-8-open', 'https://h/pull/8'),
        card(9, 'aom/toy-9-declined', 'https://h/pull/9'),
        card(10, 'aom/toy-10-unknown', 'https://h/pull/10'),
      ]),
      [],
      {
        changeState: async (q) => {
          asked.push(q.prUrl);
          return states[q.prUrl] ?? null;
        },
      },
    );
    expect(result.cleaned.map((c) => [c.branch, c.reason]).sort()).toEqual([
      ['aom/toy-7-merged', 'its pull request was merged'],
    ]);
    expect(result.actions).toContain('aom/toy-9-declined kept: pull request declined, has unmerged commits');
    expect(originHeads(repo).sort()).toEqual([
      'aom/toy-10-unknown',
      'aom/toy-8-open',
      'aom/toy-9-declined',
      'main',
    ]);
    expect(asked).toHaveLength(4);
  });

  it('a declined pull request still releases a branch whose commits are already in the working branch', async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-12-f', 'f.txt');
    sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge f', 'aom/toy-12-f']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const { result } = await hygieneRepo(spec(repo, [card(12, 'aom/toy-12-f', 'https://h/pull/12')]), [], {
      changeState: async () => 'closed',
    });
    expect(result.cleaned.map((c) => c.branch)).toEqual(['aom/toy-12-f']);
    expect(result.cleaned[0]?.reason).toMatch(/merged into/);
  });

  it('an open pull request keeps the branch even when its commits are already in the working branch', async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-11-e', 'e.txt');
    sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge e', 'aom/toy-11-e']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const { result } = await hygieneRepo(spec(repo, [card(11, 'aom/toy-11-e', 'https://h/pull/11')]), [], {
      changeState: async () => 'open',
    });
    expect(result.cleaned).toEqual([]);
    expect(originHeads(repo)).toContain('aom/toy-11-e');
  });

  it('removes a local-only merged branch together with its card worktree; a worktree with edits keeps the branch', async () => {
    const repo = makeRepo();
    const wtA = join(tmp(), 'wt-a');
    const wtB = join(tmp(), 'wt-b');
    for (const [branch, path, file] of [
      ['aom/toy-12-f', wtA, 'f.txt'],
      ['aom/toy-13-g', wtB, 'g.txt'],
    ] as const) {
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
      writeFileSync(join(path, file), `${file}\n`);
      sh(path, 'git', ['add', '-A']);
      sh(path, 'git', ['commit', '-m', file]);
      sh(repo.clone, 'git', ['merge', '--no-ff', '-m', `merge ${file}`, branch]);
    }
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    writeFileSync(join(wtB, 'wip.txt'), 'unsaved\n'); // someone left edits in the second worktree
    const { result } = await hygieneRepo(spec(repo, [card(12, 'aom/toy-12-f'), card(13, 'aom/toy-13-g')]));
    expect(result.cleaned).toEqual([
      expect.objectContaining({ branch: 'aom/toy-12-f', worktree: true, local: true, origin: false }),
    ]);
    expect(existsSync(wtA)).toBe(false);
    expect(existsSync(wtB)).toBe(true);
    expect(localHeads(repo)).toContain('aom/toy-13-g');
    expect(result.actions.join('\n')).toContain('aom/toy-13-g kept');
    expect(originHeads(repo)).toEqual(['main']); // never pushed in the first place
  });

  it('does not touch a worktree with a running shift', async () => {
    const repo = makeRepo();
    const wt = join(tmp(), 'wt-run');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: U,
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'main',
        branchName: 'aom/toy-14-h',
      },
      defaultPath: wt,
    });
    const { result } = await hygieneRepo(spec(repo, [card(14, 'aom/toy-14-h')]), [wt]);
    // the whole repository is deferred while a shift runs in it
    expect(result.cleaned).toEqual([]);
    expect(localHeads(repo)).toContain('aom/toy-14-h');
  });

  it('only a lease-matching origin branch is deleted: a push after the fetch keeps it', async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-15-i', 'i.txt');
    sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge i', 'aom/toy-15-i']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    // somebody pushes more work to the card branch from another clone
    const other = join(tmp(), 'other');
    sh(repo.root, 'git', ['clone', repo.origin, other]);
    sh(other, 'git', ['checkout', 'aom/toy-15-i']);
    writeFileSync(join(other, 'extra.txt'), 'x');
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', 'extra work']);
    sh(other, 'git', ['push', 'origin', 'aom/toy-15-i']);
    // the fetch inside the run sees it: the extra commit is not in main, so the branch stays
    const { result } = await hygieneRepo(spec(repo, [card(15, 'aom/toy-15-i')]));
    expect(result.cleaned).toEqual([]);
    expect(originHeads(repo)).toContain('aom/toy-15-i');
  });
});

describe('a reopened card gets its branch back', () => {
  it('recreates a deleted card branch from the working branch on the next shift (reuse mode)', async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-16-j', 'j.txt');
    sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge j', 'aom/toy-16-j']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const { result } = await hygieneRepo(spec(repo, [card(16, 'aom/toy-16-j')]));
    expect(result.cleaned).toHaveLength(1);
    expect(localHeads(repo)).toEqual(['main']);

    const path = join(tmp(), 'wt-reopen');
    const w = await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'reuse',
        repoId: U,
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'main',
        branchName: 'aom/toy-16-j',
        path,
      },
      defaultPath: path,
    });
    expect(w.created).toBe(true);
    expect(sh(path, 'git', ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('aom/toy-16-j');
    expect(existsSync(join(path, 'j.txt'))).toBe(true); // it starts from the working branch, which has the old work
  });

  it('takes the branch back from origin when only the local copy is gone', async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-17-k', 'k.txt');
    sh(repo.clone, 'git', ['branch', '-D', 'aom/toy-17-k']);
    const path = join(tmp(), 'wt-origin');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'reuse',
        repoId: U,
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'main',
        branchName: 'aom/toy-17-k',
        path,
      },
      defaultPath: path,
    });
    expect(existsSync(join(path, 'k.txt'))).toBe(true);
  });
});

describe('hygiene removes the pull request branch by its stored name only', () => {
  it("deletes pieter/TOY-1 (stored for the card) and leaves the user's other pieter/* branches alone", async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-1-a', 'a.txt');
    sh(repo.clone, 'git', ['push', 'origin', 'aom/toy-1-a:refs/heads/pieter/TOY-1']);
    sh(repo.clone, 'git', ['push', 'origin', 'aom/toy-1-a:refs/heads/pieter/mine']);
    sh(repo.clone, 'git', ['push', 'origin', '--delete', 'aom/toy-1-a']);
    sh(repo.clone, 'git', ['merge', '--no-ff', '-m', 'merge a', 'aom/toy-1-a']);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const { result } = await hygieneRepo(spec(repo, [card(1, 'aom/toy-1-a', undefined, 'pieter/TOY-1')]));
    expect(result.problem).toBeNull();
    expect(originHeads(repo)).not.toContain('pieter/TOY-1');
    expect(originHeads(repo)).toContain('pieter/mine');
    expect(localHeads(repo)).not.toContain('aom/toy-1-a');
    expect(result.cleaned[0]).toMatchObject({ ref: 'TOY-1', origin: true });
  });

  it('keeps an unmerged pull request branch', async () => {
    const repo = makeRepo();
    pushedBranch(repo, 'aom/toy-2-b', 'b.txt');
    sh(repo.clone, 'git', ['push', 'origin', 'aom/toy-2-b:refs/heads/pieter/TOY-2']);
    const { result } = await hygieneRepo(spec(repo, [card(2, 'aom/toy-2-b', undefined, 'pieter/TOY-2')]));
    expect(result.cleaned).toEqual([]);
    expect(originHeads(repo)).toContain('pieter/TOY-2');
  });
});
