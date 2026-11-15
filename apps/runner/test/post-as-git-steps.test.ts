import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type PostAsRepo, type ReleasePrepShift, writableFilesFor } from '@aom/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppTokenError } from '../src/apps/types.ts';
import { architectMergeMain } from '../src/git/architect-git.ts';
import { AppIdentityError, setAppTokenProbe } from '../src/git/identity.ts';
import { addPrepTaskWorktree, finishPrepTask, removePrepTaskWorktree } from '../src/git/release-prep-task.ts';
import { mergeInProgress, mergeMainIntoCard, syncMainIntoWorking } from '../src/git/sync-main.ts';
import { runnerPaths } from '../src/paths.ts';
import { RunManager } from '../src/runs/manager.ts';
import { ServiceLauncher } from '../src/runs/sandbox.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';

cleanupTmp();

const APP_ID = '0190f1a0-0000-7000-8000-000000000001';
const REPO_ID = '0190f1a0-0000-7000-8000-00000000000a';
const PROJECT = { name: 'Project Person', email: 'project@example.test' };
const app = {
  integrationId: APP_ID,
  provider: 'github-app' as const,
  label: 'Acme bot',
  botName: 'acme-bot[bot]',
  botEmail: '123+acme-bot[bot]@users.noreply.github.com',
  instance: '42:777',
  host: 'github.com',
};
const appEntry = (remote: string): PostAsRepo => ({
  repoId: REPO_ID,
  remoteUrlNormalized: remote,
  source: 'app',
  app,
});

const failingProbe = () =>
  setAppTokenProbe({
    ensure: async () => {
      throw new AppTokenError('installation_suspended', 'raw provider text');
    },
  });

afterEach(() => setAppTokenProbe(null));

/** origin with `main` and `work`; main moved ahead of work, so a sync has a merge to make. */
function setup() {
  const repo = makeRepo();
  sh(repo.clone, 'git', ['config', 'user.name', 'Repo Person']);
  sh(repo.clone, 'git', ['config', 'user.email', 'repo@example.test']);
  sh(repo.clone, 'git', ['checkout', '-b', 'work']);
  sh(repo.clone, 'git', ['push', '-u', 'origin', 'work']);
  sh(repo.clone, 'git', ['checkout', 'main']);
  writeFileSync(join(repo.clone, 'main-only.txt'), 'from main\n');
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'main moves']);
  sh(repo.clone, 'git', ['push', 'origin', 'main']);
  const input = (over = {}) => ({
    repoPath: repo.clone,
    mainBranch: 'main',
    workingBranch: 'work',
    ref: 'TOY-1',
    integrationDir: join(tmp(), 'integration'),
    ...over,
  });
  /** A card worktree on `work` (behind main). */
  const card = () => {
    const dir = join(tmp(), 'card');
    sh(repo.clone, 'git', ['worktree', 'add', '-b', 'aom/toy-1-card', dir, 'origin/work']);
    return dir;
  };
  return { repo, input, card };
}

