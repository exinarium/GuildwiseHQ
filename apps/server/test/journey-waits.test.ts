import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { journeyTick } from '../src/journeys/tick.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Journey waits and gates (docs/investigations/GWP-67): deadlines, timeout actions, fire-once timers, approval gates.
 * The clock is the test clock; `journeyTick` is the scheduler's pass.
 */
let w: World;
const ctx = () => w.t.app.ctx;
const asOwner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), expected);
const tick = async (n = 3) => {
  for (let i = 0; i < n; i++) await journeyTick(ctx(), { projectId: w.projectId });
};
const MIN = 60_000;
const DAY = 86_400_000;

const wait = (id: string, over: Record<string, unknown> = {}) => ({
  kind: 'wait',
  id,
  label: id,
  waitFor: { kind: 'duration' },
  duration: { amount: 10, unit: 'minutes' },
  ...over,
});
const hookWait = (id: string, onTimeout: unknown, over: Record<string, unknown> = {}) =>
  wait(id, {
    waitFor: { kind: 'webhook', triggerId: randomUUID() },
    duration: { amount: 10, unit: 'minutes' },
    onTimeout,
    ...over,
  });
const manual = (id: string) => ({ kind: 'wait', id, label: id });

const create = async (steps: unknown[], handoffs: unknown[], first = 'a') =>
  (
    await asOwner(
      'POST',
      '/api/journeys',
      {
        projectId: w.projectId,
        definition: { name: 'J', recordType: 'client', firstStepId: first, steps, handoffs },
      },
      201,
    )
  ).id as string;
const start = async (journeyId: string) =>
  (await asOwner('POST', '/api/journey-instances', { journeyId, record: { type: 'client', displayName: 'Ann' } }, 201)).id as string;
const inst = async (id: string) => (await q('SELECT * FROM journey_instances WHERE id=$1', [id]))[0] as any;
const waitRow = async (id: string, visit = 1) =>
  (await q('SELECT * FROM journey_waits WHERE instance_id=$1 AND visit=$2', [id, visit]))[0] as any;

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('duration waits', () => {
  it('shows the wait with its deadline, then ends it at the deadline with an event and follows the handoff', async () => {
    const j = await create([wait('a'), manual('after')], [{ id: 'h1', from: 'a', on: 'done', to: 'after' }]);
    const id = await start(j);
    await tick();
    const row = await waitRow(id);
    expect(row.status).toBe('open');
    expect(new Date(row.deadline_at).getTime() - new Date(row.started_at).getTime()).toBe(10 * MIN);
    const api = await asOwner('GET', `/api/journey-instances/${id}/waits`);
    expect(api.waits[0]).toMatchObject({ kind: 'duration', status: 'open', stepId: 'a' });
    expect(api.waits[0].deadlineAt).toBeTruthy();

    w.t.clock.advance(11 * MIN);
    await tick();
    const done = await waitRow(id);
    expect(done).toMatchObject({ status: 'resolved', resolution: 'elapsed' });
    expect(done.events.map((e: any) => e.type)).toContain('resolved');
    expect((await inst(id)).current_step_id).toBe('after');
  });

  it('a wait that has not reached its deadline does nothing', async () => {
    const j = await create([wait('a'), manual('after')], [{ id: 'h1', from: 'a', on: 'done', to: 'after' }]);
    const id = await start(j);
    await tick();
    w.t.clock.advance(5 * MIN);
    await tick();
    expect((await waitRow(id)).status).toBe('open');
  });
});

