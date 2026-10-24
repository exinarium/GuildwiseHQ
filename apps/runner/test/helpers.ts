import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeRemoteUrl } from '@aom/shared';
import { afterAll } from 'vitest';
import { type RunnerConfig, RunnerConfigSchema } from '../src/config.ts';

const dirs: string[] = [];

export function tmp(prefix = 'aom-runner-test-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Call once per test file to remove temp dirs. */
export function cleanupTmp(): void {
  afterAll(() => {
    // a shift that is still wrapping up may write into its directory while it is removed (ENOTEMPTY): retry instead of failing the file
    for (const d of dirs.splice(0))
      rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.test',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function sh(cwd: string, cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...GIT_ENV },
  }).trim();
}

export interface TestRepo {
  root: string;
  /** Bare origin. */
  origin: string;
  /** Working clone; its parent is the repo root to scan. */
  clone: string;
  scanRoot: string;
  remoteNormalized: string;
}

/** Bare origin + clone with one commit on `main` (and a unit test file) pushed to origin. */
export function makeRepo(): TestRepo {
  const root = tmp();
  const origin = join(root, 'origin.git');
  const scanRoot = join(root, 'work');
  const clone = join(scanRoot, 'toy');
  mkdirSync(scanRoot, { recursive: true });
  sh(root, 'git', ['init', '--bare', '-b', 'main', origin]);
  sh(scanRoot, 'git', ['clone', origin, clone]);
  sh(clone, 'git', ['checkout', '-b', 'main']);
  writeFileSync(join(clone, 'README.md'), '# toy\n');
  mkdirSync(join(clone, 'test'), { recursive: true });
  writeFileSync(join(clone, 'test', 'existing.test.ts'), '// existing test\n');
  sh(clone, 'git', ['add', '-A']);
  sh(clone, 'git', ['commit', '-m', 'initial']);
  sh(clone, 'git', ['push', '-u', 'origin', 'main']);
  return { root, origin, clone, scanRoot, remoteNormalized: normalizeRemoteUrl(origin) };
}

export function makeConfig(serverUrl: string, over: Partial<RunnerConfig> = {}): RunnerConfig {
  return RunnerConfigSchema.parse({
    serverUrl,
    workstationId: '019e3f6a-7b1c-7a2d-8c3e-0123456789b1',
    runnerToken: 'aomr_testtoken',
    runtimes: { mock: { enabled: true } },
    ...over,
  });
}

export const waitUntil = async (
  pred: () => boolean | Promise<boolean>,
  ms = 10_000,
  what = 'condition',
): Promise<void> => {
  const start = Date.now();
  // The wait ends the moment the condition holds: the bound only matters on failure, and git/process work under a
  // loaded machine is far slower than the per-call guesses.
  const bound = Math.max(ms, 30_000);
  while (!(await pred())) {
    if (Date.now() - start > bound) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Make `dir` a git repository with one commit of everything in it. Same files, author and dates always give the same commit id. */
export function gitCommit(dir: string): void {
  const env = {
    PATH: process.env.PATH,
    HOME: dir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
    GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
  };
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['add', '-A'],
    ['commit', '-q', '-m', 'init'],
  ]) {
    const r = spawnSync('git', args, { cwd: dir, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  }
}
