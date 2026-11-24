import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeRemoteUrl, type RepoClonePayload } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { makeInitialCommit, repoStartState } from '../src/git/empty-repo.ts';
import { scanRepos } from '../src/git/repo-scan.ts';
import { RepoCloner } from '../src/repo/clone.ts';
import { realExecutor } from '../src/toolchain/exec.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, sh, type TestRepo, tmp } from './helpers.ts';

cleanupTmp();

/**
 * uat-runner-fixes-3 finding 5: an empty bare repository (no commits, HEAD -> master, working branch main) made four shifts
 * fail with worktree_failed "working branch 'main' does not exist" before anyone saw why. The runner now tells an empty
 * repository when it is cloned, at env.ensure and when a shift is turned away, and makes the first commit on one click.
 */

/** A bare origin with no commit (its HEAD names master) and an empty clone of it, as on the devbox. */
function emptyRepo(): TestRepo {
  const root = tmp();
  const origin = join(root, 'test.git');
  const scanRoot = join(root, 'work');
  const clone = join(scanRoot, 'test');
  mkdirSync(scanRoot, { recursive: true });
  sh(root, 'git', ['init', '--bare', '-b', 'master', origin]);
  sh(scanRoot, 'git', ['clone', '-q', origin, clone]);
  return { root, origin, clone, scanRoot, remoteNormalized: normalizeRemoteUrl(origin) };
}

const IDS = {
  requestId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c1',
  projectId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c2',
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789c3',
};

describe('an empty repository is told, not tried', () => {
  it('repoStartState: empty (clone and origin), with the working branch the first commit would go on', async () => {
    const r = emptyRepo();
    expect(await repoStartState(r.clone, 'main')).toMatchObject({ empty: true, branch: 'main' });
    // without a working branch: the name origin's HEAD gives
    expect(await repoStartState(r.clone)).toMatchObject({ empty: true, branch: 'master' });
  });

  it('repo.clone reports an empty repository with the branch for the first commit', async () => {
    const r = emptyRepo();
    const root = tmp('aom-clone-root-');
    const cloner = new RepoCloner({
      repoRoots: () => [root],
      exec: realExecutor,
      findExisting: async (n) => (await scanRepos([root])).find((x) => normalizeRemoteUrl(x.remoteUrl) === n),
      creator: { run: async () => ({ ok: false, error: 'not used' }) },
    });
    const p: RepoClonePayload = {
      ...IDS,
      projectKey: 'GIT',
      projectName: 'Git',
      name: 'test',
      remoteUrl: r.origin,
      workingBranch: 'main',
    };
    const first = await cloner.run(p);
    expect(first).toMatchObject({ ok: true, state: 'cloned', empty: { branch: 'main' } });
    expect(first.detail).toContain('is empty: it has no commits yet');
    expect(await cloner.run(p)).toMatchObject({ ok: true, existing: true, empty: { branch: 'main' } });
  });

  it('makeInitialCommit: an empty commit on the branch, pushed (never forced); refused once the repository has a commit', async () => {
    const r = emptyRepo();
    const id = { name: 'Owner', email: 'owner@example.com' };
    const made = await makeInitialCommit({ repo: r.clone, branch: 'main', identity: id });
    expect(made).toMatchObject({ ok: true, branch: 'main', pushed: true });
    expect(sh(r.origin, 'git', ['rev-parse', 'refs/heads/main'])).toBe((made as { sha: string }).sha);
    expect(sh(r.origin, 'git', ['log', '-1', '--format=%an <%ae>|%s', 'main'])).toBe(
      'Owner <owner@example.com>|Initial commit',
    );
    expect(sh(r.clone, 'git', ['symbolic-ref', '--short', 'HEAD'])).toBe('main');
    expect(await repoStartState(r.clone, 'main')).toMatchObject({ empty: false, branchMissing: false });
    const again = await makeInitialCommit({ repo: r.clone, branch: 'main', identity: id });
    expect(again).toMatchObject({ ok: false, error: expect.stringContaining('not empty any more') });
  });

  it('refuses when someone pushed to origin meanwhile (the clone still looks empty)', async () => {
    const r = emptyRepo();
    const other = join(tmp(), 'other');
    sh(r.root, 'git', ['clone', '-q', r.origin, other]);
    sh(other, 'git', [
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@x.io',
      'commit',
      '--allow-empty',
      '-m',
      'theirs',
    ]);
    sh(other, 'git', ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
    const made = await makeInitialCommit({
      repo: r.clone,
      branch: 'main',
      identity: { name: 'O', email: 'o@example.com' },
    });
    expect(made.ok).toBe(false);
    expect(sh(r.origin, 'git', ['log', '--format=%s', 'main'])).toBe('theirs');
  });
});

describe('the runner, end to end', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  it('env.ensure says the repository is empty (cards then wait on the environment) instead of "ready"', async () => {
    const r = emptyRepo();
    h = await startHarness({}, {}, r);
    h.server.send('command', {
      commandId: 'env1',
      command: 'env.ensure',
      payload: {
        requestId: IDS.requestId,
        projectId: IDS.projectId,
        repos: [
          {
            repoId: IDS.repoId,
            name: 'test',
            remoteUrlNormalized: r.remoteNormalized,
            workingBranch: 'main',
          },
        ],
        access: {},
      },
    });
    const res = await h.server.waitFor('command.result', (m) => m.commandId === 'env1', 60_000);
    expect(res.ok).toBe(true);
    expect(res.result).toMatchObject({
      state: 'failed',
      emptyRepos: [{ repoId: IDS.repoId, name: 'test', branch: 'main' }],
    });
    expect(String((res.result as { summary: string }).summary)).toContain('the repository is empty');
  }, 90_000);

  it('a shift on an empty repository is turned away with emptyRepository, so the server asks for a first commit', async () => {
    const r = emptyRepo();
    h = await startHarness({}, {}, r);
    const msg = makeShiftStart({ stage: 'build', ref: 'GIT-1', remoteNormalized: r.remoteNormalized });
    h.server.send('shift.start', msg);
    const rejected = await h.server.waitFor('shift.rejected', (m) => m.shiftId === msg.shiftId, 60_000);
    expect(rejected).toMatchObject({
      reason: 'worktree_failed',
      branchProblem: { base: 'main', emptyRepository: true },
    });
  }, 90_000);

  it('repo.initial_commit makes and pushes the first commit with the project Commit as', async () => {
    const r = emptyRepo();
    h = await startHarness({}, {}, r);
    h.server.send('command', {
      commandId: 'ic1',
      command: 'repo.initial_commit',
      payload: {
        ...IDS,
        remoteUrlNormalized: r.remoteNormalized,
        branch: 'main',
        commitAs: { name: 'Ada Owner', email: 'ada@example.com' },
      },
    });
    const res = await h.server.waitFor('command.result', (m) => m.commandId === 'ic1', 60_000);
    expect(res.result).toMatchObject({ ok: true, branch: 'main' });
    expect(sh(r.origin, 'git', ['log', '-1', '--format=%an', 'main'])).toBe('Ada Owner');
  }, 90_000);
});
