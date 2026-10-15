import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeShiftStart } from './fixtures.ts';
import { type Harness, startHarness } from './harness.ts';
import { cleanupTmp, makeRepo, sh, waitUntil } from './helpers.ts';
import { ScriptedAdapter } from './scripted-adapter.ts';
import { makeDevopsStart } from './vault-fixtures.ts';

cleanupTmp();
let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});

const SERVER_JS = `require('http').createServer((q, s) => s.end('ok')).listen(Number(process.env.PORT), '127.0.0.1'); setInterval(() => {}, 1000);`;

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}

function repoWithServer() {
  const repo = makeRepo();
  writeFileSync(join(repo.clone, 'server.js'), SERVER_JS);
  writeFileSync(join(repo.clone, 'BUILD.md'), '# How to run\nUse node server.js with PORT.\n');
  // the guide of the folder above the clone (in no repository)
  writeFileSync(
    join(repo.scanRoot, 'BUILD.md'),
    '# Above the repositories\nStart the embedded server first.\n',
  );
  sh(repo.clone, 'git', ['add', '-A']);
  sh(repo.clone, 'git', ['commit', '-m', 'server']);
  return repo;
}

describe('run a branch through the runner', () => {
  it('prepares the worktrees on run.start, briefs DevOps with BUILD.md, runs aom run calls and reports status and the plan', async () => {
    const repo = repoWithServer();
    const envId = randomUUID();
    const requestId = randomUUID();
    const repoId = randomUUID();
    const port = await freePort();
    const seen: Record<string, any> = {};
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      seen.info = await ctl.post('/v1/rpc', { method: 'run.info', params: {} });
      seen.service = await ctl.post('/v1/rpc', {
        method: 'run.service',
        params: {
          name: 'web',
          cmd: ['node', 'server.js'],
          ports: [{ name: 'http', default: port, envVar: 'PORT', url: 'http://localhost:${port}/' }],
          health: { kind: 'http', url: 'http://127.0.0.1:${port}/', expect: '2xx' },
        },
      });
      seen.other = await ctl.post('/v1/rpc', { method: 'run.info', params: { env: randomUUID() } });
      seen.ready = await ctl.post('/v1/rpc', { method: 'run.ready', params: { notes: 'node it is' } });
      await ctl.post('/v1/report', {
        report: {
          kind: 'outcome',
          outcomeId: 'devops_done',
          note: 'n',
          data: { summary: 'running', commands: [] },
        },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) }, repo);

    h.server.send('command', {
      commandId: 'c-run-start',
      command: 'run.start',
      payload: {
        envId,
        projectId: randomUUID(),
        projectKey: 'TOY',
        projectName: 'Toy',
        purpose: 'manual',
        requestId,
        sources: [{ repoId, name: 'toy', remoteUrlNormalized: repo.remoteNormalized, branch: 'main' }],
        services: [],
        portRange: { from: 42000, to: 42400 },
        ttlAt: new Date(Date.now() + 3600_000).toISOString(),
        allowDocker: false,
      },
    });
    const started = await h.server.waitFor('command.result', (m) => m.commandId === 'c-run-start');
    expect(started).toMatchObject({ ok: true, result: { ok: true } });
    await waitUntil(
      () => h!.server.of('run.status').some((s) => s.envId === envId && s.state === 'starting'),
      10_000,
      'run.status starting',
    );

    const start = makeDevopsStart({ summary: 'Run toy@main' }) as any;
    start.devops.requestId = requestId;
    start.devops.run = {
      envId,
      purpose: 'manual',
      projectKey: 'TOY',
      projectName: 'Toy',
      sources: [{ repoId, name: 'toy', branch: 'main' }],
      services: [],
      runInstructions: 'Prefer the default port.',
      repoInstructions: [],
      declared: [],
      currentPlan: null,
      planStatus: null,
      portRange: { from: 42000, to: 42400 },
      allowDocker: false,
      ttlAt: null,
      buildDocs: [],
      buildGuides: [],
      pathMap: [],
    };
    h.server.send('shift.start', start);
    const ended = await h.server.waitFor('shift.ended', (m) => m.shiftId === start.shiftId, 60_000);
    expect(ended.outcome).toBe('reported');

    // The runner found BUILD.md in the run worktree and put it, and the commit, into the brief.
    const prompt = adapter.inputs[0]?.prompt ?? '';
    expect(prompt).toContain('Run request: Toy (TOY)');
    expect(prompt).toContain('Use node server.js with PORT.');
    expect(prompt).toContain('Prefer the default port.');
    // ... and the guide above the repository, with its absolute path and the checkout-to-worktree mapping
    expect(prompt).toContain(`Build guide above the repositories: ${join(repo.scanRoot, 'BUILD.md')}`);
    expect(prompt).toContain('Start the embedded server first.');
    expect(prompt).toContain(`${repo.clone} => `);
    expect(prompt).toContain(`--env ${envId}`);

    expect(seen.info.json.result.message).toContain('run-');
    expect(seen.service.json.result.message).toMatch(/healthy/);
    expect(seen.other.json.ok).toBe(false);
    expect(seen.other.json.error).toMatch(/works environment/);
    expect(seen.ready.json.result.message).toMatch(/Ready/);

    const status = [...h.server.of('run.status')].reverse().find((s) => s.envId === envId)!;
    expect(status.state).toBe('healthy');
    expect(status.services[0]).toMatchObject({ name: 'web', state: 'healthy' });
    expect(status.services[0]?.urls).toEqual([`http://localhost:${port}/`]);
    const saved = h.server.of('run.plan.saved').find((s) => s.envId === envId)!;
    expect(saved.plan.services[0]).toMatchObject({ name: 'web', cmd: ['node', 'server.js'] });
    expect(saved.plan.notes).toBe('node it is');

    // The service is not a child of the shift: it is still up after the shift, until run.stop.
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    h.server.send('command', {
      commandId: 'c-run-stop',
      command: 'run.stop',
      payload: { envId, reason: 'stopped' },
    });
    await h.server.waitFor('command.result', (m) => m.commandId === 'c-run-stop');
    const last = [...h.server.of('run.status')].reverse().find((s) => s.envId === envId)!;
    expect(last).toMatchObject({ state: 'stopped', endReason: 'stopped' });
    await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
  });

  it('announces the capability and the cap in hello', async () => {
    const repo = repoWithServer();
    h = await startHarness({}, {}, repo);
    const hello = h.server.of('hello')[0];
    expect(hello?.capabilities).toContain('runs:1');
    expect(hello?.maxRunEnvironments).toBe(2);
  });

  it('refuses aom run to a shift that is not a DevOps run request', async () => {
    const seen: Record<string, any> = {};
    const adapter = new ScriptedAdapter(async (_i, ctl) => {
      seen.r = await ctl.post('/v1/rpc', { method: 'run.info', params: {} });
      await ctl.post('/v1/report', {
        report: { kind: 'outcome', outcomeId: 'handoff', note: 'n', data: {} },
      });
    });
    h = await startHarness({}, { adapters: new Map([['mock', adapter]]) });
    const msg = makeShiftStart({ stage: 'build', remoteNormalized: h.repo.remoteNormalized });
    h.server.send('shift.start', msg);
    await h.server.waitFor('shift.ended', (m) => m.shiftId === msg.shiftId, 60_000);
    expect(seen.r.json.ok).toBe(false);
    expect(seen.r.json.error).toMatch(/only for the DevOps engineer/);
  });

  it('a run.start for an unknown branch is an answer with the reason', async () => {
    const repo = repoWithServer();
    h = await startHarness({}, {}, repo);
    h.server.send('command', {
      commandId: 'c-bad',
      command: 'run.start',
      payload: {
        envId: randomUUID(),
        projectId: randomUUID(),
        projectKey: 'TOY',
        projectName: 'Toy',
        purpose: 'manual',
        requestId: randomUUID(),
        sources: [
          { repoId: randomUUID(), name: 'toy', remoteUrlNormalized: repo.remoteNormalized, branch: 'ghost' },
        ],
        services: [],
        portRange: { from: 42000, to: 42400 },
        ttlAt: new Date(Date.now() + 3600_000).toISOString(),
        allowDocker: false,
      },
    });
    const r = await h.server.waitFor('command.result', (m) => m.commandId === 'c-bad');
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ ok: false });
    expect(JSON.stringify(r.result)).toMatch(/ghost/);
  });
});
