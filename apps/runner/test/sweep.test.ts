import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sweepWorktrees } from '../src/git/sweep.ts';
import { startHarness } from './harness.ts';
import { cleanupTmp, makeRepo, sh, tmp, waitUntil } from './helpers.ts';

cleanupTmp();

/** A card worktree at `<worktrees>/<proj>/<ref>` on a fresh branch of the clone. */
function cardWorktree(repo: ReturnType<typeof makeRepo>, worktrees: string, proj: string, ref: string) {
  const path = join(worktrees, proj, ref);
  mkdirSync(join(worktrees, proj), { recursive: true });
  sh(repo.clone, 'git', ['worktree', 'add', '-b', `aom/${ref.toLowerCase()}`, path, 'main']);
  return path;
}

const liveSet =
  (...paths: string[]) =>
  async () =>
    new Set(paths);

describe('stale worktree sweep', () => {
  it('removes a dead clean worktree, keeps a live one, and removes the emptied project folder', async () => {
    const repo = makeRepo();
    const worktrees = join(tmp(), 'worktrees');
    const dead = cardWorktree(repo, worktrees, 'TOY-aaaaaaaa', 'TOY-1');
    const live = cardWorktree(repo, worktrees, 'TOY-bbbbbbbb', 'TOY-2');
    const r = await sweepWorktrees({
      worktreesDir: worktrees,
      liveOf: liveSet(live),
      repoPaths: [repo.clone],
    });
    expect(r).toMatchObject({ scanned: 2, kept: 1, removed: [dead], dirty: [] });
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(r.emptyDirsRemoved).toEqual([join(worktrees, 'TOY-aaaaaaaa')]);
    // the registration is gone as well, and the branch is kept for the BA's report
    expect(sh(repo.clone, 'git', ['worktree', 'list'])).not.toContain('TOY-1');
    expect(sh(repo.clone, 'git', ['branch', '--list', 'aom/toy-1'])).toContain('aom/toy-1');
  });

  it('never deletes a live worktree with uncommitted changes', async () => {
    const repo = makeRepo();
    const worktrees = join(tmp(), 'worktrees');
    const live = cardWorktree(repo, worktrees, 'TOY-aaaaaaaa', 'TOY-1');
    writeFileSync(join(live, 'wip.txt'), 'not committed');
    const r = await sweepWorktrees({ worktreesDir: worktrees, liveOf: liveSet(live) });
    expect(r.removed).toEqual([]);
    expect(existsSync(join(live, 'wip.txt'))).toBe(true);
  });

  it('reports a dead card worktree with uncommitted changes and does not delete it', async () => {
    const repo = makeRepo();
    const worktrees = join(tmp(), 'worktrees');
    const dead = cardWorktree(repo, worktrees, 'TOY-aaaaaaaa', 'TOY-1');
    writeFileSync(join(dead, 'wip.txt'), 'forgotten');
    writeFileSync(join(dead, 'README.md'), '# changed\n');
    const r = await sweepWorktrees({ worktreesDir: worktrees, liveOf: liveSet(), repoPaths: [repo.clone] });
    expect(r.removed).toEqual([]);
    expect(r.dirty).toHaveLength(1);
    expect(r.dirty[0]).toMatchObject({ path: dead, branch: 'aom/toy-1' });
    expect(r.dirty[0]?.files).toEqual(expect.arrayContaining(['wip.txt', 'README.md']));
    expect(existsSync(join(dead, 'wip.txt'))).toBe(true);
    expect(existsSync(join(worktrees, 'TOY-aaaaaaaa'))).toBe(true);
  });

  it('leaves the worktree of a running shift alone, whatever the server says', async () => {
    const repo = makeRepo();
    const worktrees = join(tmp(), 'worktrees');
    const busy = cardWorktree(repo, worktrees, 'TOY-aaaaaaaa', 'TOY-1');
    const r = await sweepWorktrees({ worktreesDir: worktrees, liveOf: liveSet(), busyPaths: [busy] });
    expect(r).toMatchObject({ removed: [], kept: 1 });
    expect(existsSync(busy)).toBe(true);
  });

  it('removes nothing without an answer from the server, or while messages are still queued', async () => {
    const repo = makeRepo();
    const worktrees = join(tmp(), 'worktrees');
    const dead = cardWorktree(repo, worktrees, 'TOY-aaaaaaaa', 'TOY-1');
    const silent = await sweepWorktrees({ worktreesDir: worktrees, liveOf: async () => null });
    expect(silent.skipped).toContain('did not answer');
    const queued = await sweepWorktrees({ worktreesDir: worktrees, liveOf: liveSet(), outboxPending: 2 });
    expect(queued.skipped).toContain('queued');
    expect(existsSync(dead)).toBe(true);
  });

  it('removes empty project folders and runs git worktree prune for a deleted worktree directory', async () => {
    const repo = makeRepo();
    const worktrees = join(tmp(), 'worktrees');
    mkdirSync(join(worktrees, 'EMPTY-cccccccc'), { recursive: true });
    const gone = cardWorktree(repo, worktrees, 'TOY-aaaaaaaa', 'TOY-1');
    const live = cardWorktree(repo, worktrees, 'TOY-aaaaaaaa', 'TOY-2');
    // someone deleted the directory by hand: git still lists the worktree until it is pruned
    sh(worktrees, 'rm', ['-rf', gone]);
    expect(sh(repo.clone, 'git', ['worktree', 'list'])).toContain('TOY-1');
    const r = await sweepWorktrees({
      worktreesDir: worktrees,
      liveOf: liveSet(live),
      repoPaths: [repo.clone],
    });
    expect(r.emptyDirsRemoved).toEqual([join(worktrees, 'EMPTY-cccccccc')]);
    expect(r.pruned).toBeGreaterThanOrEqual(1);
    expect(sh(repo.clone, 'git', ['worktree', 'list'])).not.toContain('TOY-1');
    expect(existsSync(live)).toBe(true);
  });

  it('does not touch a non-empty folder that is not a worktree', async () => {
    const worktrees = join(tmp(), 'worktrees');
    const odd = join(worktrees, 'TOY-aaaaaaaa', 'notes');
    mkdirSync(odd, { recursive: true });
    writeFileSync(join(odd, 'a.txt'), 'x');
    const r = await sweepWorktrees({ worktreesDir: worktrees, liveOf: liveSet() });
    expect(r.removed).toEqual([]);
    expect(existsSync(join(odd, 'a.txt'))).toBe(true);
  });

  it('copes with a worktrees directory that does not exist', async () => {
    const r = await sweepWorktrees({ worktreesDir: join(tmp(), 'nope'), liveOf: liveSet() });
    expect(r).toMatchObject({ scanned: 0, removed: [] });
  });
});