describe('timeout actions: every one leaves an event, none ends silently', () => {
  it('remind keeps waiting, then escalates to the desk after the last reminder', async () => {
    const j = await create(
      [hookWait('a', { action: 'remind', maxReminders: 1, afterLast: 'escalate' }), manual('after')],
      [{ id: 'h1', from: 'a', on: 'done', to: 'after' }],
    );
    const id = await start(j);
    await tick();
    w.t.clock.advance(11 * MIN);
    await tick();
    let row = await waitRow(id);
    expect(row).toMatchObject({ status: 'open', reminders_sent: 1 });
    expect(row.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['timed_out', 'reminded']));
    w.t.clock.advance(11 * MIN);
    await tick();
    row = await waitRow(id);
    expect(row.status).toBe('escalated');
    const desk = (await q(`SELECT * FROM desk_items WHERE id=$1`, [row.desk_item_id]))[0] as any;
    expect(desk).toBeTruthy();
    expect(desk.subkind).toBe('journey_wait_escalated');
    expect(desk.addressee_user_id).toBe(w.owner.id);
    // the desk answer: continue now
    await asOwner('POST', `/api/journey-waits/${row.id}/continue`);
    expect((await waitRow(id)).resolution).toBe('continued');
    expect((await inst(id)).current_step_id).toBe('after');
  });

  it('goto ends the wait and enters the named step', async () => {
    const j = await create(
      [hookWait('a', { action: 'goto', stepId: 'late' }), manual('after'), manual('late')],
      [{ id: 'h1', from: 'a', on: 'done', to: 'after' }],
    );
    const id = await start(j);
    await tick();
    w.t.clock.advance(11 * MIN);
    await tick();
    expect(await waitRow(id)).toMatchObject({ status: 'resolved', resolution: 'goto' });
    expect((await inst(id)).current_step_id).toBe('late');
  });

  it('cancel cancels the journey with an event on the wait', async () => {
    const j = await create([hookWait('a', { action: 'cancel' }), manual('after')], [{ id: 'h1', from: 'a', on: 'done', to: 'after' }]);
    const id = await start(j);
    await tick();
    w.t.clock.advance(11 * MIN);
    await tick();
    expect((await inst(id)).status).toBe('cancelled');
    const row = await waitRow(id);
    expect(row.status).toBe('cancelled');
    expect(row.events.map((e: any) => e.type)).toEqual(expect.arrayContaining(['timed_out', 'cancelled']));
  });

  it('escalate keeps the wait, asks the project owner, and Extend reopens it with a new deadline', async () => {
    const j = await create([hookWait('a', { action: 'escalate' }), manual('after')], [{ id: 'h1', from: 'a', on: 'done', to: 'after' }]);
    const id = await start(j);
    await tick();
    w.t.clock.advance(11 * MIN);
    await tick();
    const row = await waitRow(id);
    expect(row.status).toBe('escalated');
    await asOwner('POST', `/api/journey-waits/${row.id}/extend`, { duration: { amount: 2, unit: 'days' } });
    const again = await waitRow(id);
    expect(again.status).toBe('open');
    expect(new Date(again.next_fire_at).getTime()).toBeGreaterThan(w.t.clock.now().getTime() + DAY);
  });
});

describe('date waits', () => {
  it('a missing date escalates at once', async () => {
    const j = await create(
      [wait('a', { waitFor: { kind: 'date', dateFrom: { field: 'dueDate' }, atTime: '09:00' }, duration: undefined }), manual('after')],
      [{ id: 'h1', from: 'a', on: 'done', to: 'after' }],
    );
    const id = await start(j);
    await tick();
    const row = await waitRow(id);
    expect(row.status).toBe('escalated');
    expect(row.events.map((e: any) => e.text).join(' ')).toContain('could not be read');
  });
});

describe('timers fire once', () => {
  it('two passes at the same time, even concurrent, produce one timeout and one reminder', async () => {
    const j = await create(
      [hookWait('a', { action: 'remind', maxReminders: 3, afterLast: 'cancel' }), manual('after')],
      [{ id: 'h1', from: 'a', on: 'done', to: 'after' }],
    );
    const id = await start(j);
    await tick();
    w.t.clock.advance(11 * MIN);
    await Promise.all([journeyTick(ctx(), { projectId: w.projectId }), journeyTick(ctx(), { projectId: w.projectId })]);
    await tick();
    const row = await waitRow(id);
    expect(row.reminders_sent).toBe(1);
    expect(row.events.filter((e: any) => e.type === 'timed_out')).toHaveLength(1);
    expect(row.events.filter((e: any) => e.type === 'reminded')).toHaveLength(1);
  });

  it('a wait left overdue after downtime fires once at the next pass and plans the next reminder from now', async () => {
    const j = await create(
      [hookWait('a', { action: 'remind', maxReminders: 3, afterLast: 'cancel' }), manual('after')],
      [{ id: 'h1', from: 'a', on: 'done', to: 'after' }],
    );
    const id = await start(j);
    await tick();
    w.t.clock.advance(3 * 60 * MIN);
    await tick();
    const row = await waitRow(id);
    expect(row.reminders_sent).toBe(1);
    expect(new Date(row.next_fire_at).getTime()).toBeGreaterThan(w.t.clock.now().getTime());
  });
});

