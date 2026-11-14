import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CheckLaunch } from '../src/checks/run.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { prepareWorktree, prepNote } from '../src/toolchain/prepare-worktree.ts';
import type { DepStep } from '../src/toolchain/types.ts';
import { cleanupTmp, makeRepo, sh, type TestRepo, tmp } from './helpers.ts';

cleanupTmp();

const spec = {
  mode: 'create' as const,
  repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  remoteUrlNormalized: 'x',
  baseBranch: 'main',
  branchName: 'aom/toy-1-x',
};

/** The tests run the steps unsandboxed (the runner passes the run-step sandbox's `checkLaunch`). */
const launch = async (argv: string[]): Promise<CheckLaunch> => ({
  cmd: argv[0] as string,
  args: argv.slice(1),
  env: { ...(process.env as Record<string, string>) },
});

const noStacks = () => [];
const steps =
  (...s: DepStep[]) =>
  () => [{ id: 'node', steps: s }];
const shStep = (name: string, script: string): DepStep => ({ name, cmd: 'sh', args: ['-c', script] });

async function newWorktree(repo: TestRepo): Promise<string> {
  const path = join(tmp(), 'wt');
  const wt = await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec, defaultPath: path });
  expect(wt.added).toBe(true);
  return path;
}

function commit(dir: string, files: Record<string, string>, message: string) {
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  sh(dir, 'git', ['add', '-A']);
  sh(dir, 'git', ['commit', '-m', message]);
  sh(dir, 'git', ['push', 'origin', 'main']);
}

