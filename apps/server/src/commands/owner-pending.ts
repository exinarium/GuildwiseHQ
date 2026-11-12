import { randomUUID } from 'node:crypto';
import {
  addWorkingDays,
  isValidTimeZone,
  OWNER_PENDING_REMINDER_SUBKIND,
  OWNER_PENDING_REMINDER_WORKING_DAYS,
  type OwnerPendingKind,
  OwnerPendingKindSchema,
  ownerPendingAction,
  ownerPendingReminderText,
  type RegisterOwnerPending,
  RegisterOwnerPendingSchema,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { notifyUsers } from '../push/notifier.ts';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * Owner-pending timers (docs/ARCHITECTURE.md section 45). The feature that puts an item into a state that waits for the
 * owner registers a timer; when the owner has not acted for 2 working days (Monday to Friday in the owner's time zone), the
 * owner is reminded once on the Desk and by a push. The timer never changes the item's state: it stays "not reviewed" until
 * the owner acts, and the owning feature then resolves the timer (which also closes the reminder).
 */

const timerScope = (r: Row) =>
  r.project_id ? projectScope(r.org_id as string, r.project_id as string) : orgScope(r.org_id as string);

const lockKey = (kind: string, subjectId: string) => `owner-pending:${kind}:${subjectId}`;

/** The user's own time zone when set and valid, else UTC. */
export async function userTimezone(db: Queryable, userId: string): Promise<string> {
  const u = await one<{ timezone: string | null }>(db, 'SELECT timezone FROM users WHERE id=$1', [userId]);
  return u?.timezone && isValidTimeZone(u.timezone) ? u.timezone : 'UTC';
}

/**
 * Called by the feature that puts an item into an owner-pending state, inside its own append transaction. Idempotent: an
 * open timer for the same kind and subject is returned unchanged (its clock is not restarted). Refuses any kind that is not
 * owner-pending (a size exception request, for one).
 */
export async function registerOwnerPending(
  ctx: Ctx,
  tx: Tx,
  input: RegisterOwnerPending,
): Promise<{ timerId: string; dueAt: Date; created: boolean }> {
  const i = RegisterOwnerPendingSchema.parse(input);
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(i.kind, i.subjectId)]);
  const open = await one(
    tx,
    `SELECT id, due_at FROM owner_pending_timers WHERE kind=$1 AND subject_id=$2 AND status='open'`,
    [i.kind, i.subjectId],
  );
  if (open) return { timerId: open.id, dueAt: new Date(open.due_at), created: false };
  const timezone = await userTimezone(tx, i.ownerUserId);
  const dueAt = addWorkingDays(i.startedAt, OWNER_PENDING_REMINDER_WORKING_DAYS, timezone);
  const timerId = randomUUID();
  await ctx.store.append(
    [
      {
        streamId: streamId.ownerPending(timerId),
        event: {
          type: 'OwnerPendingRegistered',
          payload: {
            timerId,
            kind: i.kind,
            orgId: i.orgId,
            ...(i.projectId ? { projectId: i.projectId } : {}),
            ...(i.cardId ? { cardId: i.cardId } : {}),
            subjectId: i.subjectId,
            ownerUserId: i.ownerUserId,
            title: i.title,
            ...(i.url ? { url: i.url } : {}),
            startedAt: i.startedAt.toISOString(),
            dueAt: dueAt.toISOString(),
            timezone,
          },
        },
        actor: SYSTEM_ACTOR,
        scope: timerScope({ org_id: i.orgId, project_id: i.projectId ?? null }),
      },
    ],
    { tx },
  );
  return { timerId, dueAt, created: true };
}

/**
 * Called by the owning feature whenever the owner acts on the item, or the item stops waiting for the owner (closed, merged).
 * Cancels the timer and closes the reminder if one was raised. Returns false when nothing was open (safe to call always).
 */
export async function resolveOwnerPending(
  ctx: Ctx,
  tx: Tx,
  r: { kind: OwnerPendingKind; subjectId: string; reason: 'owner_acted' | 'closed'; byUserId?: string },
): Promise<boolean> {
  const kind = OwnerPendingKindSchema.parse(r.kind);
  await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [lockKey(kind, r.subjectId)]);
  const t = await one(
    tx,
    `SELECT * FROM owner_pending_timers WHERE kind=$1 AND subject_id=$2 AND status='open' FOR UPDATE`,
    [kind, r.subjectId],
  );
  if (!t) return false;
  const actor = r.byUserId ? userActor(r.byUserId) : SYSTEM_ACTOR;
  await ctx.store.append(
    [
      {
        streamId: streamId.ownerPending(t.id),
        event: {
          type: 'OwnerPendingResolved',
          payload: { timerId: t.id, reason: r.reason, ...(r.byUserId ? { by: r.byUserId } : {}) },
        },
        actor,
        scope: timerScope(t),
      },
    ],
    { tx },
  );
  if (t.desk_item_id) {
    const item = await one(
      tx,
      `SELECT org_id, project_id FROM desk_items WHERE id=$1 AND status='open' FOR UPDATE`,
      [t.desk_item_id],
    );
    if (item)
      await ctx.store.append(
        [
          {
            streamId: streamId.desk(t.desk_item_id),
            event: {
              type: 'DeskItemResolved',
              payload: {
                deskItemId: t.desk_item_id,
                resolution: 'acknowledged',
                by: r.byUserId ? { kind: 'user', userId: r.byUserId } : { kind: 'system' },
              },
            },
            actor,
            scope: timerScope(item),
          },
        ],
        { tx },
      );
  }
  return true;
}

