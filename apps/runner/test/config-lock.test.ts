import { chmodSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { clearLockStub, holdSandboxRepo, sandboxHolders } from '../src/git/config-lock.ts';
import { git, lockRetry } from '../src/git/git.ts';
import { withIntegrationWorktree } from '../src/git/integration.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();
lockRetry.delaysMs = [10, 10];

/** What bubblewrap leaves on the host for a protected name that did not exist: an empty, read-only file. */
const stub = (clone: string): string => {
  const p = join(clone, '.git', 'config.lock');
  writeFileSync(p, '');
  chmodSync(p, 0o444);
  return p;
};

describe('sandbox config.lock stub (hotfix #78)', () => {
  it('an integration worktree is created while the stub exists: no config write is needed', async () => {
    const r = makeRepo();
    sh(r.clone, 'git', ['fetch', 'origin']);
    const lock = stub(r.clone);
    const probe = await withIntegrationWorktree(
      {
        repoPath: r.clone,
        dir: join(r.root, 'int', 'wt'),
        root: join(r.root, 'int'),
        tempBranch: 'aom-integration/x',
        startPoint: 'origin/main',
      },
      async (dir) => sh(dir, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    );
    expect(probe).toEqual({ ok: true, value: 'aom-integration/x' });
    // no tracking was configured, so nothing touched the config (and the stub was not even in the way)
    expect(existsSync(lock)).toBe(true);
    expect((await git(r.clone, ['config', '--get-regexp', '^branch\\.aom-integration'])).stdout.trim()).toBe(
      '',
    );
  });

  it('with the real git of the production failure: worktree add -B on a remote ref needs --no-track', () => {
    const r = makeRepo();
    stub(r.clone);
    expect(() =>
      sh(r.clone, 'git', ['worktree', 'add', '-B', 'plain', join(r.root, 'plain'), 'origin/main']),
    ).toThrow(/could not lock config file/);
    sh(r.clone, 'git', ['worktree', 'add', '--no-track', '-B', 'ok', join(r.root, 'ok'), 'origin/main']);
  });

  it('a config write that is needed recovers from the stub', async () => {
    const r = makeRepo();
    const lock = stub(r.clone);
    const w = await git(r.clone, ['config', 'aom.test', 'yes']);
    expect(w.exitCode).toBe(0);
    expect(sh(r.clone, 'git', ['config', 'aom.test']).trim()).toBe('yes');
    expect(existsSync(lock)).toBe(false);
  });

  it('recovers from a linked worktree too (the lock lives in the common dir)', async () => {
    const r = makeRepo();
    const wt = join(r.root, 'linked');
    sh(r.clone, 'git', ['worktree', 'add', '--no-track', '-b', 'linked', wt, 'origin/main']);
    const lock = stub(r.clone);
    expect((await git(wt, ['config', 'aom.test', 'linked'])).exitCode).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('never deletes a real lock: non-empty or writable', async () => {
    const r = makeRepo();
    const lock = join(r.clone, '.git', 'config.lock');
    writeFileSync(lock, 'half written config');
    chmodSync(lock, 0o444);
    expect(clearLockStub(join(r.clone, '.git'))).toEqual([]);
    expect((await git(r.clone, ['config', 'aom.test', 'x'])).exitCode).not.toBe(0);
    expect(existsSync(lock)).toBe(true);

    chmodSync(lock, 0o644);
    writeFileSync(lock, ''); // empty but writable: a git that has just created its lock
    chmodSync(lock, 0o644);
    expect(clearLockStub(join(r.clone, '.git'))).toEqual([]);
    expect((await git(r.clone, ['config', 'aom.test', 'x'])).exitCode).not.toBe(0);
    expect(existsSync(lock)).toBe(true);
    expect(statSync(lock).size).toBe(0);
  });

  it('shift end removes the stub only when no other shift of the clone runs', () => {
    const r = makeRepo();
    const gitDir = join(r.clone, '.git');
    const a = holdSandboxRepo([gitDir]);
    const b = holdSandboxRepo([gitDir]);
    expect(sandboxHolders(gitDir)).toBe(2);
    const lock = stub(r.clone);
    a();
    a(); // a second call of the same release changes nothing
    expect(sandboxHolders(gitDir)).toBe(1);
    expect(existsSync(lock)).toBe(true);
    b();
    expect(sandboxHolders(gitDir)).toBe(0);
    expect(existsSync(lock)).toBe(false);
  });

  it('shift end leaves a real lock alone', () => {
    const r = makeRepo();
    const gitDir = join(r.clone, '.git');
    const release = holdSandboxRepo([gitDir]);
    const lock = join(gitDir, 'config.lock');
    writeFileSync(lock, 'real');
    chmodSync(lock, 0o444);
    release();
    expect(existsSync(lock)).toBe(true);
  });

  it('is a no-op for a clone that has no stub', () => {
    const dir = tmp();
    holdSandboxRepo([dir])();
    expect(sandboxHolders(dir)).toBe(0);
  });
});
