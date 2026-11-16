import { realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type RepoReport, RepoSyncStatusSchema } from '@aom/shared';
import { describe, expect, it, vi } from 'vitest';
import { git } from '../src/git/git.ts';
import { type SyncResult, safeSyncText, syncWorkingBranch } from '../src/git/sync-branch.ts';
import { SyncService, type SyncStatusReport, toRepoSyncStatus } from '../src/git/sync-service.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

cleanupTmp();

/** origin with `main` and `work`; the clone is on `main`; a second clone pushes to `work`. */
function setup() {
  const repo = makeRepo();
  sh(repo.clone, 'git', ['checkout', '-b', 'work']);
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'work']);
  sh(repo.clone, 'git', ['checkout', 'main']);
  const other = join(tmp(), 'other');
  sh(repo.root, 'git', ['clone', repo.origin, other]);
  const pushWork = (file: string) => {
    sh(other, 'git', ['fetch', 'origin']);
    sh(other, 'git', ['checkout', '-B', 'work', 'origin/work']);
    writeFileSync(join(other, file), file);
    sh(other, 'git', ['add', '-A']);
    sh(other, 'git', ['commit', '-m', file]);
    sh(other, 'git', ['push', 'origin', 'work']);
  };
  const tip = (ref: string) => sh(repo.clone, 'git', ['rev-parse', ref]).trim();
  return { repo, pushWork, tip };
}

describe('syncWorkingBranch', () => {
  it('moves the ref when the branch is not checked out and local is an ancestor', async () => {
    const { repo, pushWork, tip } = setup();
    pushWork('a.txt');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r).toMatchObject({
      state: 'updated',
      ahead: 0,
      behind: 0,
      onBranch: false,
      checkedOutBranch: 'main',
    });
    expect(tip('work')).toBe(tip('origin/work'));
  });

  it('fast-forwards the checkout when it is on the branch and clean', async () => {
    const { repo, pushWork, tip } = setup();
    sh(repo.clone, 'git', ['checkout', 'work']);
    pushWork('b.txt');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r).toMatchObject({ state: 'updated', onBranch: true, dirty: false });
    expect(tip('HEAD')).toBe(tip('origin/work'));
  });

  it('fast-forwards past unrelated local changes (an untracked file) and keeps them', async () => {
    const { repo, pushWork, tip } = setup();
    sh(repo.clone, 'git', ['checkout', 'work']);
    pushWork('c.txt');
    writeFileSync(join(repo.clone, 'mine.txt'), 'wip');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r).toMatchObject({ state: 'updated', behind: 0, dirty: true, onBranch: true });
    expect(tip('HEAD')).toBe(tip('origin/work'));
    expect(sh(repo.clone, 'git', ['status', '--short'])).toContain('mine.txt');
  });

  it('leaves the checkout alone when a local change would be overwritten, and names the file', async () => {
    const { repo, pushWork, tip } = setup();
    sh(repo.clone, 'git', ['checkout', 'work']);
    const before = tip('HEAD');
    pushWork('c.txt');
    writeFileSync(join(repo.clone, 'c.txt'), 'my own version');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r).toMatchObject({ state: 'dirty', behind: 1, dirty: true, onBranch: true });
    expect(r.detail).toContain('c.txt');
    expect(tip('HEAD')).toBe(before);
  });

  it('does nothing when diverged', async () => {
    const { repo, pushWork, tip } = setup();
    sh(repo.clone, 'git', ['checkout', 'work']);
    writeFileSync(join(repo.clone, 'local.txt'), 'x');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'local']);
    const before = tip('HEAD');
    pushWork('d.txt');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r).toMatchObject({ state: 'diverged', ahead: 1, behind: 1 });
    expect(tip('HEAD')).toBe(before);
  });

  it('reports synced and ahead', async () => {
    const { repo } = setup();
    expect((await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' })).state).toBe('synced');
    sh(repo.clone, 'git', ['checkout', 'work']);
    writeFileSync(join(repo.clone, 'l.txt'), 'x');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'l']);
    expect(await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' })).toMatchObject({
      state: 'ahead',
      ahead: 1,
    });
  });

  it('defers while a card shift works in the repository', async () => {
    const { repo, pushWork, tip } = setup();
    const wt = join(tmp(), 'wt');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'work',
        branchName: 'aom/TOY-1',
      },
      defaultPath: wt,
    });
    const before = tip('work');
    pushWork('e.txt');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work', busyWorktrees: [wt] });
    expect(r).toMatchObject({ state: 'busy', behind: 1 });
    expect(tip('work')).toBe(before);
    const again = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(again.state).toBe('updated');
  });

  it('leaves a branch checked out in another worktree alone; a stale expected value is refused', async () => {
    const { repo, pushWork, tip } = setup();
    const wt = join(tmp(), 'wt2');
    sh(repo.clone, 'git', ['worktree', 'add', wt, 'work']);
    pushWork('f.txt');
    const before = tip('work');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r.state).toBe('behind');
    expect(tip('work')).toBe(before);
    const stale = await git(repo.clone, [
      'update-ref',
      'refs/heads/work',
      tip('origin/work'),
      tip('origin/work'),
    ]);
    expect(stale.exitCode).not.toBe(0);
  });

  it('without an origin it says so', async () => {
    const dir = tmp();
    sh(dir, 'git', ['init', '-b', 'work']);
    expect((await syncWorkingBranch({ repoPath: dir, workingBranch: 'work' })).state).toBe('no_remote');
  });
});

