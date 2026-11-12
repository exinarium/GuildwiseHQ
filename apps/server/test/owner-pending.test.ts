import { randomUUID } from 'node:crypto';
import type { OwnerPendingKind } from '@aom/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ownerPendingOf,
  ownerPendingSweep,
  registerOwnerPending,
  resolveOwnerPending,
} from '../src/commands/owner-pending.ts';
import { withAppendTx } from '../src/db/tx.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, type World } from './helpers/world.ts';

const send = vi.hoisted(() => vi.fn());
vi.mock('web-push', () => ({ default: { sendNotification: send, generateVAPIDKeys: () => ({}) } }));

let w: World;
let orgId: string;
beforeAll(async () => {
  w = await createWorld({
    env: {
      AOM_FIRST_RUN_HIRE_CAP: 'false',
      AOM_VAPID_PUBLIC_KEY: 'BPublicKeyForTests',
      AOM_VAPID_PRIVATE_KEY: 'privateKeyForTests',
      AOM_VAPID_SUBJECT: 'mailto:ops@example.com',
      AOM_PUSH_OFFLINE_GRACE_SECONDS: '0',
    },
  });
  const r = await w.t.req('POST', '/api/push/subscriptions', {
    cookie: w.owner.cookie,
    body: { endpoint: `https://push.example.com/send/${randomUUID()}`, keys: { p256dh: 'p', auth: 'a' } },
  });
  expect(r.status).toBe(201);
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id;
});
afterAll(async () => {
  w.t.clock.setOffset(0);
  await w.t.close();
  await closeAdminPool();
});
beforeEach(async () => {
  send.mockReset();
  send.mockResolvedValue({ statusCode: 201 });
  await q('DELETE FROM owner_pending_timers');
  await q(`DELETE FROM desk_items WHERE subkind='owner_pending_reminder'`);
  await q('DELETE FROM push_deliveries');
  await q('UPDATE users SET timezone=NULL WHERE id=$1', [w.owner.id]);
});
afterEach(() => w.t.clock.setOffset(0));

const ctx = () => w.t.app.ctx;
/** Pins the server clock to an instant. */
const pin = (iso: string) => w.t.clock.setOffset(Date.parse(iso) - Date.now());
const sweep = () => ownerPendingSweep(ctx());
const pushes = () => send.mock.calls.map((c) => JSON.parse(c[1] as string));
const reminders = () =>
  q(`SELECT * FROM desk_items WHERE subkind='owner_pending_reminder' ORDER BY created_at`);
const remindedEvents = (timerId: string) =>
  q(`SELECT * FROM events WHERE stream_id=$1 AND type='OwnerPendingReminded'`, [`owner-pending-${timerId}`]);
async function timer(id: string): Promise<Record<string, any>> {
  const r = (await q('SELECT * FROM owner_pending_timers WHERE id=$1', [id]))[0];
  if (!r) throw new Error(`no timer ${id}`);
  return r;
}

async function register(startedAt: string, over: Record<string, unknown> = {}) {
  pin(startedAt);
  return withAppendTx(ctx().pool, (tx) =>
    registerOwnerPending(ctx(), tx, {
      kind: 'second_timeout',
      orgId,
      projectId: w.projectId,
      subjectId: `pr-${randomUUID()}`,
      ownerUserId: w.owner.id,
      title: 'PR #42: add login',
      startedAt: new Date(startedAt),
      ...over,
    } as never),
  );
}

async function resolve(kind: OwnerPendingKind, subjectId: string, byUserId?: string) {
  return withAppendTx(ctx().pool, (tx) =>
    resolveOwnerPending(ctx(), tx, {
      kind,
      subjectId,
      reason: 'owner_acted',
      ...(byUserId ? { byUserId } : {}),
    }),
  );
}

