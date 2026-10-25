import {
  clampFollowUpDays,
  FOLLOW_UP_DEFAULT_DAYS,
  FOLLOW_UP_KINDS,
  FOLLOW_UP_MAX_SNOOZES,
  FOLLOW_UP_SKIP_SUBKINDS,
  followUpAction,
  followUpNudgeText,
  isOrgManager,
  SNOOZE_MAX_DAYS,
  streamId,
} from '@aom/shared';
import { orgRoleOf, type Who } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { projectRole } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { notifyUsers } from '../push/notifier.ts';
import { canAnswerItem, DESK_VISIBLE } from '../queries/desk.ts';
import { orgScope, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * Follow-up and chase (S-B2, docs/ARCHITECTURE.md section 38.13). A desk item (a digest rating included) that is still open
 * after the organization's window nudges its owner (in-app: the item shows "reminded"; and a push), and one that sits with an
 * agent is handed back to the agent once. At most one nudge per item per window; a snooze moves the next one out. The scheduler
 * runs `followUpSweep`; the nudge is an event and its state is projected, so a repeated or replayed sweep does nothing twice.
 */

export async function followUpDays(db: Queryable, orgId: string): Promise<number> {
  const r = await one<{ days: number }>(db, 'SELECT days FROM org_follow_up WHERE org_id=$1', [orgId]);
  return r ? r.days : FOLLOW_UP_DEFAULT_DAYS;
}

export async function setFollowUpDays(ctx: Ctx, who: Who, days: number): Promise<number> {
  if (!isOrgManager({ orgRole: who.role }))
    throw forbidden('only the organization Owner and Admins can change this');
  const d = clampFollowUpDays(days);
  await ctx.store.append([
    {
      streamId: streamId.org(who.orgId),
      event: { type: 'FollowUpDaysSet', payload: { orgId: who.orgId, days: d, by: who.userId } },
      actor: userActor(who.userId),
      scope: orgScope(who.orgId),
    },
  ]);
  return d;
}

const itemScope = (r: Row) => (r.project_id ? projectScope(r.org_id, r.project_id) : orgScope(r.org_id));

/** Snooze the chase of one item. Anyone who may act on the item may snooze it (not longer than two weeks). */
export async function snoozeDeskItem(
  ctx: Ctx,
  user: AuthSession['user'],
  itemId: string,
  days: number,
): Promise<{ snoozedUntil: string }> {
  const d = Math.min(SNOOZE_MAX_DAYS, Math.max(1, Math.trunc(days)));
  return withAppendTx(ctx.pool, async (tx) => {
    const item = await one(
      tx,
      `SELECT d.*, c.owner_user_id AS card_owner, c.decision_policy AS card_policy FROM desk_items d
         LEFT JOIN cards c ON c.id = d.card_id WHERE d.id = $2 AND ${DESK_VISIBLE}`,
      [user.id, itemId],
    );
    if (!item) throw notFound('desk item not found');
    const role = item.project_id ? await projectRole(tx, user.id, item.project_id) : null;
    if (!canAnswerItem(item, user.id, role, await orgRoleOf(tx, user.id, item.org_id)))
      throw forbidden('you cannot act on this item');
    const snoozed = await one(
      tx,
      `SELECT count(*)::int AS n FROM events WHERE stream_id=$1 AND type='DeskItemSnoozed'`,
      [streamId.desk(itemId)],
    );
    if (Number(snoozed?.n ?? 0) >= FOLLOW_UP_MAX_SNOOZES)
      throw conflict(
        'snoozed_too_often',
        `this item was snoozed ${FOLLOW_UP_MAX_SNOOZES} times already: decide it, or ask someone else to`,
      );
    const until = new Date(ctx.clock.now().getTime() + d * 86_400_000).toISOString();
    await ctx.store.append(
      [
        {
          streamId: streamId.desk(itemId),
          event: {
            type: 'DeskItemSnoozed',
            payload: {
              deskItemId: itemId,
              orgId: item.org_id,
              ...(item.project_id ? { projectId: item.project_id } : {}),
              until,
              by: user.id,
            },
          },
          actor: userActor(user.id),
          scope: itemScope(item),
        },
      ],
      { tx },
    );
    return { snoozedUntil: until };
  });
}

/** Who is nudged for an item: the person it is addressed to, else the card's owner, else the project's owners, else the org managers. */
async function recipientsOf(db: Queryable, r: Row): Promise<string[]> {
  if (r.addressee_user_id) return [r.addressee_user_id];
  if (r.card_owner) return [r.card_owner];
  if (r.project_id) {
    const owners = await rows<{ user_id: string }>(
      db,
      `SELECT user_id FROM project_members WHERE project_id=$1 AND status='active' AND role='owner'`,
      [r.project_id],
    );
    if (owners.length) return owners.map((o) => o.user_id);
  }
  return (
    await rows<{ user_id: string }>(
      db,
      `SELECT user_id FROM org_members WHERE org_id=$1 AND status='active' AND role IN ('owner','admin')`,
      [r.org_id],
    )
  ).map((o) => o.user_id);
}

const MAX_PER_SWEEP = 500;

/**
 * One pass. Safe to repeat: each decision is made under a lock on the item against the projected state, so a second pass (or
 * another server) right after sees the nudge and does nothing. Returns what it did.
 */
export async function followUpSweep(ctx: Ctx): Promise<{ nudged: number; requeued: number }> {
  const now = ctx.clock.now();
  // Candidates: open, decided by a person or an agent, at least a day old; the per-organization window is applied in code.
  const cands = await rows(
    ctx.pool,
    `SELECT d.id FROM desk_items d
       JOIN organizations o ON o.id = d.org_id AND o.status IN ('trial','active')
       LEFT JOIN org_follow_up fu ON fu.org_id = d.org_id
      WHERE d.status = 'open' AND d.triage <> 'pending' AND d.kind = ANY($1::text[])
        AND COALESCE(d.subkind, '') <> ALL($2::text[])
        AND COALESCE(fu.days, $3) > 0
        AND d.updated_at <= $4::timestamptz - (COALESCE(fu.days, $3) * interval '1 day')
      ORDER BY d.updated_at LIMIT ${MAX_PER_SWEEP}`,
    [[...FOLLOW_UP_KINDS], [...FOLLOW_UP_SKIP_SUBKINDS], FOLLOW_UP_DEFAULT_DAYS, now],
  );
  let nudged = 0;
  let requeued = 0;
  for (const c of cands) {
    const done = await withAppendTx(ctx.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`follow-up:${c.id}`]);
      const r = await one(
        tx,
        `SELECT d.*, c.ref AS card_ref, c.owner_user_id AS card_owner,
                f.last_nudge_at, COALESCE(f.nudge_count, 0) AS nudge_count, f.snoozed_until,
                COALESCE(fu.days, $2) AS days, (p.paused_at IS NOT NULL) AS project_paused
           FROM desk_items d LEFT JOIN cards c ON c.id = d.card_id
           LEFT JOIN desk_follow_ups f ON f.desk_item_id = d.id
           LEFT JOIN org_follow_up fu ON fu.org_id = d.org_id
           LEFT JOIN projects p ON p.id = d.project_id
          WHERE d.id = $1 AND d.status = 'open'`,
        [c.id, FOLLOW_UP_DEFAULT_DAYS],
      );
      if (!r) return null;
      const routedTo = r.routed_to === 'agent' ? 'agent' : 'manager';
      const action = followUpAction(
        {
          openedAt: new Date(r.updated_at),
          lastNudgeAt: r.last_nudge_at ? new Date(r.last_nudge_at) : null,
          nudgeCount: Number(r.nudge_count),
          snoozedUntil: r.snoozed_until ? new Date(r.snoozed_until) : null,
          routedTo,
        },
        now,
        Number(r.days),
      );
      if (!action) return null;
      // a paused project starts nothing: an agent is not asked again until it resumes (a person is still told)
      if (action === 'requeue' && r.project_paused) return null;
      const recipients = action === 'nudge' ? await recipientsOf(tx, r) : [];
      const nudgeNumber = Number(r.nudge_count) + 1;
      await ctx.store.append(
        [
          {
            streamId: streamId.desk(r.id),
            event: {
              type: 'DeskItemNudged',
              payload: {
                deskItemId: r.id,
                orgId: r.org_id,
                ...(r.project_id ? { projectId: r.project_id } : {}),
                mode: action === 'nudge' ? 'owner' : 'requeue',
                recipients,
                nudgeNumber,
              },
            },
            actor: SYSTEM_ACTOR,
            scope: itemScope(r),
          },
        ],
        { tx },
      );
      return { r, action, recipients, nudgeNumber };
    });
    if (!done) continue;
    if (done.action === 'requeue') {
      requeued++;
      continue;
    }
    nudged++;
    const ageDays = Math.max(
      1,
      Math.round((now.getTime() - new Date(done.r.created_at).getTime()) / 86_400_000),
    );
    const text = followUpNudgeText({ title: done.r.title, ageDays, cardRef: done.r.card_ref });
    await notifyUsers(ctx, done.recipients, {
      category: 'follow_ups',
      subject: done.r.id,
      state: `nudge-${done.nudgeNumber}`,
      title: text.title,
      body: text.body,
      url: `/desk#desk-item-${done.r.id}`,
      priority: 'normal',
      orgId: done.r.org_id,
    }).catch((err) => ctx.log.warn({ err }, 'follow-up push failed'));
  }
  return { nudged, requeued };
}
