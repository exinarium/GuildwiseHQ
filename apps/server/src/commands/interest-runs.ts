import { randomUUID } from 'node:crypto';
import {
  type DeliverySpec,
  effectiveFeatures,
  HR_DESK_SUBKIND,
  type InterestAgents,
  type InterestBody,
  type InterestRunKind,
  type InterestRunTrigger,
  interestCardTemplate,
  isOrgOperational,
  OPEN_RUN_STATUSES,
  type RunInterestRequest,
  researchRunFields,
  scheduleBackoffMs,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { reportingOf } from '../reporter/settings.ts';
import { projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { interestBody, lockInterest } from './interests.ts';
import { dayIn, scheduledCard } from './schedule-actions.ts';
import { nextFireAfter } from './schedules.ts';

/**
 * Interest runs, cadence and delivery (docs/design/restructure.md sections 3.4, 5.2 and 5.3). A run is one scan (a feed
 * card: scout, then curator) or one research ("Research this": a research card). The run schedule fires scans in the
 * scheduler tick; the delivery schedule decides when what the runs found reaches the manager's desk, within the
 * organization's quiet cap.
 */

type User = AuthSession['user'];

const ROLES_OF: Record<InterestRunKind, Array<keyof InterestAgents>> = {
  scan: ['scout', 'curator'],
  research: ['researcher', 'checker'],
};

export interface StartedRun {
  runId: string;
  cardId: string;
  ref: string;
  events: AppendInput[];
}

/** An open (unfinished) run of the kind, if any. */
async function openRun(db: Queryable, interestId: string, kind: InterestRunKind): Promise<Row | undefined> {
  return one(
    db,
    `SELECT r.*, c.ref FROM interest_runs r JOIN cards c ON c.id = r.card_id
      WHERE r.interest_id=$1 AND r.kind=$2 AND r.status = ANY($3::text[]) ORDER BY r.started_at DESC LIMIT 1`,
    [interestId, kind, OPEN_RUN_STATUSES],
  );
}

/**
 * The events that start a run: `InterestRunStarted` and the `CardCreated` of its card (queued at the workflow's first
 * agent stage, scheduled so it goes ahead of normal work). `interest` is the locked row.
 */
export async function interestRunEvents(
  tx: Tx,
  interest: Row,
  kind: InterestRunKind,
  trigger: InterestRunTrigger,
  now: Date,
  opts: {
    startedBy?: string;
    parentRunId?: string;
    question?: string | undefined;
    depth?: 'quick' | 'standard' | 'deep' | undefined;
    sourceItem?: { title: string; url: string } | undefined;
    /** Mock runtime only: scripted fields for the mock agents. */
    mock?: Record<string, unknown> | undefined;
    /** A cron fire moves the next scan to the next slot after `now`. */
    advance?: boolean;
  } = {},
): Promise<StartedRun> {
  const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [interest.project_id]);
  if (!project) throw notFound('interest project not found');
  if (project.status !== 'active') throw conflict('project_archived', 'this interest is archived');
  const body: InterestBody = interestBody(interest);
  const runId = randomUUID();
  const preferred: Record<string, string> = {};
  const agents = (interest.agents ?? {}) as InterestAgents;
  for (const r of ROLES_OF[kind]) if (agents[r]) preferred[r] = agents[r] as string;
  const tz = body.scan?.timezone ?? 'UTC';
  let template: { title: string; cardType: string; fields: Record<string, unknown> };
  if (kind === 'scan') {
    const t = interestCardTemplate({ ...body, kinds: body.kinds });
    template = { ...t, title: `${body.name} ${dayIn(now, tz)}` };
  } else {
    const q = opts.question?.trim();
    const withSource = opts.sourceItem
      ? `${q ?? `What should I know about "${opts.sourceItem.title}"?`}\n\nStart from this source: ${opts.sourceItem.title} (${opts.sourceItem.url})`
      : q;
    template = {
      title: `Research: ${body.name}`.slice(0, 300),
      cardType: 'research',
      fields: researchRunFields(body, { question: withSource, depth: opts.depth }),
    };
  }
  if (opts.mock) template = { ...template, fields: { ...template.fields, ...opts.mock } };
  const card = await scheduledCard(tx, project, template as never, undefined, template.title, interest.id, {
    interestRunId: runId,
    origin: 'interest',
    ...(Object.keys(preferred).length ? { preferredAgents: preferred } : {}),
  });
  const next =
    opts.advance && body.scan
      ? (nextFireAfter(body.scan.cron, body.scan.timezone, now)?.toISOString() ?? null)
      : undefined;
  const scope = projectScope(interest.org_id, interest.project_id);
  return {
    runId,
    cardId: card.cardId,
    ref: card.ref,
    events: [
      {
        streamId: streamId.interest(interest.id),
        event: {
          type: 'InterestRunStarted',
          payload: {
            runId,
            interestId: interest.id,
            kind,
            trigger,
            cardId: card.cardId,
            ...(opts.parentRunId ? { parentRunId: opts.parentRunId } : {}),
            ...(opts.startedBy ? { startedBy: opts.startedBy } : {}),
            ...(next !== undefined ? { nextScanAt: next } : {}),
          },
        },
        actor: opts.startedBy ? userActor(opts.startedBy) : SYSTEM_ACTOR,
        scope,
      },
      card.event,
    ],
  };
}

/** "Run now" and "Research this": a manual run of an interest, by someone who may change it. */
export async function runInterest(
  ctx: Ctx,
  user: User,
  interestId: string,
  req: RunInterestRequest,
): Promise<{ runId: string; cardId: string; ref: string }> {
  const r = await withAppendTx(ctx.pool, async (tx) => {
    const i = await lockInterest(tx, user, interestId);
    const org = await one(tx, 'SELECT status, plan, features FROM organizations WHERE id=$1', [i.org_id]);
    if (org && !isOrgOperational(org.status))
      throw conflict('org_suspended', 'the organization is not running');
    if (req.kind === 'scan') {
      const open = await openRun(tx, interestId, 'scan');
      if (open)
        throw conflict('run_in_progress', `a scan is already running (${open.ref})`, {
          ref: open.ref,
          cardId: open.card_id,
        });
    }
    if (req.mock && !ctx.config.mockUi)
      throw badRequest('mock_disabled', 'scripted mock fields are only accepted by the mock runtime');
    const mock = req.mock
      ? Object.fromEntries(
          Object.entries(req.mock).filter(([k]) => ['mock', 'mockFeed', 'mockResearch'].includes(k)),
        )
      : undefined;
    let sourceItem: { title: string; url: string } | undefined;
    if (req.sourceItemId) {
      const it = await one(
        tx,
        `SELECT d.title, d.url FROM digest_items d JOIN cards c ON c.id = d.card_id
          WHERE d.id=$1 AND c.interest_id=$2`,
        [req.sourceItemId, interestId],
      );
      if (!it) throw notFound('item not found in this interest');
      sourceItem = { title: it.title, url: it.url };
    }
    const run = await interestRunEvents(tx, i, req.kind, 'manual', ctx.clock.now(), {
      startedBy: user.id,
      question: req.question,
      depth: req.depth,
      sourceItem,
      mock,
    });
    await ctx.store.append(run.events, { tx });
    return { runId: run.runId, cardId: run.cardId, ref: run.ref };
  });
  ctx.services.dispatcher.trigger();
  return r;
}

// ------------------------------------------------------------------------------------------ the run schedule

/** Runs the interests whose scan is due (scheduler tick). Returns the cards created. */
export async function fireDueInterests(ctx: Ctx): Promise<Array<{ interestId: string; cardId: string }>> {
  const fired: Array<{ interestId: string; cardId: string }> = [];
  const now = ctx.clock.now();
  const due = await rows<{ id: string }>(
    ctx.pool,
    `SELECT id FROM interests WHERE status='active' AND archived_at IS NULL AND project_id IS NOT NULL
        AND next_scan_at IS NOT NULL AND next_scan_at <= $1 ORDER BY next_scan_at, id LIMIT 20`,
    [now],
  );
  for (const { id } of due) {
    try {
      const r = await withAppendTx(ctx.pool, async (tx) => {
        const i = await one(
          tx,
          `SELECT * FROM interests WHERE id=$1 AND status='active' AND archived_at IS NULL
              AND next_scan_at <= $2 FOR UPDATE SKIP LOCKED`,
          [id, now],
        );
        if (!i?.scan) return null;
        const scan = i.scan as { cron: string; timezone: string };
        const next = nextFireAfter(scan.cron, scan.timezone, now)?.toISOString() ?? null;
        const skip = async (error: string): Promise<null> => {
          await ctx.store.append(
            [
              {
                streamId: streamId.interest(i.id),
                event: {
                  type: 'InterestRunFailed',
                  payload: {
                    interestId: i.id,
                    kind: 'scan',
                    attempts: Number(i.fail_count ?? 0),
                    error,
                    nextScanAt: next,
                    counted: false,
                  },
                },
                actor: SYSTEM_ACTOR,
                scope: projectScope(i.org_id, i.project_id),
              },
            ],
            { tx },
          );
          return null;
        };
        // A suspended or cancelled organization starts nothing; a switched-off feature stops its interests.
        const org = await one(tx, 'SELECT status, plan, features FROM organizations WHERE id=$1', [i.org_id]);
        if (org && !isOrgOperational(org.status)) return skip('org_suspended');
        if (org && !effectiveFeatures(org.plan, org.features).interests) return skip('feature_disabled');
        if (await openRun(tx, i.id, 'scan')) return skip('previous_run_active');
        const run = await interestRunEvents(tx, i, 'scan', 'cron', now, { advance: true });
        await ctx.store.append([...run.events, ...(await resolveFailureNotice(tx, i))], { tx });
        return { interestId: i.id as string, cardId: run.cardId };
      });
      if (r) fired.push(r);
    } catch (err) {
      ctx.log.error({ err, interestId: id }, 'interest failed to run');
      await recordRunFailure(ctx, id, err, now).catch((e2) =>
        ctx.log.error({ err: e2, interestId: id }, 'could not record the interest failure'),
      );
    }
  }
  if (fired.length) ctx.services.dispatcher.trigger();
  return fired;
}

/** A run that works again closes the desk notice its earlier failures raised. */
async function resolveFailureNotice(tx: Tx, i: Row): Promise<AppendInput[]> {
  if (!i.failure_desk_item_id) return [];
  const open = await one(tx, `SELECT 1 FROM desk_items WHERE id=$1 AND status='open'`, [
    i.failure_desk_item_id,
  ]);
  if (!open) return [];
  return [
    {
      streamId: streamId.desk(i.failure_desk_item_id),
      event: {
        type: 'DeskItemResolved',
        payload: {
          deskItemId: i.failure_desk_item_id,
          resolution: 'acknowledged',
          note: 'The interest ran again.',
          by: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(i.org_id, i.project_id),
    },
  ];
}

/** A run that could not even start (project archived, workflow missing): back off, raise one notice after the third failure. */
async function recordRunFailure(ctx: Ctx, id: string, err: unknown, now: Date): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const i = await one(
      tx,
      `SELECT * FROM interests WHERE id=$1 AND status='active' AND next_scan_at <= $2 FOR UPDATE SKIP LOCKED`,
      [id, now],
    );
    if (!i) return;
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const attempts = Number(i.fail_count ?? 0) + 1;
    const nextScanAt = new Date(now.getTime() + scheduleBackoffMs(attempts));
    const noticeOpen = i.failure_desk_item_id
      ? await one(tx, `SELECT 1 FROM desk_items WHERE id=$1 AND status='open'`, [i.failure_desk_item_id])
      : undefined;
    const deskItemId = attempts >= 3 && !noticeOpen ? randomUUID() : undefined;
    const scope = projectScope(i.org_id, i.project_id);
    const events: AppendInput[] = [
      {
        streamId: streamId.interest(id),
        event: {
          type: 'InterestRunFailed',
          payload: {
            interestId: id,
            kind: 'scan',
            attempts,
            error: message,
            nextScanAt: nextScanAt.toISOString(),
            counted: true,
            ...(deskItemId ? { deskItemId } : {}),
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
    ];
    if (deskItemId)
      events.push({
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId,
            kind: 'alert',
            subkind: HR_DESK_SUBKIND.interestFailing,
            title: `Interest "${i.name}" cannot run`,
            body: `${message}\n\nIt keeps trying with growing pauses (next try ${nextScanAt.toISOString()}). Fix the cause or pause the interest; this notice closes when it runs again.`,
            blocking: false,
            pinned: false,
            options: [],
            projectId: i.project_id,
            affectedCardIds: [],
            askedBy: { kind: 'system' },
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      });
    await ctx.store.append(events, { tx });
  });
}

// ---------------------------------------------------------------------------------------- the delivery schedule

export interface HeldItem {
  id: string;
  title: string;
  kind: string;
  source: string;
  cardId: string;
}

/** Items put on the desk in the last 24 hours across the organization's interests: what the quiet cap counts. */
export async function deliveredInLastDay(db: Queryable, orgId: string, now: Date): Promise<number> {
  const r = await one<{ n: string }>(
    db,
    `SELECT count(*) AS n FROM digest_items d JOIN projects p ON p.id = d.project_id
      WHERE p.org_id = $1 AND p.kind = 'interest' AND d.delivered_at IS NOT NULL AND d.delivered_at > $2`,
    [orgId, new Date(now.getTime() - 86_400_000)],
  );
  return Number(r?.n ?? 0);
}

/** Posted items of the interest's runs that no delivery has put on the desk yet, oldest first. */
export async function heldItems(db: Queryable, interestId: string): Promise<HeldItem[]> {
  return rows<HeldItem>(
    db,
    `SELECT d.id, d.title, d.kind, d.source, d.card_id AS "cardId" FROM digest_items d
       JOIN cards c ON c.id = d.card_id
      WHERE c.interest_id=$1 AND d.delivered_at IS NULL ORDER BY d.event_seq, d.position`,
    [interestId],
  );
}

/**
 * The events that put `candidates` (held items, plus items an append is about to add) on the desk as one digest, within
 * the quiet cap: the rating desk item and `InterestDigestDelivered`. A delivery time with nothing to deliver only moves
 * the next delivery. Items over the cap stay held for the next delivery.
 */
export async function deliveryEvents(
  tx: Queryable,
  interest: Row,
  candidates: HeldItem[],
  now: Date,
  trigger: 'schedule' | 'manual',
): Promise<{ events: AppendInput[]; delivered: number; heldBack: number }> {
  const delivery = (interest.delivery ?? { mode: 'immediate' }) as DeliverySpec;
  const nextDeliveryAt =
    delivery.mode === 'scheduled' && interest.status === 'active'
      ? (nextFireAfter(delivery.cron, delivery.timezone, now)?.toISOString() ?? null)
      : null;
  const cap = (await reportingOf(tx, interest.org_id)).interestDigestCap;
  const room =
    cap == null ? candidates.length : Math.max(0, cap - (await deliveredInLastDay(tx, interest.org_id, now)));
  const take = candidates.slice(0, room);
  const heldBack = candidates.length - take.length;
  const scope = projectScope(interest.org_id, interest.project_id);
  const events: AppendInput[] = [];
  const deliveryId = randomUUID();
  let deskItemId: string | undefined;
  if (take.length > 0) {
    deskItemId = randomUUID();
    const newest = take[take.length - 1] as HeldItem;
    events.push({
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'rating',
          subkind: 'digest',
          title: `Rate the ${interest.name} digest (${take.length} item${take.length === 1 ? '' : 's'})`,
          body: take.map((i) => `- ${i.title} (${i.kind}, ${i.source})`).join('\n'),
          cardId: newest.cardId,
          projectId: interest.project_id,
          blocking: false,
          pinned: false,
          options: [],
          affectedCardIds: [],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    });
  }
  events.push({
    streamId: streamId.interest(interest.id),
    event: {
      type: 'InterestDigestDelivered',
      payload: {
        deliveryId,
        interestId: interest.id,
        itemIds: take.map((t) => t.id),
        ...(deskItemId ? { deskItemId } : {}),
        heldBack,
        trigger,
        nextDeliveryAt,
      },
    },
    actor: SYSTEM_ACTOR,
    scope,
  });
  return { events, delivered: take.length, heldBack };
}

/** Delivers what is due: scheduled interests at their delivery time, and any interest whose held items the cap let wait. */
export async function deliverDueInterests(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  const due = await rows<{ id: string }>(
    ctx.pool,
    `SELECT i.id FROM interests i
      WHERE i.project_id IS NOT NULL AND i.archived_at IS NULL AND i.status = 'active'
        AND ((i.delivery->>'mode' = 'scheduled' AND i.next_delivery_at IS NOT NULL AND i.next_delivery_at <= $1)
          OR (i.delivery->>'mode' = 'immediate' AND EXISTS (
               SELECT 1 FROM digest_items d JOIN cards c ON c.id = d.card_id
                WHERE c.interest_id = i.id AND d.delivered_at IS NULL)))
      ORDER BY i.id LIMIT 20`,
    [now],
  );
  let delivered = 0;
  for (const { id } of due) {
    try {
      delivered += await withAppendTx(ctx.pool, async (tx) => {
        const i = await one(
          tx,
          `SELECT * FROM interests WHERE id=$1 AND status='active' FOR UPDATE SKIP LOCKED`,
          [id],
        );
        if (!i) return 0;
        const org = await one(tx, 'SELECT status, plan, features FROM organizations WHERE id=$1', [i.org_id]);
        if (org && !isOrgOperational(org.status)) return 0;
        const d = (i.delivery ?? { mode: 'immediate' }) as DeliverySpec;
        const scheduledDue =
          d.mode === 'scheduled' && i.next_delivery_at && new Date(i.next_delivery_at) <= now;
        const held = await heldItems(tx, id);
        // An immediate interest with nothing held has nothing to do; a scheduled one at its time always moves on.
        if (!scheduledDue && held.length === 0) return 0;
        const plan = await deliveryEvents(tx, i, held, now, 'schedule');
        // An immediate interest whose cap leaves no room waits (no event: the tick looks again).
        if (!scheduledDue && plan.delivered === 0) return 0;
        await ctx.store.append(plan.events, { tx });
        return plan.delivered;
      });
    } catch (err) {
      ctx.log.error({ err, interestId: id }, 'interest delivery failed');
    }
  }
  return delivered;
}

/** "Deliver now": the held items go to the desk ahead of the schedule, still within the quiet cap. */
export async function deliverInterestNow(
  ctx: Ctx,
  user: User,
  interestId: string,
): Promise<{ delivered: number; heldBack: number }> {
  return withAppendTx(ctx.pool, async (tx) => {
    const i = await lockInterest(tx, user, interestId);
    const held = await heldItems(tx, interestId);
    if (held.length === 0) return { delivered: 0, heldBack: 0 };
    const plan = await deliveryEvents(tx, i, held, ctx.clock.now(), 'manual');
    if (plan.delivered === 0)
      throw badRequest('quiet_cap_reached', 'the organization has reached its daily limit of digest items');
    await ctx.store.append(plan.events, { tx });
    return { delivered: plan.delivered, heldBack: plan.heldBack };
  });
}