describe('preparing a new card worktree', () => {
  it('a repository with a submodule: the submodule is checked out at its pinned commit', async () => {
    const x = makeRepo();
    const d = makeRepo();
    sh(d.clone, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', x.origin, 'core']);
    sh(d.clone, 'git', ['commit', '-m', 'add core']);
    sh(d.clone, 'git', ['push', 'origin', 'main']);
    const pinned = sh(d.clone, 'git', ['rev-parse', 'HEAD:core']);
    const path = await newWorktree(d);
    expect(existsSync(join(path, 'core', 'README.md'))).toBe(false);

    const prep = await prepareWorktree({
      worktree: path,
      repoPath: d.clone,
      findRepo: async (n) => (n === x.remoteNormalized ? { localPath: x.clone } : undefined),
      launch,
      platform: 'linux',
      stacks: noStacks,
    });
    expect(prep.ok).toBe(true);
    expect(prep.steps.map((s) => [s.name, s.status])).toEqual([['submodules', 'done']]);
    expect(sh(join(path, 'core'), 'git', ['rev-parse', 'HEAD'])).toBe(pinned);
    expect(existsSync(join(path, 'core', 'README.md'))).toBe(true);
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
    expect(prepNote(prep)).toMatch(/submodules done/);
  });

  it('a repository with an install step: it runs in the project folder with CI=true; its output is ignored', async () => {
    const repo = makeRepo();
    commit(repo.clone, { '.gitignore': 'deps/\n' }, 'ignore deps');
    const path = await newWorktree(repo);
    const prep = await prepareWorktree({
      worktree: path,
      repoPath: repo.clone,
      findRepo: async () => undefined,
      launch,
      platform: 'linux',
      stacks: steps(shStep('fake install', 'mkdir -p deps && printf "$CI" > deps/ok')),
    });
    expect(prep).toMatchObject({ ok: true, steps: [{ name: 'fake install', status: 'done' }] });
    expect(readFileSync(join(path, 'deps', 'ok'), 'utf8')).toBe('true');
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
    expect(prepNote(prep)).toMatch(/fake install done/);
    expect(prepNote(prep)).toMatch(/Do not ask DevOps/);
  });

  it('the default detection finds the stack from the table (an npm project runs npm install)', async () => {
    const repo = makeRepo();
    commit(repo.clone, { 'package.json': '{"name":"toy","version":"1.0.0"}\n' }, 'node project');
    const path = await newWorktree(repo);
    const seen: string[][] = [];
    const prep = await prepareWorktree({
      worktree: path,
      repoPath: repo.clone,
      findRepo: async () => undefined,
      launch: async (argv) => {
        seen.push(argv);
        return { cmd: 'true', args: [], env: { PATH: process.env.PATH ?? '' } };
      },
      platform: 'linux',
    });
    expect(seen).toEqual([['npm', 'install']]);
    expect(prep).toMatchObject({ ok: true, steps: [{ name: 'npm install', status: 'done' }] });
  });

  it('a repository with neither: no steps and no note', async () => {
    const repo = makeRepo();
    const path = await newWorktree(repo);
    const prep = await prepareWorktree({
      worktree: path,
      repoPath: repo.clone,
      findRepo: async () => undefined,
      launch,
      platform: 'linux',
    });
    expect(prep).toEqual({ ok: true, steps: [] });
    expect(prepNote(prep)).toBe('');
  });

  it('a failing step: not ok, with its output, and no throw; later steps of the stack do not run', async () => {
    const repo = makeRepo();
    const path = await newWorktree(repo);
    const prep = await prepareWorktree({
      worktree: path,
      repoPath: repo.clone,
      findRepo: async () => undefined,
      launch,
      platform: 'linux',
      stacks: steps(shStep('install', 'echo "registry unreachable" >&2; exit 3'), shStep('build', 'true')),
    });
    expect(prep.ok).toBe(false);
    expect(prep.steps).toHaveLength(1);
    expect(prep.steps[0]).toMatchObject({ name: 'install', status: 'failed' });
    expect(prep.steps[0]!.detail).toMatch(/exit 3: registry unreachable/);
    const note = prepNote(prep);
    expect(note).toMatch(/Not prepared:\n- install: exit 3/);
    expect(note).toMatch(/Ask DevOps only for what is listed as not prepared/);
  });

  it('a launcher that cannot start (no sandbox) fails the step; no launcher skips it', async () => {
    const repo = makeRepo();
    const path = await newWorktree(repo);
    const base = {
      worktree: path,
      repoPath: repo.clone,
      findRepo: async () => undefined,
      platform: 'linux' as const,
    };
    const refused = await prepareWorktree({
      ...base,
      launch: async () => {
        throw new Error('the service sandbox (bubblewrap) is not available');
      },
      stacks: steps(shStep('install', 'true')),
    });
    expect(refused.ok).toBe(false);
    expect(refused.steps[0]!.detail).toMatch(/bubblewrap/);
    const none = await prepareWorktree({ ...base, stacks: steps(shStep('install', 'true')) });
    expect(none.steps[0]).toMatchObject({ status: 'skipped' });
  });

  it('a tracked file the install changed is restored and reported; a new unignored file is removed', async () => {
    const repo = makeRepo();
    commit(repo.clone, { 'lock.txt': 'v1\n' }, 'lockfile');
    const path = await newWorktree(repo);
    const prep = await prepareWorktree({
      worktree: path,
      repoPath: repo.clone,
      findRepo: async () => undefined,
      launch,
      platform: 'linux',
      stacks: steps(shStep('install', 'echo v2 > lock.txt && echo junk > stray.txt')),
    });
    expect(readFileSync(join(path, 'lock.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(path, 'stray.txt'))).toBe(false);
    expect(sh(path, 'git', ['status', '--porcelain'])).toBe('');
    expect(prep.ok).toBe(true);
    const restore = prep.steps.find((s) => s.name === 'restore changed files');
    expect(restore).toMatchObject({ status: 'done' });
    expect(restore!.detail).toMatch(/lock\.txt/);
    expect(prepNote(prep)).toMatch(/they were restored: .*lock\.txt/);
  });

  it('over its budget: the running step is stopped and reported as failed', async () => {
    const repo = makeRepo();
    const path = await newWorktree(repo);
    const t0 = Date.now();
    const prep = await prepareWorktree({
      worktree: path,
      repoPath: repo.clone,
      findRepo: async () => undefined,
      launch,
      platform: 'linux',
      budgetMs: 300,
      stacks: steps(shStep('slow install', 'sleep 20')),
    });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(prep.ok).toBe(false);
    expect(prep.steps[0]).toMatchObject({ name: 'slow install', status: 'failed' });
    expect(prep.steps[0]!.detail).toMatch(/budget/);
  });

  it('a stop aborts the preparation', async () => {
    const repo = makeRepo();
    const path = await newWorktree(repo);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 200);
    const prep = await prepareWorktree({
      worktree: path,
      repoPath: repo.clone,
      findRepo: async () => undefined,
      launch,
      platform: 'linux',
      signal: ac.signal,
      stacks: steps(shStep('slow install', 'sleep 20'), shStep('next', 'true')),
    });
    expect(prep.ok).toBe(false);
    expect(prep.steps).toHaveLength(1);
    expect(prep.steps[0]!.detail).toMatch(/stopped/);
  });

  it('a reused worktree is not added again', async () => {
    const repo = makeRepo();
    const path = await newWorktree(repo);
    const again = await ensureWorktree({ repoPath: repo.clone, roots: ['/'], spec, defaultPath: path });
    expect(again.added).toBeUndefined();
  });
});
