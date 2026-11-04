import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { journeyTick } from '../src/journeys/tick.ts';
import { applyJourneyWebhookResult } from '../src/journeys/webhook-calls.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Outbound webhook steps (docs/investigations/GWP-67 D6): the workstation sends, the server keeps the schedule. These
 * tests answer for the workstation by calling the gateway's handler with the result the runner would send.
 */
let w: World;
const ctx = () => w.t.app.ctx;
const MIN = 60_000;
const asOwner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );
const tick = async (n = 2) => {
  for (let i = 0; i < n; i++) await journeyTick(ctx(), { projectId: w.projectId });
};

const call = (over: Record<string, unknown> = {}) => ({
  kind: 'webhook_call',
  id: 'c',
  label: 'Notify CRM',
  workstationId: w.workstationId,
  url: 'https://crm.example.test/hook',
  method: 'POST',
  headers: [{ name: 'X-Source', value: 'journeys' }],
  credentialHeaders: [{ name: 'Authorization', credential: 'crm' }],
  signWith: 'crm-sign',
  body: '{"client":"{record.name}","journey":"{journey.name}"}',
  ...over,
});
const manual = (id: string) => ({ kind: 'wait', id, label: id });
const create = async (steps: unknown[], handoffs: unknown[]) =>
  (
    await asOwner(
      'POST',
      '/api/journeys',
      {
        projectId: w.projectId,
        definition: { name: 'Notify', recordType: 'client', firstStepId: 'c', steps, handoffs },
      },
      201,
    )
  ).id as string;
const start = async (journeyId: string) =>
  (
    await asOwner(
      'POST',
      '/api/journey-instances',
      { journeyId, record: { type: 'client', displayName: 'Ann "A"' } },
      201,
    )
  ).id as string;
const callRow = async (id: string) =>
  (await q('SELECT * FROM journey_webhook_calls WHERE instance_id=$1', [id]))[0] as any;
const inst = async (id: string) => (await q('SELECT * FROM journey_instances WHERE id=$1', [id]))[0] as any;
const command = async (callId: string) =>
  (
    await q(`SELECT * FROM runner_commands WHERE type='journey.webhook.call' AND payload->>'callId'=$1`, [
      callId,
    ])
  )[0] as any;
const answer = (callId: string, attempt: number, result: unknown, okFlag = true, error?: string) =>
  applyJourneyWebhookResult(ctx(), { callId, attempt }, okFlag, result, error);

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const handoffs = [
  { id: 'h1', from: 'c', on: 'done', to: 'after' },
  { id: 'h2', from: 'c', on: 'failed', to: 'failed' },
];

describe('outbound webhook step', () => {
  it('hands the call to the workstation with the rendered body and no secret value, then follows done on a 2xx', async () => {
    const id = await start(await create([call(), manual('after'), manual('failed')], handoffs));
    await tick();
    let row = await callRow(id);
    expect(row.status).toBe('dispatched');
    const cmd = await command(row.id);
    expect(cmd.payload).toMatchObject({
      url: 'https://crm.example.test/hook',
      method: 'POST',
      credentialHeaders: [{ name: 'Authorization', credential: 'crm' }],
      attempt: 1,
    });
    expect(JSON.parse(cmd.payload.body)).toEqual({ client: 'Ann "A"', journey: 'Notify' });
    await answer(row.id, 1, { ok: true, httpStatus: 200, retryable: false });
    row = await callRow(id);
    expect(row).toMatchObject({ status: 'ok', attempts: 1, last_http_status: 200 });
    expect((await inst(id)).current_step_id).toBe('after');
  });

  it('retries a failure with backoff 1, 5, 30 and 120 minutes, then follows the failed handoff', async () => {
    const id = await start(await create([call(), manual('after'), manual('failed')], handoffs));
    await tick();
    const row0 = await callRow(id);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const before = w.t.clock.now().getTime();
      await answer(row0.id, attempt, { ok: false, httpStatus: 503, retryable: true });
      const r = await callRow(id);
      if (attempt < 5) {
        expect(r.status).toBe('pending');
        delays.push(Math.round((new Date(r.next_attempt_at).getTime() - before) / MIN));
        w.t.clock.advance(121 * MIN);
        await tick();
        expect((await callRow(id)).attempts).toBe(attempt + 1);
      } else {
        expect(r).toMatchObject({ status: 'failed', attempts: 5, last_http_status: 503 });
      }
    }
    expect(delays).toEqual([1, 5, 30, 120]);
    expect((await inst(id)).current_step_id).toBe('failed');
    const completed = (await q(
      `SELECT payload FROM events WHERE type='JourneyStepCompleted' AND payload->>'instanceId'=$1`,
      [id],
    )) as any[];
    expect(completed[0].payload).toMatchObject({ result: 'cancelled', outcome: 'failed' });
  });

  it('a 4xx the runner calls final is not retried', async () => {
    const id = await start(await create([call(), manual('after'), manual('failed')], handoffs));
    await tick();
    const row = await callRow(id);
    await answer(row.id, 1, { ok: false, httpStatus: 404, retryable: false });
    expect(await callRow(id)).toMatchObject({ status: 'failed', attempts: 1, last_http_status: 404 });
    expect((await inst(id)).current_step_id).toBe('failed');
  });

  it('an offline workstation (no answer by the deadline) counts as a retryable failed try', async () => {
    const id = await start(await create([call(), manual('after'), manual('failed')], handoffs));
    await tick();
    const row = await callRow(id);
    const commandId = (await command(row.id)).id;
    w.t.clock.advance(3 * MIN);
    await tick();
    const r = await callRow(id);
    expect(r).toMatchObject({ status: 'pending', attempts: 1 });
    expect(r.last_error).toContain('did not answer');
    expect(
      ((await q('SELECT payload FROM runner_commands WHERE id=$1', [commandId]))[0] as any).payload,
    ).toEqual({});
    w.t.clock.advance(2 * MIN);
    await tick();
    expect((await callRow(id)).attempts).toBe(2);
  });

  it('a failed call without a failed handoff leaves the journey stuck with an alert', async () => {
    const id = await start(
      await create([call(), manual('after')], [{ id: 'h1', from: 'c', on: 'done', to: 'after' }]),
    );
    await tick();
    const row = await callRow(id);
    await answer(row.id, 1, { ok: false, httpStatus: 400, retryable: false });
    expect((await inst(id)).status).toBe('stuck');
    expect(
      (await q(`SELECT 1 FROM desk_items WHERE subkind='journey_step_refused' AND body LIKE '%"c"%'`)).length,
    ).toBeGreaterThan(0);
  });

  it('an unknown token in the body is refused when the journey is started', async () => {
    const j = await create([call({ body: '{"x":"{nope}"}' }), manual('after'), manual('failed')], handoffs);
    const r = await w.t.req('POST', '/api/journey-instances', {
      cookie: w.owner.cookie,
      body: { journeyId: j, record: { type: 'client', displayName: 'Ann' } },
    });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toContain('unknown_token');
  });

  it('a stale or repeated answer changes nothing', async () => {
    const id = await start(await create([call(), manual('after'), manual('failed')], handoffs));
    await tick();
    const row = await callRow(id);
    await answer(row.id, 1, { ok: true, httpStatus: 200, retryable: false });
    await answer(row.id, 1, { ok: false, httpStatus: 500, retryable: true });
    expect(await callRow(id)).toMatchObject({ status: 'ok', attempts: 1 });
  });
});