describe('manual placeholders keep working', () => {
  it('an unconfigured wait waits for Continue, which writes a wait event', async () => {
    const j = await create([manual('a'), manual('after')], [{ id: 'h1', from: 'a', on: 'done', to: 'after' }]);
    const id = await start(j);
    await tick();
    expect((await waitRow(id)).kind).toBe('manual');
    await asOwner('POST', `/api/journey-instances/${id}/continue`, { visit: 1 });
    const row = await waitRow(id);
    expect(row).toMatchObject({ status: 'resolved', resolution: 'continued' });
    expect((await inst(id)).current_step_id).toBe('after');
  });
});

describe('approval gates', () => {
  const gate = { kind: 'gate', id: 'g', label: 'Approval', approver: { kind: 'project_owner' }, question: 'Approve?' };
  const handoffs = [
    { id: 'h1', from: 'g', on: 'approved', to: 'yes' },
    { id: 'h2', from: 'g', on: 'rejected', to: 'end' },
  ];

  it('shows on the desk; approve follows the approved handoff', async () => {
    const j = await create([gate, manual('yes')], handoffs, 'g');
    const id = await start(j);
    await tick();
    const row = await waitRow(id);
    const desk = (await q(`SELECT * FROM desk_items WHERE id=$1`, [row.desk_item_id]))[0] as any;
    expect(desk.subkind).toBe('journey_gate');
    expect(desk.status).toBe('open');
    await asOwner('POST', `/api/journey-gates/${row.id}/decide`, { decision: 'approved' });
    expect((await inst(id)).current_step_id).toBe('yes');
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [row.desk_item_id]))[0]!.status).not.toBe('open');
    const events = (await q(`SELECT payload FROM events WHERE type='JourneyStepCompleted' AND payload->>'instanceId'=$1`, [id])) as any[];
    expect(events[0].payload.outcome).toBe('approved');
  });

  it('reject needs a note and follows the reject handoff', async () => {
    const j = await create([gate, manual('yes')], handoffs, 'g');
    const id = await start(j);
    await tick();
    const row = await waitRow(id);
    const no = await w.t.req('POST', `/api/journey-gates/${row.id}/decide`, { cookie: w.owner.cookie, body: { decision: 'rejected' } });
    expect(no.status).toBe(400);
    await asOwner('POST', `/api/journey-gates/${row.id}/decide`, { decision: 'rejected', note: 'Incomplete' });
    expect((await inst(id)).status).toBe('completed');
  });

  it('a second decision gets 409 and the generic Continue cannot pass a gate', async () => {
    const j = await create([gate, manual('yes')], handoffs, 'g');
    const id = await start(j);
    await tick();
    const row = await waitRow(id);
    const c = await w.t.req('POST', `/api/journey-instances/${id}/continue`, { cookie: w.owner.cookie, body: { visit: 1 } });
    expect(c.status).toBe(409);
    await asOwner('POST', `/api/journey-gates/${row.id}/decide`, { decision: 'approved' });
    const again = await w.t.req('POST', `/api/journey-gates/${row.id}/decide`, { cookie: w.owner.cookie, body: { decision: 'approved' } });
    expect(again.status).toBe(409);
  });

  it('someone outside the project cannot decide', async () => {
    const j = await create([gate, manual('yes')], handoffs, 'g');
    const id = await start(j);
    await tick();
    const row = await waitRow(id);
    const other = await w.t.userSession(`outsider-${randomUUID()}@example.com`);
    const r = await w.t.req('POST', `/api/journey-gates/${row.id}/decide`, { cookie: other.cookie, body: { decision: 'approved' } });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await waitRow(id)).status).toBe('open');
  });

  it('a legacy cancelled handoff from a gate is read as reject', async () => {
    const j = await create(
      [gate, manual('yes')],
      [
        { id: 'h1', from: 'g', on: 'done', to: 'yes' },
        { id: 'h2', from: 'g', on: 'cancelled', to: 'end' },
      ],
      'g',
    );
    const id = await start(j);
    await tick();
    const row = await waitRow(id);
    await asOwner('POST', `/api/journey-gates/${row.id}/decide`, { decision: 'rejected', note: 'No' });
    expect((await inst(id)).status).toBe('completed');
  });
});
