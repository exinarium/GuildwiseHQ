import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Release-readiness O1: switching "Works for" off for an organization stops that organization's run environments that
 * still run on the workstation (run.stop queued, state stopping), leaves other organizations' environments alone, and
 * refuses to restart or revive one there while it is off.
 */
let w: World;
let r: FakeRunner;
let orgX: string;
let orgY: string;
let projectY: string;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: ['runs:1', 'runs:2'] });
  orgX = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id;
  orgY = await w.t.createOrg(w.owner.id, 'Other org');
  const p = await ok<any>(
    w.t.req('POST', '/api/projects', {
      cookie: w.owner.cookie,
      headers: { 'x-aom-org': orgY },
      body: { key: 'OTH', name: 'Other' },
    }),
    201,
  );
  projectY = p.project.id;
  await ok(
    w.t.req('PUT', `/api/workstations/${w.workstationId}/orgs/${orgY}`, {
      cookie: w.owner.cookie,
      body: { serving: true },
    }),
  );
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const call = (method: string, url: string, body?: unknown, status = 200) =>
  w.t
    .req(method as 'GET', url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) })
    .then((x) => {
      if (x.status !== status) throw new Error(`${method} ${url}: ${x.status} ${JSON.stringify(x.body)}`);
      return x.body;
    });
const envRow = async (id: string) => (await q('SELECT * FROM run_environments WHERE id=$1', [id]))[0]!;
const stopsOf = (envId: string) =>
  q(`SELECT payload FROM runner_commands WHERE type='run.stop' AND payload->>'envId'=$1`, [envId]);
const status = async (envId: string, state: string, extra: Record<string, unknown> = {}) => {
  r.send('run.status', { envId, state, services: [], ...extra });
  await r.barrier();
};
const PLAN = () => ({
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
      ports: [{ name: 'http', default: 5173, envVar: 'PORT' }],
      health: { kind: 'none', graceSec: 3 },
      startTimeoutSec: 300,
      after: [],
      docker: false,
    },
  ],
  notes: 'plan',
});

describe('O1: Works for off stops that organization’s run environments on the workstation', () => {
  it('X’s live environment stops, Y’s keeps running, and reviving X’s there is refused', async () => {
    const start = () =>
      call('POST', '/api/runs', { projectId: w.projectId, workstationId: w.workstationId }, 201);
    // a saved plan (the DevOps flow once), then a replayed, healthy environment of organization X
    const first = (await start()).environment;
    r.send('run.plan.saved', { envId: first.id, plan: PLAN(), buildHash: 'build-1' });
    await r.barrier();
    await status(first.id, 'stopped', { endReason: 'stopped' });
    const x = (await start()).environment;
    await status(x.id, 'healthy', {
      services: [{ name: 'web', state: 'healthy', ports: [], urls: ['http://localhost:5173/'] }],
    });
    expect((await envRow(x.id)).state).toBe('healthy');

    // a healthy environment of organization Y on the same workstation
    const y = randomUUID();
    await q(
      `INSERT INTO run_environments SELECT (jsonb_populate_record(NULL::run_environments, to_jsonb(e) || jsonb_build_object(
          'id', $2::uuid, 'org_id', $3::uuid, 'project_id', $4::uuid, 'branch_key', 'other'))).*
         FROM run_environments e WHERE e.id=$1`,
      [x.id, y, orgY, projectY],
    );
    expect((await envRow(y)).state).toBe('healthy');

    await q(`UPDATE shifts SET status='ended' WHERE status <> 'ended'`);
    await call('PUT', `/api/workstations/${w.workstationId}/orgs/${orgX}`, { serving: false });

    const stopped = await envRow(x.id);
    expect(stopped.state).toBe('stopping');
    expect(stopped.stop_requested_at).not.toBeNull();
    expect((await stopsOf(x.id)).map((c) => c.payload.reason)).toEqual(['stopped']);
    const ev = await q(
      `SELECT payload FROM events WHERE type='RunEnvironmentStopRequested' AND payload->>'envId'=$1`,
      [x.id],
    );
    expect(ev.map((e) => e.payload.by)).toEqual([w.owner.id]);

    // the other organization's environment is untouched
    const other = await envRow(y);
    expect(other.state).toBe('healthy');
    expect(other.stop_requested_at).toBeNull();
    expect(await stopsOf(y)).toHaveLength(0);

    // the runner stops it; reviving it on this workstation is refused while it does not work for X
    await status(x.id, 'stopped', { endReason: 'stopped' });
    const res = await w.t.req('POST', `/api/runs/${x.id}/restart`, { cookie: w.owner.cookie, body: {} });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('workstation_not_serving');
    expect((await envRow(x.id)).state).toBe('stopped');
  });
});