/** Read model for the owning feature's UI (a "Reminded" badge): the latest timer of the item. */
export async function ownerPendingOf(
  db: Queryable,
  kind: OwnerPendingKind,
  subjectId: string,
): Promise<{
  timerId: string;
  status: 'open' | 'resolved';
  dueAt: string;
  remindedAt: string | null;
} | null> {
  const t = await one(
    db,
    `SELECT id, status, due_at, reminded_at FROM owner_pending_timers WHERE kind=$1 AND subject_id=$2
      ORDER BY (status='open') DESC, started_at DESC LIMIT 1`,
    [kind, subjectId],
  );
  if (!t) return null;
  return {
    timerId: t.id,
    status: t.status,
    dueAt: new Date(t.due_at).toISOString(),
    remindedAt: t.reminded_at ? new Date(t.reminded_at).toISOString() : null,
  };
}

const MAX_PER_SWEEP = 500;

/**
 * One scheduler pass. Safe to repeat: each reminder is decided under a lock on the timer against the projected state, so a
 * second pass (or another server) sees the reminder and does nothing. Writes nothing to the item the timer watches.
 */
export async function ownerPendingSweep(ctx: Ctx): Promise<{ reminded: number }> {
  const now = ctx.clock.now();
  const cands = await rows<{ id: string }>(
    ctx.pool,
    `SELECT t.id FROM owner_pending_timers t
       JOIN organizations o ON o.id = t.org_id AND o.status IN ('trial','active')
      WHERE t.status = 'open' AND t.reminded_at IS NULL AND t.due_at <= $1
      ORDER BY t.due_at LIMIT ${MAX_PER_SWEEP}`,
    [now],
  );
  let reminded = 0;
  for (const c of cands) {
    const done = await withAppendTx(ctx.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`owner-pending-timer:${c.id}`]);
      const t = await one(tx, `SELECT * FROM owner_pending_timers WHERE id=$1`, [c.id]);
      if (!t) return null;
      const action = ownerPendingAction(
        {
          status: t.status === 'open' ? 'open' : 'resolved',
          dueAt: new Date(t.due_at),
          remindedAt: t.reminded_at ? new Date(t.reminded_at) : null,
        },
        now,
      );
      if (action !== 'remind') return null;
      const text = ownerPendingReminderText({ title: t.title, kind: t.kind as OwnerPendingKind });
      const deskItemId = randomUUID();
      const recipients = [t.owner_user_id as string];
      await ctx.store.append(
        [
          {
            streamId: streamId.desk(deskItemId),
            event: {
              type: 'DeskItemCreated',
              payload: {
                deskItemId,
                kind: 'alert',
                subkind: OWNER_PENDING_REMINDER_SUBKIND,
                title: text.title.slice(0, 280),
                body: text.body,
                options: [],
                blocking: false,
                pinned: false,
                ...(t.project_id ? { projectId: t.project_id } : {}),
                ...(t.card_id ? { cardId: t.card_id } : {}),
                affectedCardIds: [],
                askedBy: { kind: 'system' },
                addresseeUserId: t.owner_user_id,
                subjectKey: `owner-pending:${t.id}`,
                data: {
                  timerId: t.id,
                  kind: t.kind,
                  subjectId: t.subject_id,
                  ...(t.url ? { url: t.url } : {}),
                },
              },
            },
            actor: SYSTEM_ACTOR,
            scope: timerScope(t),
          },
          {
            streamId: streamId.ownerPending(t.id),
            event: {
              type: 'OwnerPendingReminded',
              payload: {
                timerId: t.id,
                firedFor: new Date(t.due_at).toISOString(),
                deskItemId,
                recipients,
              },
            },
            actor: SYSTEM_ACTOR,
            scope: timerScope(t),
          },
        ],
        { tx },
      );
      return { t, text, deskItemId, recipients };
    });
    if (!done) continue;
    reminded++;
    await notifyUsers(ctx, done.recipients, {
      category: 'follow_ups',
      subject: done.t.id,
      state: 'owner-pending-reminder',
      title: done.text.title,
      body: done.text.body,
      url: done.t.url ?? `/desk#desk-item-${done.deskItemId}`,
      priority: 'normal',
      orgId: done.t.org_id,
    }).catch((err) => ctx.log.warn({ err }, 'owner-pending reminder push failed'));
  }
  return { reminded };
}
