import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { uuidv7 } from '@aom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { PrCreator } from '../src/git/gh.ts';
import { ensureWorktree } from '../src/git/worktrees.ts';
import { defaultEnvChecker } from '../src/testing/environment.ts';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness, worktreeOf } from './harness.ts';
import { cleanupTmp, sh, tmp, waitUntil } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const pass = {
  report: {
    kind: 'outcome',
    outcomeId: 'pass',
    note: 'ok',
    data: { summary: 'ok', commands: [], outputExcerpt: '' },
  },
};

async function start(runnerOpts: Parameters<typeof startHarness>[1] = {}) {
  const adapter = new ScriptedAdapter(async (_i, ctl) => {
    await ctl.post('/v1/report', pass);
  });
  h = await startHarness({}, { adapters: new Map([['mock', adapter]]), ...runnerOpts });
  return adapter;
}

describe('tester environment check (spec: deployed app, Docker required)', () => {
  it('a tester whose environment is not ready is rejected before any session starts', async () => {
    const adapter = await start();
    const msg = makeShiftStart({
      stage: 'test',
      remoteNormalized: h!.repo.remoteNormalized,
      fields: { mockEnv: 'app_not_deployed' },
    });
    // the worktree must exist for a later stage: create it with a build shift first
    h!.server.send(
      'shift.start',
      makeShiftStart({ stage: 'build', remoteNormalized: h!.repo.remoteNormalized }),
    );
    await h!.server.waitFor('shift.ended');
    const started = adapter.inputs.length;
    h!.server.send('shift.start', msg);
    const rej = await h!.server.waitFor('shift.rejected', (m) => m.shiftId === msg.shiftId, 20_000);
    expect(rej).toMatchObject({
      reason: 'environment_not_ready',
      environment: { problem: 'app_not_deployed' },
    });
    expect(adapter.inputs.length).toBe(started);
    expect(h!.server.of('shift.accepted').some((m) => m.shiftId === msg.shiftId)).toBe(false);
  });

  it('once DevOps fixed it (marker) the same card runs; builders are never checked', async () => {
    const adapter = await start();
    const remote = h!.repo.remoteNormalized;
    h!.server.send(
      'shift.start',
      makeShiftStart({ stage: 'build', remoteNormalized: remote, fields: { mockEnv: 'docker_missing' } }),
    );
    const built = await h!.server.waitFor('shift.ended');
    expect(built.outcome).toBeDefined();
    expect(h!.server.of('shift.rejected')).toHaveLength(0);

    const first = makeShiftStart({
      stage: 'test',
      remoteNormalized: remote,
      fields: { mockEnv: 'docker_missing' },
    });
    h!.server.send('shift.start', first);
    await h!.server.waitFor('shift.rejected', (m) => m.shiftId === first.shiftId, 20_000);

    mkdirSync(h!.runner.paths.mockState, { recursive: true });
    writeFileSync(join(h!.runner.paths.mockState, 'env-ok-docker_missing'), 'ok\n');
    const second = makeShiftStart({
      stage: 'test',
      remoteNormalized: remote,
      fields: { mockEnv: 'docker_missing' },
    });
    h!.server.send('shift.start', second);
    const ended = await h!.server.waitFor('shift.ended', (m) => m.shiftId === second.shiftId, 20_000);
    expect(ended.outcome).toBe('reported');
    expect(adapter.inputs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('default environment checker', () => {
  const msg = (runtime = 'claude-code') => {
    const m = makeShiftStart({ stage: 'test', remoteNormalized: 'x' }) as any;
    m.agent.runtime = runtime;
    return m;
  };
  const paths = { mockState: '/nonexistent' } as never;

  it('missing Docker is docker_missing', async () => {
    const check = defaultEnvChecker({
      dockerOk: async () => ({ ok: false, detail: 'docker: command not found' }),
    });
    expect(await check({ msg: msg(), worktree: null, paths })).toEqual({
      problem: 'docker_missing',
      detail: 'docker: command not found',
    });
  });

  it('with Docker up and no further checks the environment is fine', async () => {
    const check = defaultEnvChecker({ dockerOk: async () => ({ ok: true, detail: '' }) });
    expect(await check({ msg: msg(), worktree: tmp(), paths })).toBeNull();
  });

  it('a retired .aom/test-env.json is ignored', async () => {
    const dir = tmp();
    mkdirSync(join(dir, '.aom'));
    writeFileSync(
      join(dir, '.aom', 'test-env.json'),
      JSON.stringify({ healthUrl: 'http://app.test/health' }),
    );
    const check = defaultEnvChecker({ dockerOk: async () => ({ ok: true, detail: '' }) });
    expect(await check({ msg: msg(), worktree: dir, paths })).toBeNull();
  });

  it('the mock runtime never touches Docker', async () => {
    const check = defaultEnvChecker({
      dockerOk: async () => {
        throw new Error('must not be called');
      },
    });
    expect(await check({ msg: msg('mock'), worktree: null, paths })).toBeNull();
  });
});

describe('finalize.execute command', () => {
  async function send(payload: Record<string, unknown>) {
    const commandId = uuidv7();
    h!.server.send('command', { commandId, command: 'finalize.execute', payload });
    return h!.server.waitFor('command.result', (m) => m.commandId === commandId, 30_000);
  }
  const base = (over: Record<string, unknown> = {}) => ({
    cardId: uuidv7(),
    ref: 'TOY-1',
    title: 'Add thing',
    projectKey: 'TOY',
    action: 'merge',
    repoId: uuidv7(),
    remoteUrlNormalized: h!.repo.remoteNormalized,
    baseBranch: 'main',
    branchName: 'aom/toy-1-add-thing',
    worktreePath: null,
    ...over,
  });
  async function cardBranch(file = 'thing.txt') {
    const path = worktreeOf(h!);
    await ensureWorktree({
      repoPath: h!.repo.clone,
      roots: ['/'],
      spec: {
        mode: 'create',
        repoId: uuidv7(),
        remoteUrlNormalized: 'x',
        baseBranch: 'main',
        branchName: 'aom/toy-1-add-thing',
      },
      defaultPath: path,
    });
    writeFileSync(join(path, file), 'thing\n');
    sh(path, 'git', ['add', '-A']);
    sh(path, 'git', ['commit', '-m', 'add thing']);
    return path;
  }

  it('merges and reports the merge commit; the PR adapter is the injected fake', async () => {
    const calls: unknown[] = [];
    const pr: PrCreator = {
      async create(i) {
        calls.push(i);
        return { url: 'https://example.test/pull/1' };
      },
    };
    await start({ prCreator: pr });
    await cardBranch();
    const res = await send(base());
    expect(res.ok).toBe(true);
    expect((res.result as any).mergeCommit).toBe(sh(h!.repo.origin, 'git', ['rev-parse', 'main']));

    const path2 = await (async () => {
      sh(h!.repo.clone, 'git', ['worktree', 'remove', '--force', worktreeOf(h!)]);
      sh(h!.repo.clone, 'git', ['branch', '-D', 'aom/toy-1-add-thing']);
      return cardBranch('second.txt');
    })();
    expect(existsSync(path2)).toBe(true);
    const prRes = await send(base({ action: 'pr', cardId: uuidv7() }));
    expect((prRes.result as any).prUrl).toBe('https://example.test/pull/1');
    expect(calls).toHaveLength(1);
  });

  it('reports expected failures in the result, not as a command failure', async () => {
    await start();
    const res = await send(base({ worktreePath: '/etc/outside-the-runner' }));
    expect(res.ok).toBe(true);
    expect((res.result as any).ok).toBe(false);
    expect((res.result as any).error).toMatch(/worktree is not available/);
    const unknown = await send(base({ remoteUrlNormalized: 'example.test/none/none' }));
    expect((unknown.result as any).error).toMatch(/no local clone/);
    expect(readFileSync(join(h!.repo.clone, 'README.md'), 'utf8')).toContain('toy');
  });
});
