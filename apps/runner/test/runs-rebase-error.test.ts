import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockRetry } from '../src/git/git.ts';
import { runnerPaths } from '../src/paths.ts';
import { RunManager } from '../src/runs/manager.ts';
import { ServiceLauncher } from '../src/runs/sandbox.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const savedDelays = lockRetry.delaysMs;
beforeEach(() => {
  lockRetry.delaysMs = [];
});
afterEach(() => {
  lockRetry.delaysMs = savedDelays;
});

function cardWorktree(repo: ReturnType<typeof makeRepo>, worktrees: string) {
  const dir = join(worktrees, 'TOY-aaaaaaaa', 'TOY-1');
  mkdirSync(join(worktrees, 'TOY-aaaaaaaa'), { recursive: true });
  sh(repo.clone, 'git', ['worktree', 'add', '-b', 'aom/toy-1-card', dir, 'main']);
  writeFileSync(join(dir, 'card.txt'), 'card\n');
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-m', 'card work']);
  return dir;
}

function moveMain(repo: ReturnType<typeof makeRepo>, file: string, body: string) {
  writeFileSync(join(repo.clone, file), body);
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', `main moves: ${file}`]);
  sh(repo.clone, 'git', ['push', 'origin', 'main']);
}

describe('a test environment for a card: rebase no-op and rebase errors (run preparation path)', () => {
  const running: RunManager[] = [];
  afterEach(async () => {
    for (const m of running.splice(0)) {
      for (const id of m.liveEnvIds()) await m.stop({ envId: id, reason: 'failed' });
      m.shutdown();
    }
  });

  function manager() {
    const repo = makeRepo();
    const paths = runnerPaths(tmp());
    mkdirSync(paths.worktrees, { recursive: true });
    const sent: Array<{ type: string; payload: Record<string, any> }> = [];
    const mgr = new RunManager({
      paths,
      findRepo: async () => ({ localPath: repo.clone }),
      send: (type, payload) => sent.push({ type, payload }),
      log: { info() {}, warn() {}, error() {} },
      maxEnvironments: () => 3,
      launcher: new ServiceLauncher({ noScope: true }),
      portRange: () => ({ from: 44000, to: 44400 }),
      timing: { waitMs: 8000, healthPollMs: 40, superviseMs: 80, logFlushMs: 60, stopGraceMs: 400 },
    });
    running.push(mgr);
    const repoId = randomUUID();
    const payload = (cardWorktreePath: string) => ({
      envId: randomUUID(),
      projectId: randomUUID(),
      projectKey: 'TOY',
      projectName: 'Toy',
      purpose: 'test' as const,
      requestId: randomUUID(),
      sources: [
        { repoId, name: 'toy', remoteUrlNormalized: repo.remoteNormalized, branch: 'aom/toy-1-card' },
      ],
      services: [],
      portRange: { from: 44000, to: 44400 },
      ttlAt: new Date(Date.now() + 3600_000).toISOString(),
      allowDocker: false,
      rebaseCard: { repoId, baseBranch: 'main', cardWorktreePath },
    });
    const lastStatus = (envId: string) =>
      [...sent].reverse().find((s) => s.type === 'run.status' && s.payload.envId === envId)?.payload;
    return { repo, paths, mgr, payload, lastStatus };
  }

  it('a card branch that already contains its base starts without rebasing; the head is unchanged', async () => {
    const m = manager();
    const wt = cardWorktree(m.repo, m.paths.worktrees);
    writeFileSync(join(wt, '.bashrc'), 'export A=1\n');
    const before = sh(wt, 'git', ['rev-parse', 'HEAD']);
    const p = m.payload(wt);
    expect(await m.mgr.startEnv(p)).toEqual({ ok: true });
    expect(sh(wt, 'git', ['rev-parse', 'HEAD'])).toBe(before);
    expect(sh(wt, 'git', ['status', '--porcelain'])).toBe('?? .bashrc');
    expect(m.lastStatus(p.envId)?.rebaseError).toBeUndefined();
  });

  it('a held index.lock fails the start with rebaseError, never rebaseConflictFiles', async () => {
    const m = manager();
    const wt = cardWorktree(m.repo, m.paths.worktrees);
    moveMain(m.repo, 'later.txt', 'main moved\n');
    const before = sh(wt, 'git', ['rev-parse', 'HEAD']);
    const lock = resolve(wt, sh(wt, 'git', ['rev-parse', '--git-path', 'index.lock']));
    writeFileSync(lock, '');
    const p = m.payload(wt);
    const r = await m.mgr.startEnv(p);
    rmSync(lock, { force: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/rebase onto origin\/main failed: git rebase origin\/main exited/);
    expect(r.error).not.toMatch(/conflict/i);
    const last = m.lastStatus(p.envId);
    expect(last).toMatchObject({ state: 'failed', endReason: 'failed' });
    expect(last?.rebaseConflictFiles).toBeUndefined();
    expect(last?.rebaseError).toMatchObject({ baseRef: 'origin/main', command: 'git rebase origin/main' });
    expect(last?.rebaseError.exitCode).not.toBe(0);
    expect(last?.rebaseError.stderr).toMatch(/index\.lock/);
    expect(sh(wt, 'git', ['rev-parse', 'HEAD'])).toBe(before);
    expect(existsSync(resolve(wt, sh(wt, 'git', ['rev-parse', '--git-path', 'rebase-merge'])))).toBe(false);
  });
});
