import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { boxSandbox } from '../src/box/launch.ts';
import { resolveBrokerPush } from '../src/devops/devops-git.ts';
import { setGitAfterHook } from '../src/git/git.ts';
import { folderRefFence, WRITER_MARK } from '../src/git/harden.ts';
import {
  holdWriters,
  latestTip,
  recordTip,
  setTipStore,
  TipStore,
  tipStore,
  writerStart,
} from '../src/git/pushable-tips.ts';
import { mergeMainIntoCard } from '../src/git/sync-main.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { harnessBwrapArgs } from '../src/sandbox/harness-sandbox.ts';
import { killOrphanSessions, orphanSessionPids } from '../src/shifts/orphans.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

/** gate-fixes-2 Rework 1 (PREREVIEW findings 1-4): B3 for merge-main, the outer-box fence, the orphan kill. */
cleanupTmp();
const U = '019e3f6a-7b1c-7a2d-8c3e-0123456789a1';
let saved: TipStore | null;
beforeEach(() => {
  saved = tipStore();
  setTipStore(TipStore.forRoot(mkdtempSync(join(tmp(), 'tips-'))));
});
afterEach(() => {
  setGitAfterHook(null);
  setTipStore(saved);
});

async function cardOn(repo: TestRepo) {
  const path = join(tmp(), 'wt');
  await ensureWorktree({
    repoPath: repo.clone,
    roots: ['/'],
    spec: {
      mode: 'create',
      repoId: U,
      remoteUrlNormalized: repo.remoteNormalized,
      baseBranch: 'main',
      branchName: 'aom/toy-1-x',
    },
    defaultPath: path,
  });
  writeFileSync(join(path, 'card.txt'), 'card\n');
  sh(path, 'git', ['add', '-A']);
  sh(path, 'git', ['commit', '-qm', 'card']);
  await recordTip(path, 'refs/heads/aom/toy-1-x', sh(path, 'git', ['rev-parse', 'HEAD']), 'shift-end');
  return path;
}
function outside(repo: TestRepo, file: string, text = `${file}\n`) {
  const other = join(tmp(), `outside-${file}`);
  sh(repo.root, 'git', ['clone', '-q', repo.origin, other]);
  writeFileSync(join(other, file), text);
  sh(other, 'git', ['add', '-A']);
  sh(other, 'git', ['commit', '-qm', `outside ${file}`]);
  sh(other, 'git', ['push', '-q', 'origin', 'main']);
}

