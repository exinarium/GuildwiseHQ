import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeSandboxStubs, usedSince } from '../src/adapters/sandbox-placeholders.ts';
import { enforceCardFence, snapshotCardWorktrees } from '../src/devops/card-fence.ts';
import { rebaseOntoBase } from '../src/git/rebase.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { type Harness, startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp, makeRepo, sh, tmp } from './helpers.ts';
import { ScriptedAdapter, type ScriptResult } from './scripted-adapter.ts';
import { makeDevopsStart } from './vault-fixtures.ts';

cleanupTmp();

/** REVIEW rework 1 of uat-runner-fixes-3 (findings B1, B2, S1, S2, S3 on the DevOps card-worktree fence). */

const ID = { name: 'Toy Dev', email: 'dev@toy.test' };

async function cardWorktree() {
  const repo = makeRepo();
  const root = join(tmp(), 'worktrees');
  const path = join(root, 'TOY-0123abcd', 'TOY-1');
  await ensureWorktree({
    repoPath: repo.clone,
    roots: [root],
    spec: {
      mode: 'create',
      repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'main',
      branchName: 'guildwise/toy-1-x',
    },
    defaultPath: path,
  });
  writeFileSync(join(path, 'card.txt'), 'card work\n');
  sh(path, 'git', ['add', '-A']);
  sh(path, 'git', [
    '-c',
    `user.name=${ID.name}`,
    '-c',
    `user.email=${ID.email}`,
    'commit',
    '-m',
    'card work',
  ]);
  return { repo, root, path };
}

const fence = (root: string, before: Awaited<ReturnType<typeof snapshotCardWorktrees>>, since: number) =>
  enforceCardFence({ root, before, shiftId: 'ffffffff-1', usedByOthers: (p) => usedSince(p, since) });

describe('B1: the runner own work on a card worktree is never taken for the DevOps engineer', () => {
  it('a finalize or run-start rebase during a DevOps shift stays (no revert, no finding)', async () => {
    const { repo, root, path } = await cardWorktree();
    // the working branch moved on origin
    writeFileSync(join(repo.clone, 'other.txt'), 'other\n');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', [
      '-c',
      `user.name=${ID.name}`,
      '-c',
      `user.email=${ID.email}`,
      'commit',
      '-m',
      'other',
    ]);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    const startedAt = Date.now();
    const before = await snapshotCardWorktrees(root);
    expect(await rebaseOntoBase(path, 'main', ID)).toBe('rebased');
    const rebased = sh(path, 'git', ['rev-parse', 'HEAD']).trim();
    expect(await fence(root, before, startedAt)).toEqual([]);
    expect(sh(path, 'git', ['rev-parse', 'HEAD']).trim()).toBe(rebased);
  });

  it('a worktree the runner makes during a DevOps shift (a design checkout, a card start) is no finding', async () => {
    const { repo, root } = await cardWorktree();
    const startedAt = Date.now();
    const before = await snapshotCardWorktrees(root);
    await ensureWorktree({
      repoPath: repo.clone,
      roots: [root],
      spec: {
        mode: 'create',
        repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
        remoteUrlNormalized: repo.remoteNormalized,
        baseBranch: 'main',
        branchName: 'guildwise/toy-2-y',
      },
      defaultPath: join(root, 'TOY-0123abcd', 'TOY-2'),
    });
    expect(await fence(root, before, startedAt)).toEqual([]);
  });
});

describe('S1: content, not status lines', () => {
  it('a further edit to a file already uncommitted is caught (and not reset: the file may be someone else)', async () => {
    const { root, path } = await cardWorktree();
    writeFileSync(join(path, 'card.txt'), 'card work, unfinished\n');
    const startedAt = Date.now();
    const before = await snapshotCardWorktrees(root);
    writeFileSync(join(path, 'card.txt'), 'DevOps was here\n');
    const f = await fence(root, before, startedAt);
    expect(f).toHaveLength(1);
    expect(f[0]?.changed).toContain('already uncommitted were changed further');
    expect(f[0]?.reverted).toBe(false);
  });

  it('R2-S2: new ignored entries are removed; ignored entries that existed and changed are reported', async () => {
    const { root, path } = await cardWorktree();
    writeFileSync(join(path, '.gitignore'), 'node_modules/\n.env\n');
    mkdirSync(join(path, 'node_modules', 'zod'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'zod', 'index.js'), 'builder install');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['-c', `user.name=${ID.name}`, '-c', `user.email=${ID.email}`, 'commit', '-m', 'ignore']);
    const startedAt = Date.now();
    const before = await snapshotCardWorktrees(root);
    await new Promise((r) => setTimeout(r, 20)); // a different mtime for the folder
    mkdirSync(join(path, 'node_modules', 'left-pad'), { recursive: true });
    writeFileSync(join(path, 'node_modules', 'left-pad', 'index.js'), 'x');
    writeFileSync(join(path, '.env'), 'X=1\n');
    const f = await fence(root, before, startedAt);
    expect(f).toHaveLength(1);
    expect(f[0]?.changed).toContain('new ignored files removed: .env');
    expect(existsSync(join(path, '.env'))).toBe(false);
    expect(f[0]?.changed).toContain('ignored files that existed before were changed: node_modules/');
    expect(existsSync(join(path, 'node_modules', 'zod', 'index.js'))).toBe(true);
    expect(f[0]?.reverted).toBe(false);
  });
});