/** The branch tip in the clone, or '' when there is no such branch. */
const tipOf = (dir: string, ref: string) => {
  try {
    return sh(dir, 'git', ['rev-parse', '--verify', '--quiet', ref]);
  } catch {
    return '';
  }
};

/** A result that left the branch unchanged has a non-empty code and message. */
function expectReason(r: SyncResult, reason: string): void {
  expect(r.reason).toBe(reason);
  expect(r.reasonMessage?.trim().length ?? 0).toBeGreaterThan(0);
}

describe('syncWorkingBranch reasons', () => {
  it('checked out in another worktree: names the worktree and leaves the tip', async () => {
    const { repo, pushWork, tip } = setup();
    const wt = join(tmp(), 'wt2');
    sh(repo.clone, 'git', ['worktree', 'add', wt, 'work']);
    pushWork('f.txt');
    const before = tip('work');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work', home: '/nowhere-home' });
    expect(r.state).toBe('behind');
    expectReason(r, 'checked-out-elsewhere');
    expect(r.reasonMessage).toContain(realpathSync(wt));
    expect(r.detail).toBe('work is checked out in another worktree; it is left alone');
    expect(tip('work')).toBe(before);
  });

  it('checked out in another worktree: a path inside the home is shown as ~', async () => {
    const { repo, pushWork } = setup();
    const wt = join(tmp(), 'wt2');
    sh(repo.clone, 'git', ['worktree', 'add', wt, 'work']);
    pushWork('f.txt');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work', home: dirname(wt) });
    expectReason(r, 'checked-out-elsewhere');
    expect(r.reasonMessage).toContain('(~/wt2)');
    expect(r.reasonMessage).not.toContain(realpathSync(dirname(wt)));
  });

  it('unsafe branch name', async () => {
    const { repo } = setup();
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'a..b' });
    expect(r.state).toBe('error');
    expectReason(r, 'unsafe-branch');
  });

  it('no clone: the home is masked in the message and the detail', async () => {
    const home = tmp();
    const missing = join(home, 'gone', 'repo');
    const r = await syncWorkingBranch({ repoPath: missing, workingBranch: 'work', home });
    expect(r.state).toBe('error');
    expectReason(r, 'no-clone');
    expect(r.reasonMessage).toContain('~/gone/repo');
    expect(r.reasonMessage).not.toContain(home);
    expect(r.detail).not.toContain(home);
    expect(r.detail).not.toContain(realpathSync(home));
  });

  it('no remote', async () => {
    const dir = tmp();
    sh(dir, 'git', ['init', '-b', 'work']);
    const r = await syncWorkingBranch({ repoPath: dir, workingBranch: 'work' });
    expect(r.state).toBe('no_remote');
    expectReason(r, 'no-remote');
  });

  it('origin has no such branch (no fetch)', async () => {
    const { repo } = setup();
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'nope', fetch: false });
    expect(r.state).toBe('error');
    expectReason(r, 'origin-missing-branch');
    expect(r.reasonMessage).toContain('nope');
  });

  it('origin unreachable: fetch-failed instead of a quiet up-to-date', async () => {
    const { repo, tip } = setup();
    await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    sh(repo.clone, 'git', ['remote', 'set-url', 'origin', join(repo.root, 'missing.git')]);
    const before = tip('work');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r.state).toBe('synced');
    expectReason(r, 'fetch-failed');
    expect(r.detail).toMatch(/^git fetch failed/);
    expect(tip('work')).toBe(before);
  });

  it('no local branch', async () => {
    const { repo } = setup();
    const other = join(tmp(), 'third');
    sh(repo.root, 'git', ['clone', repo.origin, other]);
    sh(other, 'git', ['checkout', '-b', 'only']);
    sh(other, 'git', ['push', 'origin', 'only']);
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'only' });
    expect(r.state).toBe('missing_branch');
    expectReason(r, 'no-local-branch');
    expect(tipOf(repo.clone, 'refs/heads/only')).toBe('');
  });

  it('up to date and local ahead carry quiet codes', async () => {
    const { repo } = setup();
    const synced = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(synced.state).toBe('synced');
    expectReason(synced, 'up-to-date');
    sh(repo.clone, 'git', ['checkout', 'work']);
    writeFileSync(join(repo.clone, 'l.txt'), 'x');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'l']);
    const ahead = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(ahead.state).toBe('ahead');
    expectReason(ahead, 'local-ahead');
  });

  it('diverged', async () => {
    const { repo, pushWork, tip } = setup();
    sh(repo.clone, 'git', ['checkout', 'work']);
    writeFileSync(join(repo.clone, 'local.txt'), 'x');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', ['commit', '-m', 'local']);
    const before = tip('HEAD');
    pushWork('d.txt');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r.state).toBe('diverged');
    expectReason(r, 'diverged');
    expect(r.detail).toBe('work has 1 commit(s) origin does not have');
    expect(tip('HEAD')).toBe(before);
  });

  it('read only', async () => {
    const { repo, pushWork, tip } = setup();
    pushWork('r.txt');
    const before = tip('work');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work', readOnly: true });
    expect(r.state).toBe('behind');
    expectReason(r, 'read-only');
    expect(tip('work')).toBe(before);
  });

  it('a card shift is running', async () => {
    const { repo, pushWork, tip } = setup();
    const wt = join(tmp(), 'wt');
    await ensureWorktree({
      repoPath: repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'work',
        branchName: 'aom/TOY-2',
      },
      defaultPath: wt,
    });
    const before = tip('work');
    pushWork('s.txt');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work', busyWorktrees: [wt] });
    expect(r.state).toBe('busy');
    expectReason(r, 'shift-running');
    expect(tip('work')).toBe(before);
  });

  it('local changes would be overwritten', async () => {
    const { repo, pushWork, tip } = setup();
    sh(repo.clone, 'git', ['checkout', 'work']);
    const before = tip('HEAD');
    pushWork('c.txt');
    writeFileSync(join(repo.clone, 'c.txt'), 'my own version');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(r.state).toBe('dirty');
    expectReason(r, 'local-changes');
    expect(r.reasonMessage).toContain('c.txt');
    expect(tip('HEAD')).toBe(before);
  });

  it('fast-forward failed for another reason (the index is locked)', async () => {
    const { repo, pushWork, tip } = setup();
    sh(repo.clone, 'git', ['checkout', 'work']);
    const before = tip('HEAD');
    pushWork('g.txt');
    writeFileSync(join(repo.clone, '.git', 'index.lock'), '');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    rmSync(join(repo.clone, '.git', 'index.lock'));
    expect(r.state).toBe('behind');
    expectReason(r, 'fast-forward-failed');
    expect(tip('HEAD')).toBe(before);
  });

  it('the ref could not be updated (the ref is locked)', async () => {
    const { repo, pushWork, tip } = setup();
    pushWork('h.txt');
    const before = tip('work');
    writeFileSync(join(repo.clone, '.git', 'refs', 'heads', 'work.lock'), '');
    const r = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    rmSync(join(repo.clone, '.git', 'refs', 'heads', 'work.lock'));
    expect(r.state).toBe('behind');
    expectReason(r, 'ref-update-failed');
    expect(tip('work')).toBe(before);
  });

  it('an update carries no reason (ref move and fast-forward)', async () => {
    const { repo, pushWork } = setup();
    pushWork('a.txt');
    const moved = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(moved.state).toBe('updated');
    expect(moved.reason).toBeUndefined();
    expect(moved.reasonMessage).toBeUndefined();
    sh(repo.clone, 'git', ['checkout', 'work']);
    pushWork('b.txt');
    const ff = await syncWorkingBranch({ repoPath: repo.clone, workingBranch: 'work' });
    expect(ff.state).toBe('updated');
    expect(ff.reason).toBeUndefined();
    expect(ff.reasonMessage).toBeUndefined();
  });
});