describe('B3 for merge-main (sync-main step 5 and the architect’s aom git merge-main)', () => {
  it('a clean merge moves the branch by compare-and-swap and records it; the worktree stays on the branch', async () => {
    const repo = makeRepo();
    const wt = await cardOn(repo);
    outside(repo, 'o.txt');
    const r = await mergeMainIntoCard(wt, { mainBranch: 'main', ref: 'TOY-1' });
    expect(r).toMatchObject({ result: 'merged_into_card' });
    const head = sh(wt, 'git', ['rev-parse', 'HEAD']);
    expect(sh(wt, 'git', ['branch', '--show-current'])).toBe('aom/toy-1-x');
    expect(await latestTip(wt, 'refs/heads/aom/toy-1-x')).toMatchObject({ sha: head, how: 'merged' });
  });

  it('S8 seam: the branch moved right after the merge is not moved over and not recorded', async () => {
    const repo = makeRepo();
    const wt = await cardOn(repo);
    outside(repo, 'o.txt');
    let fired = false;
    let sneak = '';
    setGitAfterHook((args, cwd) => {
      if (fired || args[0] !== 'merge' || cwd !== wt) return;
      fired = true;
      const tip = sh(wt, 'git', ['rev-parse', 'refs/heads/aom/toy-1-x']);
      sneak = sh(wt, 'git', ['commit-tree', `${tip}^{tree}`, '-p', tip, '-m', 'sneaked']);
      sh(wt, 'git', ['update-ref', 'refs/heads/aom/toy-1-x', sneak]);
    });
    const r = await mergeMainIntoCard(wt, { mainBranch: 'main', ref: 'TOY-1' });
    expect(fired).toBe(true);
    expect(r).toMatchObject({ error: expect.stringMatching(/moved while the runner worked/) });
    expect((await latestTip(wt, 'refs/heads/aom/toy-1-x'))?.sha).not.toBe(sneak);
  });

  it('a conflict is still left in the worktree, on the branch, for the agent; nothing is recorded', async () => {
    const repo = makeRepo();
    const wt = await cardOn(repo);
    writeFileSync(join(wt, 'README.md'), '# card\n');
    sh(wt, 'git', ['commit', '-qam', 'card readme']);
    const tip = sh(wt, 'git', ['rev-parse', 'HEAD']);
    await recordTip(wt, 'refs/heads/aom/toy-1-x', tip, 'shift-end');
    outside(repo, 'README.md', '# main\n');
    const r = await mergeMainIntoCard(wt, { mainBranch: 'main', ref: 'TOY-1' });
    expect(r).toMatchObject({ result: 'conflict_in_card', files: ['README.md'] });
    expect(sh(wt, 'git', ['branch', '--show-current'])).toBe('aom/toy-1-x');
    expect(sh(wt, 'git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).toBeTruthy();
    expect((await latestTip(wt, 'refs/heads/aom/toy-1-x'))?.sha).toBe(tip);
  });
});

describe('S7 for S13: the fence inside a folder the DevOps outer box binds writable', () => {
  it('fences the refs of a clone in the folder (plain clone and linked worktree), never outside it', async () => {
    const repo = makeRepo();
    const wt = await cardOn(repo);
    await (await writerStart(repo.clone))(); // the writer mark exists
    sh(repo.clone, 'git', ['update-ref', 'refs/remotes/origin/x', 'HEAD']);
    sh(repo.clone, 'git', ['tag', 'v9']);
    const folder = realpathSync(repo.scanRoot);
    const fence = folderRefFence(folder);
    const common = join(folder, 'toy', '.git');
    for (const p of [
      join(common, WRITER_MARK),
      join(common, 'refs', 'remotes'),
      join(common, 'refs', 'tags'),
      join(common, 'refs', 'heads', 'aom'),
    ])
      expect(fence, p).toContain(p);
    // main is the plain clone's own checkout: not fenced; nothing outside the folder is listed
    expect(fence).not.toContain(join(common, 'refs', 'heads', 'main'));
    expect(fence.every((p) => p.startsWith(`${folder}/`))).toBe(true);
    expect(wt).toBeTruthy();
  });

  it('the outer box binds the fence read-only after the writable folder’s fd bind', () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['tag', 'v9']);
    const folder = realpathSync(repo.scanRoot);
    const dir = mkdtempSync(join(tmp(), 'box-'));
    const plan = boxSandbox({
      level: 'outer',
      requestDir: dir,
      configDir: join(dir, 'config'),
      tmp: join(dir, 'tmp'),
      claudeBin: process.execPath,
      aomReadPaths: [],
      toolchainReadDirs: [],
      cloneDirs: [],
      fdBinds: [{ fdIndex: 3, real: folder, writable: true }],
    } as unknown as Parameters<typeof boxSandbox>[0]);
    expect(plan.fdFence).toContain(join(folder, 'toy', '.git', 'refs', 'tags'));
    mkdirSync(join(dir, 'config'), { recursive: true });
    mkdirSync(join(dir, 'tmp'), { recursive: true });
    const args = harnessBwrapArgs({
      ...plan,
      proxySocket: join(dir, 'p.sock'),
      bridgePort: 3128,
      hiddenFromShell: [],
    } as never);
    const fd = args.indexOf('--bind-fd');
    const ro = args.findIndex(
      (a, i) => a === '--ro-bind' && args[i + 1] === join(folder, 'toy', '.git', 'refs', 'tags'),
    );
    expect(fd).toBeGreaterThan(-1);
    expect(ro).toBeGreaterThan(fd);
  });
});