describe('owner-pending reminder after 2 working days', () => {
  it('AC1: a Friday start is not reminded on Monday, is reminded once on Tuesday, and stays open', async () => {
    const reg = await register('2026-11-13T15:00:00.000Z');
    expect(reg.created).toBe(true);
    expect(reg.dueAt.toISOString()).toBe('2026-11-17T15:00:00.000Z');

    pin('2026-11-16T15:00:00.000Z'); // Monday: one working day only
    expect(await sweep()).toEqual({ reminded: 0 });
    expect(await reminders()).toHaveLength(0);

    pin('2026-11-17T14:59:59.000Z');
    expect(await sweep()).toEqual({ reminded: 0 });

    pin('2026-11-17T15:00:00.000Z'); // Tuesday: 2 working days
    expect(await sweep()).toEqual({ reminded: 1 });
    const items = await reminders();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'alert',
      status: 'open',
      addressee_user_id: w.owner.id,
      project_id: w.projectId,
      subject_key: `owner-pending:${reg.timerId}`,
    });
    expect(items[0]?.title).toBe('Still waiting for you: PR #42: add login');
    expect(pushes()).toHaveLength(1);
    expect(pushes()[0]).toMatchObject({
      title: 'Still waiting for you: PR #42: add login',
      url: `/desk#desk-item-${items[0]?.id}`,
    });
    expect(pushes()[0].body).toContain('stays not reviewed');
    expect(await remindedEvents(reg.timerId)).toHaveLength(1);

    // the item's state is unchanged: the timer is still open (owner-pending, not reviewed), only marked reminded
    const t = await timer(reg.timerId);
    expect(t).toMatchObject({
      status: 'open',
      resolved_at: null,
      resolution: null,
      desk_item_id: items[0]?.id,
    });
    expect(t.reminded_at).not.toBeNull();
    // nothing but the reminder was written: no event on any other stream than the timer and the reminder
    const streams = await q(
      `SELECT DISTINCT stream_id FROM events WHERE type LIKE 'OwnerPending%' OR (type='DeskItemCreated' AND stream_id=$1)`,
      [`desk-${items[0]?.id}`],
    );
    expect(streams.map((s) => s.stream_id).sort()).toEqual(
      [`desk-${items[0]?.id}`, `owner-pending-${reg.timerId}`].sort(),
    );

    // a second pass, and the next day: no second reminder
    expect(await sweep()).toEqual({ reminded: 0 });
    pin('2026-11-18T15:00:00.000Z');
    expect(await sweep()).toEqual({ reminded: 0 });
    expect(await reminders()).toHaveLength(1);
    expect(pushes()).toHaveLength(1);
    expect(await remindedEvents(reg.timerId)).toHaveLength(1);
    expect((await ownerPendingOf(ctx().pool, 'second_timeout', t.subject_id))?.status).toBe('open');
  });

  it('AC1: a Saturday start counts from Monday and is reminded at Wednesday 00:00', async () => {
    const reg = await register('2026-11-14T10:00:00.000Z', { kind: 'manual_trigger' });
    expect(reg.dueAt.toISOString()).toBe('2026-11-18T00:00:00.000Z');
    pin('2026-11-17T23:59:00.000Z');
    expect(await sweep()).toEqual({ reminded: 0 });
    pin('2026-11-18T00:00:00.000Z');
    expect(await sweep()).toEqual({ reminded: 1 });
    expect(await reminders()).toHaveLength(1);
    expect((await timer(reg.timerId)).status).toBe('open');
  });

  it("uses the owner's time zone, stored on the timer", async () => {
    await q(`UPDATE users SET timezone='Africa/Johannesburg' WHERE id=$1`, [w.owner.id]);
    // Friday 22:30 UTC is Saturday 00:30 in Johannesburg: counts from Monday 00:00 there, due Wednesday 00:00 there
    const reg = await register('2026-11-13T22:30:00.000Z', { kind: 'over_cap_spend' });
    expect(reg.dueAt.toISOString()).toBe('2026-11-17T22:00:00.000Z');
    // a later change of time zone does not move a due time already set
    await q(`UPDATE users SET timezone='America/New_York' WHERE id=$1`, [w.owner.id]);
    expect(await timer(reg.timerId)).toMatchObject({ timezone: 'Africa/Johannesburg' });
    expect(new Date((await timer(reg.timerId)).due_at).toISOString()).toBe('2026-11-17T22:00:00.000Z');
  });

  it('registering the same item again keeps the first clock', async () => {
    const subjectId = `pr-${randomUUID()}`;
    const first = await register('2026-11-13T15:00:00.000Z', { subjectId });
    const again = await register('2026-11-16T15:00:00.000Z', { subjectId });
    expect(again).toEqual({ timerId: first.timerId, dueAt: first.dueAt, created: false });
    expect(await q('SELECT id FROM owner_pending_timers WHERE subject_id=$1', [subjectId])).toHaveLength(1);
  });

  it('the due time and the reminder survive a projection rebuild (restart-safe, replay does not remind twice)', async () => {
    const reg = await register('2026-11-13T15:00:00.000Z');
    pin('2026-11-17T15:00:00.000Z');
    expect(await sweep()).toEqual({ reminded: 1 });
    await rebuildProjections(ctx().pool, ctx().store);
    const t = await timer(reg.timerId);
    expect(new Date(t.due_at).toISOString()).toBe('2026-11-17T15:00:00.000Z');
    expect(t.status).toBe('open');
    expect(t.reminded_at).not.toBeNull();
    // the rebuild also brings back timers of earlier tests (their rows were deleted, their events stay): look at ours only
    await sweep();
    expect(await remindedEvents(reg.timerId)).toHaveLength(1);
  });

  it('AC2: the owner acts within 2 working days: no reminder', async () => {
    const subjectId = `pr-${randomUUID()}`;
    const reg = await register('2026-11-09T09:00:00.000Z', { subjectId, kind: 'manual_trigger' });
    pin('2026-11-10T12:00:00.000Z');
    expect(await resolve('manual_trigger', subjectId, w.owner.id)).toBe(true);
    expect(await timer(reg.timerId)).toMatchObject({
      status: 'resolved',
      resolution: 'owner_acted',
      resolved_by: w.owner.id,
    });
    pin('2026-11-12T12:00:00.000Z');
    expect(await sweep()).toEqual({ reminded: 0 });
    expect(await reminders()).toHaveLength(0);
    expect(pushes()).toHaveLength(0);
    expect(await remindedEvents(reg.timerId)).toHaveLength(0);
    // resolving again is a no-op
    expect(await resolve('manual_trigger', subjectId)).toBe(false);
  });

  it('acting after the reminder closes the reminder on the Desk', async () => {
    const subjectId = `pr-${randomUUID()}`;
    await register('2026-11-13T15:00:00.000Z', { subjectId });
    pin('2026-11-17T15:00:00.000Z');
    expect(await sweep()).toEqual({ reminded: 1 });
    expect((await reminders())[0]?.status).toBe('open');
    expect(await resolve('second_timeout', subjectId, w.owner.id)).toBe(true);
    expect((await reminders())[0]?.status).not.toBe('open');
  });

  it('AC3: a size exception request is refused, so this timer never reminds for it', async () => {
    const subjectId = `pr-${randomUUID()}`;
    await expect(
      register('2026-11-13T15:00:00.000Z', { subjectId, kind: 'size_exception' }),
    ).rejects.toThrow();
    expect(await q('SELECT id FROM owner_pending_timers WHERE subject_id=$1', [subjectId])).toHaveLength(0);
    pin('2026-11-18T15:00:00.000Z');
    expect(await sweep()).toEqual({ reminded: 0 });
    expect(await reminders()).toHaveLength(0);
    expect(pushes()).toHaveLength(0);
    await expect(
      withAppendTx(ctx().pool, (tx) =>
        resolveOwnerPending(ctx(), tx, { kind: 'size_exception' as never, subjectId, reason: 'closed' }),
      ),
    ).rejects.toThrow();
  });
});
