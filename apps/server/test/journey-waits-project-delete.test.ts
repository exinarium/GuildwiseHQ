import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { journeyTick } from '../src/journeys/tick.ts';
import { fireDueWaits } from '../src/journeys/waits.ts';
import { callDue } from '../src/journeys/webhook-calls.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Deleting a project removes its waits, webhook calls, hook triggers and hook call log, and rows whose instance is no
 * longer waiting at that visit never fill a due batch, so other projects' timers keep firing.
 */
let w: World;
const ctx = () => w.t.app.ctx;
const MIN = 60_000;
const asOwner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );
const create = async (projectId: string, onTimeout: unknown) =>
  (
    await asOwner(
      'POST',
      '/api/journeys',
      {
        projectId,
        definition: {
          name: 'J',
          recordType: 'client',
          firstStepId: 'a',
          steps: [
            {
              kind: 'wait',
              id: 'a',
              label: 'a',
              waitFor: { kind: 'webhook', triggerId: randomUUID() },
              duration: { amount: 10, unit: 'minutes' },
              onTimeout,
            },
            { kind: 'wait', id: 'late', label: 'late' },
          ],
          handoffs: [],
        },
      },
      201,
    )
  ).id as string;
const start = async (journeyId: string) =>
  (
    await asOwner(
      'POST',
      '/api/journey-instances',
      { journeyId, record: { type: 'client', displayName: 'Ann' } },
      201,
    )
  ).id as string;
const waitRow = async (id: string) =>
  (await q('SELECT * FROM journey_waits WHERE instance_id=$1', [id]))[0] as any;

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('stale due rows', () => {
  it('a due wait still fires when more than a batch of stale rows (instance gone) come first', async () => {
    const j = await create(w.projectId, { action: 'goto', stepId: 'late' });
    const id = await start(j);
    for (let i = 0; i < 3; i++) await journeyTick(ctx(), { projectId: w.projectId });
    expect((await waitRow(id)).status).toBe('open');

    // 60 open waits and 60 due calls whose instances do not exist, all due long before the real one.
    const old = new Date(ctx().clock.now().getTime() - 60 * MIN);
    const org = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id;
    const ghostProject = randomUUID();
    for (let i = 0; i < 60; i++) {
      await q(
        `INSERT INTO journey_waits (id, org_id, project_id, journey_id, instance_id, visit, step_id, kind, status, started_at, next_fire_at, deadline_at, config)
         VALUES ($1,$2,$3,$4,$5,1,'a','duration','open',$6,$6,$6,'{}')`,
        [randomUUID(), org, ghostProject, randomUUID(), randomUUID(), old],
      );
      await q(
        `INSERT INTO journey_webhook_calls (id, org_id, project_id, instance_id, visit, step_id, workstation_id, status, next_attempt_at, started_at)
         VALUES ($1,$2,$3,$4,1,'c',$5,'pending',$6,$6)`,
        [randomUUID(), org, ghostProject, randomUUID(), randomUUID(), old],
      );
    }

    ctx().clock.advance(11 * MIN);
    // Global passes (no project filter), as the scheduler runs them.
    expect(await fireDueWaits(ctx())).toBeGreaterThanOrEqual(1);
    expect(await waitRow(id)).toMatchObject({ status: 'resolved' });
    // The stale calls are never picked, so callDue has nothing of theirs to try.
    expect(await callDue(ctx(), ghostProject)).toBe(0);

    await q('DELETE FROM journey_waits WHERE project_id=$1', [ghostProject]);
    await q('DELETE FROM journey_webhook_calls WHERE project_id=$1', [ghostProject]);
  });
});

describe('deleting a project with waits, calls and hooks', () => {
  it('leaves no journey_waits, journey_webhook_calls, journey_hook_triggers or journey_hook_calls rows', async () => {
    const j = await create(w.projectId, { action: 'escalate' });
    const id = await start(j);
    for (let i = 0; i < 3; i++) await journeyTick(ctx(), { projectId: w.projectId });
    expect(await waitRow(id)).toBeTruthy();
    const hook = await asOwner(
      'POST',
      `/api/journeys/${j}/hooks`,
      { name: 'Intake', purpose: 'start', mapping: { externalId: '/id', displayName: '/name' } },
      201,
    );
    const triggerId = (hook.id ?? hook.trigger?.id) as string;
    expect(triggerId).toBeTruthy();
    const org = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id;
    await q(
      `INSERT INTO journey_hook_calls (id, trigger_id, org_id, at, status, outcome, size_bytes, latency_ms)
       VALUES ($1,$2,$3,now(),401,'bad_signature',10,1)`,
      [randomUUID(), triggerId, org],
    );
    await q(
      `INSERT INTO journey_webhook_calls (id, org_id, project_id, instance_id, visit, step_id, workstation_id, status, next_attempt_at, started_at)
       VALUES ($1,$2,$3,$4,2,'c',$5,'pending',now(),now())`,
      [randomUUID(), org, w.projectId, id, randomUUID()],
    );

    const key = (await q('SELECT key FROM projects WHERE id=$1', [w.projectId]))[0]!.key as string;
    await asOwner('POST', `/api/projects/${w.projectId}/archive`);
    await asOwner('POST', `/api/projects/${w.projectId}/delete`, { confirmKey: key });

    expect(await q('SELECT 1 FROM journey_waits WHERE project_id=$1', [w.projectId])).toHaveLength(0);
    expect(await q('SELECT 1 FROM journey_webhook_calls WHERE project_id=$1', [w.projectId])).toHaveLength(0);
    expect(await q('SELECT 1 FROM journey_hook_triggers WHERE project_id=$1', [w.projectId])).toHaveLength(0);
    expect(await q('SELECT 1 FROM journey_hook_calls WHERE trigger_id=$1', [triggerId])).toHaveLength(0);
  });
});