describe('R3-B1: sessions an earlier runner left running are killed before the recovery', () => {
  it('finds a session by AOM_SHIFT_ENV_FILE inside this runner’s data dir, with its children; never itself', () => {
    const root = '/data/runner';
    const procs = [
      { pid: 10, ppid: 1 },
      { pid: 11, ppid: 10 },
      { pid: 12, ppid: 11 },
      { pid: 20, ppid: 1 },
      { pid: process.pid, ppid: 1 },
    ];
    const env = (pid: number) =>
      pid === 10
        ? ['AOM_SHIFT_ENV_FILE=/data/runner/session-env/s1/session.env']
        : pid === 20
          ? ['AOM_SHIFT_ENV_FILE=/other/runner/session-env/s2/session.env']
          : pid === process.pid
            ? ['AOM_SHIFT_ENV_FILE=/data/runner/session-env/me/session.env']
            : [];
    expect(orphanSessionPids(root, procs, env).sort()).toEqual([10, 11, 12]);
  });

  it.skipIf(process.platform !== 'linux')(
    'kills a real orphaned session process and leaves others alone',
    async () => {
      const root = realpathSync(mkdtempSync(join(tmp(), 'runner-root-')));
      const other = realpathSync(mkdtempSync(join(tmp(), 'other-root-')));
      const start = (r: string) =>
        spawn('sleep', ['60'], {
          env: { ...process.env, AOM_SHIFT_ENV_FILE: join(r, 'session-env', 'x', 'session.env') },
          stdio: 'ignore',
        });
      const orphan = start(root);
      const keep = start(other);
      const dead = new Promise((r) => orphan.on('exit', r));
      await new Promise((r) => setTimeout(r, 200));
      expect(killOrphanSessions(root)).toBeGreaterThanOrEqual(1);
      await dead;
      expect(orphan.signalCode).toBe('SIGKILL');
      expect(keep.exitCode).toBeNull();
      keep.kill('SIGKILL');
    },
  );
});

describe('Rework 2: serialised writer starts, S13 under a parent folder, the broker destination', () => {
  it('a second writer start in the same clone waits until the first start’s snapshot is done', async () => {
    const repo = makeRepo();
    const order: string[] = [];
    let delayed = false;
    setGitAfterHook(async (args) => {
      if (!delayed && args[0] === 'for-each-ref' && args.includes('refs/heads/')) {
        delayed = true;
        await new Promise((r) => setTimeout(r, 300));
        order.push('first snapshot done');
      }
    });
    const a = writerStart(repo.clone).then((r) => {
      order.push('A started');
      return r;
    });
    const b = writerStart(repo.clone).then((r) => {
      order.push('B started');
      return r;
    });
    const [ra, rb] = await Promise.all([a, b]);
    expect(order.indexOf('first snapshot done')).toBeLessThan(order.indexOf('B started'));
    const key = realpathSync(join(repo.clone, '.git'));
    expect(tipStore()?.count(key)).toBe(2);
    await ra();
    await rb();
    expect(tipStore()?.count(key)).toBe(0);
  });

  it('S13: a writable parent folder counts, marks and materializes every clone below it', async () => {
    const repo = makeRepo();
    sh(repo.clone, 'git', ['pack-refs', '--all']);
    const release = await holdWriters([realpathSync(repo.scanRoot)]);
    const common = realpathSync(join(repo.clone, '.git'));
    expect(tipStore()?.count(common)).toBe(1);
    expect(existsSync(join(common, WRITER_MARK))).toBe(true);
    expect(existsSync(join(common, 'refs', 'heads', 'main'))).toBe(true);
    await release();
    expect(tipStore()?.count(common)).toBe(0);
  });

  it('B4: card:main is refused, even with a recorded card tip that is a fast-forward of origin', async () => {
    const repo = makeRepo();
    const wt = await cardOn(repo); // recorded at its shift end, on top of main
    const r = await resolveBrokerPush(repo.clone, ['aom/toy-1-x:main'], [], { args: [], env: {} });
    expect(r).toMatchObject({ error: expect.stringMatching(/push main from its own branch/) });
    expect(wt).toBeTruthy();
  });
});
