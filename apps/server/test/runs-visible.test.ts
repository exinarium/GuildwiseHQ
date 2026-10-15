import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settingsHashOf } from '../src/commands/runs.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// rows as loose records (the tests read columns by name)
const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: ['runs:1'] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200, cookie = w.owner.cookie) =>
  ok<any>(w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) }), status);
const start = (body: Record<string, unknown> = {}, status = 201) =>
  call('POST', '/api/runs', { projectId: w.projectId, workstationId: w.workstationId, ...body }, status);
const envRow = async (id: string) => (await q('SELECT * FROM run_environments WHERE id=$1', [id]))[0];
const status = async (envId: string, state: string, extra: Record<string, unknown> = {}) => {
  r.send('run.status', { envId, state, services: [], ...extra });
  await r.barrier();
};
const list = async (query = '') => (await call('GET', `/api/runs${query}`)).environments as any[];
const settings = (extra: Record<string, unknown> = {}) => ({
  runInstructions: '',
  repoInstructions: [],
  settings: { ttlHours: 8, allowDocker: false, services: [], ...extra },
});

beforeEach(async () => {
  await q(
    `UPDATE run_environments SET state='stopped', stopped_at=now(), dismissed_at=now() WHERE state NOT IN ('stopped','failed')`,
  );
  await q(`UPDATE run_environments SET dismissed_at=now() WHERE dismissed_at IS NULL`);
  await q(`DELETE FROM runner_commands WHERE type IN ('run.start','run.stop','run.extend')`);
  await q(`UPDATE devops_requests SET status='done' WHERE status IN ('queued','running')`);
  await call('PUT', `/api/projects/${w.projectId}/run-settings`, settings());
});

describe('the Build guide setting', () => {
  it('is saved, validated, sent to the runner with run.start and part of the settings fingerprint', async () => {
    const before = await settingsHashOf(w.t.app.ctx.pool, w.projectId);
    const saved = await call(
      'PUT',
      `/api/projects/${w.projectId}/run-settings`,
      settings({ buildGuides: ['/home/u/src/dcode/sources/BUILD.md'] }),
    );
    expect(saved.settings.buildGuides).toEqual(['/home/u/src/dcode/sources/BUILD.md']);
    expect(await settingsHashOf(w.t.app.ctx.pool, w.projectId)).not.toBe(before);
    expect((await call('GET', `/api/projects/${w.projectId}/run-settings`)).settings.buildGuides).toEqual([
      '/home/u/src/dcode/sources/BUILD.md',
    ]);

    const { environment: env } = await start();
    const frame = await r.waitFor('command', (f) => f.command === 'run.start' && f.payload.envId === env.id);
    expect(frame.payload.buildGuides).toEqual(['/home/u/src/dcode/sources/BUILD.md']);

    // a relative path is refused
    await call(
      'PUT',
      `/api/projects/${w.projectId}/run-settings`,
      settings({ buildGuides: ['BUILD.md'] }),
      400,
    );
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });

  it('a plan whose fingerprint includes a changed guide hash is a different fingerprint (guides above the repositories)', async () => {
    const { environment: env } = await start();
    const plan = {
      version: 1,
      repos: [{ repoId: w.repoId }],
      setup: [],
      services: [
        {
          name: 'web',
          repoId: w.repoId,
          cwd: '.',
          cmd: ['npm', 'run', 'dev'],
          env: {},
          ports: [],
          health: { kind: 'none', graceSec: 3 },
          startTimeoutSec: 300,
          after: [],
          docker: false,
        },
      ],
      notes: '',
    };
    r.send('run.plan.saved', { envId: env.id, plan, buildHash: 'repo-guide-only' });
    await r.barrier();
    const first = (
      await q(`SELECT fingerprint FROM run_plans WHERE project_id=$1 AND status='active'`, [w.projectId])
    )[0];
    r.send('run.plan.saved', { envId: env.id, plan, buildHash: 'repo-guide-plus-parent-guide' });
    await r.barrier();
    const second = (
      await q(`SELECT fingerprint FROM run_plans WHERE project_id=$1 AND status='active'`, [w.projectId])
    )[0];
    expect(second.fingerprint).not.toBe(first.fingerprint);
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });
});