describe('runner start-up sweep', () => {
  it('asks the server which worktrees are live after connecting and removes the dead ones', async () => {
    const repo = makeRepo();
    let live: string[] = [];
    const h = await startHarness({ worktreesLive: () => live }, { startupSweepMs: 20 }, repo);
    try {
      // Leave a dead and a live worktree and sweep. The start-up sweep (20 ms after connecting) may run first on a
      // slow machine and remove the dead one itself, so the assertions do not depend on which sweep did it.
      const wt = join(h.dataDir, 'worktrees');
      const dead = cardWorktree(repo, wt, 'TOY-aaaaaaaa', 'TOY-1');
      const keep = cardWorktree(repo, wt, 'TOY-aaaaaaaa', 'TOY-2');
      live = [keep];
      await h.runner.sweepWorktrees();
      expect(existsSync(dead)).toBe(false);
      expect(existsSync(keep)).toBe(true);
      // The server was asked about the candidates, as absolute paths (never about the live one's removal).
      const asked = h.server.of('worktrees.query').flatMap((q) => q.paths);
      expect(asked).toContain(dead);
      expect(asked).toContain(keep);
      expect(asked.every((p) => p.startsWith('/'))).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it('sweeps by itself shortly after the first connection', async () => {
    const repo = makeRepo();
    const worktrees = tmp('aom-data-');
    const dead = cardWorktree(repo, join(worktrees, 'worktrees'), 'TOY-aaaaaaaa', 'TOY-1');
    const { Runner } = await import('../src/runner.ts');
    const { FakeServer } = await import('./fake-server.ts');
    const { makeConfig } = await import('./helpers.ts');
    const server = await FakeServer.start({ worktreesLive: () => [] });
    const runner = new Runner({
      config: makeConfig(server.url, { repoRoots: [repo.scanRoot] }),
      dataDir: worktrees,
      startupSweepMs: 20,
    });
    await runner.start();
    try {
      await waitUntil(() => !existsSync(dead), 10_000, 'the dead worktree is swept');
      expect(server.of('worktrees.query')).toHaveLength(1);
    } finally {
      await runner.stop();
      await server.close();
    }
  });

  it('a server that never answers leaves every worktree alone', async () => {
    const repo = makeRepo();
    const h = await startHarness({}, { startupSweepMs: -1, sweepAnswerMs: 100 }, repo);
    try {
      const dead = cardWorktree(repo, join(h.dataDir, 'worktrees'), 'TOY-aaaaaaaa', 'TOY-1');
      const r = await h.runner.sweepWorktrees();
      expect(r.skipped).toContain('did not answer');
      expect(existsSync(dead)).toBe(true);
    } finally {
      await h.stop();
    }
  });
});