describe('merging the latest main into the working branch with a post-as plan', () => {
  it('the app cannot mint: AppIdentityError, nothing merged or pushed', async () => {
    failingProbe();
    const t = setup();
    const before = sh(t.repo.origin, 'git', ['rev-parse', 'work']);
    const err = await syncMainIntoWorking(
      t.input({ commitAs: PROJECT, postAs: appEntry(t.repo.remoteNormalized) }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppIdentityError);
    expect((err as Error).message).toContain('Acme bot');
    expect(sh(t.repo.origin, 'git', ['rev-parse', 'work'])).toBe(before);
  });

  it('the app can mint: the merge commit is the bot’s', async () => {
    setAppTokenProbe({ ensure: vi.fn(async () => {}) });
    const t = setup();
    const out = await syncMainIntoWorking(
      t.input({ commitAs: PROJECT, postAs: appEntry(t.repo.remoteNormalized) }),
    );
    expect(out.kind).toBe('merged_into_working');
    expect(sh(t.repo.origin, 'git', ['log', '-1', '--format=%an <%ae>|%cn', 'work'])).toBe(
      'acme-bot[bot] <123+acme-bot[bot]@users.noreply.github.com>|acme-bot[bot]',
    );
  });

  it('no post-as plan: unchanged (Commit as, else the repository identity)', async () => {
    const t = setup();
    expect((await syncMainIntoWorking(t.input({ commitAs: PROJECT }))).kind).toBe('merged_into_working');
    expect(sh(t.repo.origin, 'git', ['log', '-1', '--format=%an <%ae>', 'work'])).toBe(
      'Project Person <project@example.test>',
    );
    const u = setup();
    expect((await syncMainIntoWorking(u.input())).kind).toBe('merged_into_working');
    expect(sh(u.repo.origin, 'git', ['log', '-1', '--format=%an', 'work'])).toBe('Repo Person');
  });
});

describe('merging the latest main into the card branch with a post-as plan', () => {
  it('the app cannot mint: AppIdentityError, no merge started, HEAD unchanged', async () => {
    failingProbe();
    const t = setup();
    const wt = t.card();
    const head = sh(wt, 'git', ['rev-parse', 'HEAD']);
    await expect(
      mergeMainIntoCard(wt, {
        mainBranch: 'main',
        ref: 'TOY-1',
        commitAs: PROJECT,
        postAs: appEntry(t.repo.remoteNormalized),
      }),
    ).rejects.toBeInstanceOf(AppIdentityError);
    expect(sh(wt, 'git', ['rev-parse', 'HEAD'])).toBe(head);
    expect(await mergeInProgress(wt)).toBe(false);
  });

  it('no post-as plan: merged as Commit as, as before', async () => {
    const t = setup();
    const wt = t.card();
    const r = await mergeMainIntoCard(wt, { mainBranch: 'main', ref: 'TOY-1', commitAs: PROJECT });
    expect(r).toMatchObject({ result: 'merged_into_card' });
    expect(sh(wt, 'git', ['log', '-1', '--format=%an', 'HEAD'])).toBe('Project Person');
  });

  it('`aom git merge-main` answers with the app_identity_failed wire error', async () => {
    failingProbe();
    const t = setup();
    const wt = t.card();
    const head = sh(wt, 'git', ['rev-parse', 'HEAD']);
    const r = await architectMergeMain({
      worktree: wt,
      branchName: 'aom/toy-1-card',
      mainBranch: 'main',
      ref: 'TOY-1',
      postAs: appEntry(t.repo.remoteNormalized),
      recordMainSha: () => {},
    });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/^app_identity_failed: The app Acme bot could not be used/);
    expect(sh(wt, 'git', ['rev-parse', 'HEAD'])).toBe(head);
  });
});

describe('a release prep task commit with a post-as plan', () => {
  const task = { kind: 'guide_edits', guidePath: 'docs/USER-GUIDE.md', changes: [{ id: 'c1' }] } as never;

  async function prepared() {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['config', 'user.name', 'Repo Person']);
    sh(repo.clone, 'git', ['config', 'user.email', 'repo@example.test']);
    const head = sh(repo.clone, 'git', ['rev-parse', 'HEAD']);
    const rp = {
      taskId: randomUUID(),
      runId: randomUUID(),
      repoId: REPO_ID,
      step: 'guide',
      phase: 'write',
      remoteUrlNormalized: repo.remoteNormalized,
      workRef: `refs/guildwise/docs-prep/${randomUUID()}/work`,
      startSha: head,
      task,
      writable: writableFilesFor({ kind: 'guide_edits' } as never),
    } as unknown as ReleasePrepShift;
    const wt = await addPrepTaskWorktree(repo.clone, rp, join(tmp('aom-wt-'), 'task'));
    const file = rp.writable[0] as string;
    mkdirSync(join(wt.path, file, '..'), { recursive: true });
    writeFileSync(join(wt.path, file), '{}\n');
    return { repo, rp, wt };
  }

  it('the app cannot mint: refused with app_identity_failed, the work ref is not moved', async () => {
    failingProbe();
    const { repo, rp, wt } = await prepared();
    const r = await finishPrepTask(wt, rp, PROJECT, appEntry(repo.remoteNormalized));
    await removePrepTaskWorktree(wt);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/^app_identity_failed: The app Acme bot could not be used/);
    expect(sh(repo.clone, 'git', ['for-each-ref', '--format=%(refname)', rp.workRef])).toBe('');
  });

  it('no post-as plan: committed as Commit as, as before', async () => {
    const { repo, rp, wt } = await prepared();
    const r = await finishPrepTask(wt, rp, PROJECT);
    await removePrepTaskWorktree(wt);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(sh(repo.clone, 'git', ['log', '-1', '--format=%an', r.commit])).toBe('Project Person');
  });
});