describe('safeSyncText', () => {
  it('masks credentials, the home at a path boundary only, and cuts to 400', () => {
    const home = tmp();
    const t = safeSyncText(`fatal: https://user:hunter2@example.test/x.git in ${home}/a and ${home}2/b`, home);
    expect(t).not.toContain('hunter2');
    expect(t).toContain('~/a');
    expect(t).toContain(`${home}2/b`);
    expect(safeSyncText('x'.repeat(500), home)).toHaveLength(400);
  });
});

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function service(repo: TestRepo, log: ReturnType<typeof fakeLog>, home?: string) {
  const sent: SyncStatusReport[] = [];
  const svc = new SyncService({
    file: join(tmp(), 'sync-targets.json'),
    findRepo: async () =>
      ({ localPath: repo.clone, remoteUrlNormalized: repo.remoteNormalized }) as unknown as RepoReport,
    busyWorktrees: () => [],
    send: (s) => sent.push(s),
    log,
    ...(home ? { home } : {}),
  });
  const target = {
    repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789b2',
    remoteUrlNormalized: repo.remoteNormalized,
    workingBranch: 'work',
  };
  return { svc, sent, target };
}

describe('SyncService reasons', () => {
  it('logs one info line for a skip, naming the repository, branch, code and worktree', async () => {
    const { repo, pushWork } = setup();
    const wt = join(tmp(), 'wt3');
    sh(repo.clone, 'git', ['worktree', 'add', wt, 'work']);
    pushWork('f.txt');
    const log = fakeLog();
    const { svc, sent, target } = service(repo, log, '/nowhere-home');
    const r = await svc.sync(target);
    expect(r.reason).toBe('checked-out-elsewhere');
    expect(log.info).toHaveBeenCalledTimes(1);
    const line = String(log.info.mock.calls[0]?.[0]);
    expect(line).toContain(repo.remoteNormalized);
    expect(line).toContain('work');
    expect(line).toContain('checked-out-elsewhere');
    expect(line).toContain(realpathSync(wt));
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    const wire = RepoSyncStatusSchema.parse(toRepoSyncStatus(r));
    expect(wire.reason).toBe('checked-out-elsewhere');
    expect(wire.reasonMessage).toContain(realpathSync(wt));
  });

  it('logs nothing for an update or a quiet result', async () => {
    const { repo, pushWork } = setup();
    const log = fakeLog();
    const { svc, target } = service(repo, log);
    pushWork('u.txt');
    expect((await svc.sync(target)).state).toBe('updated');
    expect((await svc.sync(target)).reason).toBe('up-to-date');
    expect(log.info).not.toHaveBeenCalled();
  });

  it('no clone on this workstation and an unexpected error carry a reason', async () => {
    const log = fakeLog();
    const none = new SyncService({
      file: join(tmp(), 'sync-targets.json'),
      findRepo: async () => undefined,
      busyWorktrees: () => [],
      send: () => {},
      log,
    });
    const t = { repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3', remoteUrlNormalized: 'x/y', workingBranch: 'w' };
    const a = await none.sync(t);
    expectReason(a, 'no-clone');
    const home = tmp();
    const boom = new SyncService({
      file: join(tmp(), 'sync-targets.json'),
      findRepo: async () => {
        throw new Error(`cannot read ${home}/secret-place`);
      },
      busyWorktrees: () => [],
      send: () => {},
      log,
      home,
    });
    const b = await boom.sync(t);
    expectReason(b, 'sync-failed');
    expect(b.reasonMessage).toContain('~/secret-place');
    expect(b.detail).not.toContain(home);
    expect(log.info).toHaveBeenCalledTimes(2);
  });

  it('the wire form has no reason fields after an update', () => {
    const wire = toRepoSyncStatus({
      repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789d4',
      remoteUrlNormalized: 'x/y',
      workingBranch: 'w',
      state: 'updated',
      ahead: 0,
      behind: 0,
      dirty: false,
      onBranch: false,
      checkedOutBranch: 'main',
      checkedAt: '2026-11-16T10:00:00.000Z',
    });
    expect('reason' in wire).toBe(false);
    expect('reasonMessage' in wire).toBe(false);
    expect(RepoSyncStatusSchema.parse(wire).state).toBe('updated');
  });
});