describe('S3 / R2-B1: the refused work is kept as a commit, and the branch always goes back', () => {
  const dirtyCommit = (path: string) => {
    writeFileSync(join(path, 'package.json'), '{"dependencies":{"left-pad":"1.3.0"}}\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['-c', `user.name=${ID.name}`, '-c', `user.email=${ID.email}`, 'commit', '-m', 'DevOps']);
    writeFileSync(join(path, 'card.txt'), 'changed by DevOps\n');
    writeFileSync(join(path, 'stray.txt'), 'new\n');
  };

  it('a commit, a dirty file and a stale refs/stash.lock: HEAD is back, the tree clean, the work under the refused ref', async () => {
    const { root, path } = await cardWorktree();
    const startedAt = Date.now();
    const before = await snapshotCardWorktrees(root);
    const head = before.get(path)?.head as string;
    dirtyCommit(path);
    const common = sh(path, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    mkdirSync(join(common, 'refs'), { recursive: true });
    writeFileSync(join(common, 'refs', 'stash.lock'), '');
    const f = await fence(root, before, startedAt);
    expect(f).toHaveLength(1);
    expect(f[0]?.reverted).toBe(true);
    expect(sh(path, 'git', ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(sh(path, 'git', ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const wip = f[0]?.keptAt.find((k) => k.includes('-wip-')) as string;
    expect(wip).toBeTruthy();
    expect(sh(path, 'git', ['show', `${wip}:card.txt`])).toBe('changed by DevOps');
    expect(sh(path, 'git', ['show', `${wip}:stray.txt`])).toBe('new');
    expect(sh(path, 'git', ['log', '-1', '--format=%an', wip]).trim()).toBe('Guildwise runner');
  });

  it('when no evidence can be stored at all, the commits still leave the card branch and the files stay', async () => {
    const { root, path } = await cardWorktree();
    const startedAt = Date.now();
    const before = await snapshotCardWorktrees(root);
    const head = before.get(path)?.head as string;
    dirtyCommit(path);
    // a file where the refused refs would go: every refs/guildwise/refused/... update fails
    const common = sh(path, 'git', ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    mkdirSync(join(common, 'refs', 'guildwise'), { recursive: true });
    writeFileSync(join(common, 'refs', 'guildwise', 'refused'), 'not a folder');
    const f = await fence(root, before, startedAt);
    expect(f[0]?.reverted).toBe(false);
    expect(sh(path, 'git', ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(readFileSync(join(path, 'card.txt'), 'utf8')).toBe('changed by DevOps\n');
    expect(readFileSync(join(path, 'stray.txt'), 'utf8')).toBe('new\n');
  });
});

describe('S2: a committed placeholder that went missing does not stop a rebase', () => {
  it('the shift end puts the empty file back, so a later finalize rebase goes through', async () => {
    const { repo, path } = await cardWorktree();
    writeFileSync(join(path, '.idea'), '');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', [
      '-c',
      `user.name=${ID.name}`,
      '-c',
      `user.email=${ID.email}`,
      'commit',
      '-m',
      'Work in progress',
    ]);
    rmSync(join(path, '.idea'));
    mkdirSync(join(path, '.idea')); // Claude Code's empty folder in its place
    await removeSandboxStubs(path);
    expect(existsSync(join(path, '.idea'))).toBe(true);
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
    writeFileSync(join(repo.clone, 'other.txt'), 'other\n');
    sh(repo.clone, 'git', ['add', '-A']);
    sh(repo.clone, 'git', [
      '-c',
      `user.name=${ID.name}`,
      '-c',
      `user.email=${ID.email}`,
      'commit',
      '-m',
      'other',
    ]);
    sh(repo.clone, 'git', ['push', 'origin', 'main']);
    rmSync(join(path, '.idea')); // gone again, now right before a finalize
    expect(await rebaseOntoBase(path, 'main', ID)).toBe('rebased');
  });
});

describe('B2: the fence runs whichever way a DevOps shift ends', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.stop();
    h = undefined;
  });

  /** Card shifts just end; the DevOps shift commits in the card worktree, then ends the way `end` says. */
  const adapter = (end: ScriptResult) =>
    new ScriptedAdapter(async (input) => {
      if (!input.agent.isDevops) return { exitCode: 0 };
      const wt = /\[edit_worktree:([^\]]+)\]/.exec(JSON.stringify(input))?.[1] as string;
      writeFileSync(join(wt, 'package.json'), '{"name":"toy","dependencies":{"left-pad":"1.3.0"}}\n');
      sh(wt, 'git', ['add', '-A']);
      sh(wt, 'git', ['-c', `user.name=${ID.name}`, '-c', `user.email=${ID.email}`, 'commit', '-m', 'DevOps']);
      writeFileSync(join(wt, 'stray.txt'), 'x\n');
      return end;
    });

  for (const [name, end] of [
    ['hits the usage limit', { exitCode: 1, usageLimit: { until: '2099-01-01T00:00:00.000Z' } }],
    ['finds its login expired', { exitCode: 1, authFailed: true }],
  ] as const)
    it(`a DevOps shift that writes in a card worktree and then ${name} is still reverted`, async () => {
      h = await startHarness({}, { adapters: new Map([['mock', adapter(end)]]) });
      await h.runShift({ stage: 'build', ref: 'TOY-1' });
      const wt = worktreeOf(h);
      const head = sh(wt, 'git', ['rev-parse', 'HEAD']).trim();
      const start = makeDevopsStart({ summary: `install it [edit_worktree:${wt}]` });
      const shiftId = start.shiftId as string;
      h.server.send('shift.start', start);
      await h.server.waitFor('shift.rejected', (m) => m.shiftId === shiftId, 60_000);
      await h.runner.supervisor.whenSettled(shiftId);
      expect(sh(wt, 'git', ['rev-parse', 'HEAD']).trim()).toBe(head);
      expect(sh(wt, 'git', ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    }, 120_000);
});