describe('a test environment rebase with a post-as plan', () => {
  const running: RunManager[] = [];
  afterEach(async () => {
    for (const m of running.splice(0)) {
      for (const id of m.liveEnvIds()) await m.stop({ envId: id, reason: 'failed' });
      m.shutdown();
    }
  });

  it('the app cannot mint: the start fails with app_identity_failed and the card head is unchanged', async () => {
    failingProbe();
    const repo = makeRepo();
    const paths = runnerPaths(tmp());
    mkdirSync(join(paths.worktrees, 'TOY-aaaaaaaa'), { recursive: true });
    const wt = join(paths.worktrees, 'TOY-aaaaaaaa', 'TOY-1');
    sh(repo.clone, 'git', ['worktree', 'add', '-b', 'aom/toy-1-card', wt, 'main']);
    writeFileSync(join(wt, 'card.txt'), 'card\n');
    sh(wt, 'git', ['add', '-A']);
    sh(wt, 'git', ['-c', 'user.name=x', '-c', 'user.email=x@example.test', 'commit', '-m', 'card work']);
    writeFileSync(join(repo.clone, 'later.txt'), 'main moved\n');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', [
      '-c',
      'user.name=x',
      '-c',
      'user.email=x@example.test',
      'commit',
      '-m',
      'main moves',
    ]);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const before = sh(wt, 'git', ['rev-parse', 'HEAD']);
    const mgr = new RunManager({
      paths,
      findRepo: async () => ({ localPath: repo.clone }),
      send: () => {},
      log: { info() {}, warn() {}, error() {} },
      maxEnvironments: () => 3,
      launcher: new ServiceLauncher({ noScope: true }),
      portRange: () => ({ from: 44000, to: 44400 }),
      timing: { waitMs: 8000, healthPollMs: 40, superviseMs: 80, logFlushMs: 60, stopGraceMs: 400 },
    });
    running.push(mgr);
    const r = await mgr.startEnv({
      envId: randomUUID(),
      projectId: randomUUID(),
      projectKey: 'TOY',
      projectName: 'Toy',
      purpose: 'test',
      requestId: randomUUID(),
      sources: [
        {
          repoId: REPO_ID,
          name: 'toy',
          remoteUrlNormalized: repo.remoteNormalized,
          branch: 'aom/toy-1-card',
        },
      ],
      services: [],
      portRange: { from: 44000, to: 44400 },
      ttlAt: new Date(Date.now() + 3600_000).toISOString(),
      allowDocker: false,
      rebaseCard: {
        repoId: REPO_ID,
        baseBranch: 'main',
        cardWorktreePath: wt,
        commitAs: PROJECT,
        postAs: { repos: [appEntry(repo.remoteNormalized)] },
      },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/app_identity_failed: The app Acme bot could not be used/);
    expect(sh(wt, 'git', ['rev-parse', 'HEAD'])).toBe(before);
  });
});