describe('a failed environment stays visible', () => {
  it('stays in the default list with the DevOps report as the reason, until it is dismissed', async () => {
    const { environment: env } = await start();
    await status(env.id, 'starting');
    // DevOps ends its request with its report, then the environment is given up
    await q(`UPDATE devops_requests SET status='done', result_summary=$2 WHERE id=$1`, [
      env.devopsRequestId,
      'The environment failed: Flow-Server needs a Couchbase server and none is running.',
    ]);
    await status(env.id, 'failed', { error: 'DevOps gave up', endReason: 'failed' });

    const shown = (await list()).find((e) => e.id === env.id);
    expect(shown).toMatchObject({
      state: 'failed',
      failureReason: 'The environment failed: Flow-Server needs a Couchbase server and none is running.',
      lastError: 'DevOps gave up',
      devopsRequestId: env.devopsRequestId,
      canRetry: true,
      canDismiss: true,
      waiting: null,
    });
    // on the card / project / workstation lists too
    expect((await list(`?projectId=${w.projectId}`)).some((e) => e.id === env.id)).toBe(true);
    expect((await list(`?workstationId=${w.workstationId}`)).some((e) => e.id === env.id)).toBe(true);

    const dismissed = await call('POST', `/api/runs/${env.id}/dismiss`);
    expect(dismissed.environment.canDismiss).toBe(false);
    expect((await list()).some((e) => e.id === env.id)).toBe(false);
    // the history still has it
    expect((await list('?live=false')).some((e) => e.id === env.id)).toBe(true);
  });

  it('falls back to the last error when DevOps wrote no report; a stranger may not dismiss or retry', async () => {
    const { environment: env } = await start();
    await status(env.id, 'failed', {
      error: 'the runner could not prepare the environment',
      endReason: 'failed',
    });
    const shown = (await list()).find((e) => e.id === env.id);
    expect(shown.failureReason).toBe('the runner could not prepare the environment');
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    await call('POST', `/api/runs/${env.id}/dismiss`, undefined, 404, stranger.cookie);
    await call('POST', `/api/runs/${env.id}/retry`, undefined, 404, stranger.cookie);
  });

  it('a running environment cannot be dismissed', async () => {
    const { environment: env } = await start();
    await status(env.id, 'starting');
    await call('POST', `/api/runs/${env.id}/dismiss`, undefined, 409);
    await call('POST', `/api/runs/${env.id}/retry`, undefined, 409);
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });

  it('Try again starts the same selection anew and dismisses the failed one', async () => {
    await q('UPDATE project_repos SET working_branch=$2 WHERE id=$1', [w.repoId, 'main']);
    const { environment: env } = await start({ sources: [{ repoId: w.repoId, branch: 'main' }] });
    await status(env.id, 'failed', { error: 'boom', endReason: 'failed' });
    const again = await call('POST', `/api/runs/${env.id}/retry`, undefined, 201);
    expect(again.environment.id).not.toBe(env.id);
    expect(again.environment.sources).toEqual(env.sources);
    expect(again.environment.state).toBe('requested');
    expect(again.environment.workstationId).toBe(env.workstationId);
    await until(
      async () => (await envRow(env.id)).dismissed_at !== null,
      5000,
      'the old one to be dismissed',
    );
    const ids = (await list()).map((e) => e.id);
    expect(ids).toContain(again.environment.id);
    expect(ids).not.toContain(env.id);
    await call('POST', `/api/runs/${again.environment.id}/stop`, undefined, 202);
  });
});

describe('waiting for the owner', () => {
  it('shows what DevOps asked while its request waits for an answer, and clears it when answered', async () => {
    const { environment: env } = await start();
    await status(env.id, 'starting');
    const approval = {
      deskItemId: '00000000-0000-4000-8000-000000000001',
      action: 'Question: Flow-Server needs Couchbase at couchbase://localhost',
      reason: 'A) use the Couchbase on 192.168.1.12 B) allow Docker C) give me a connection string',
      commands: [],
      resolution: null,
    };
    await q(`UPDATE devops_requests SET status='needs_approval', approval=$2::jsonb WHERE id=$1`, [
      env.devopsRequestId,
      JSON.stringify(approval),
    ]);
    const waiting = (await list()).find((e) => e.id === env.id);
    expect(waiting.state).toBe('starting'); // still live: the cap and the runner keep it
    expect(waiting.waiting).toEqual({ action: approval.action, reason: approval.reason });
    expect(waiting.devopsRequestId).toBe(env.devopsRequestId);

    await q(`UPDATE devops_requests SET status='queued', approval=$2::jsonb WHERE id=$1`, [
      env.devopsRequestId,
      JSON.stringify({ ...approval, resolution: 'approved' }),
    ]);
    expect((await list()).find((e) => e.id === env.id).waiting).toBeNull();
    await call('POST', `/api/runs/${env.id}/stop`, undefined, 202);
  });
});
