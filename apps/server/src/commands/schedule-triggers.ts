import { randomUUID } from 'node:crypto';
import {
  type IntegrationRunPayload,
  IntegrationRunResultSchema,
  isOrgOperational,
  type PolledIssue,
  SCHEDULE_EVENT_TRIGGERS,
  type ScheduleEventName,
  type ScheduleTrigger,
  scheduleEventLabel,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { SYSTEM_ACTOR } from './common.ts';
import { startIntakeIn } from './intake.ts';
import {
  executeAction,
  failedRun,
  type RunOutcome,
  type RunSpec,
  runRecordedEvent,
  scheduleScope,
} from './schedule-actions.ts';
import { afterRun, assertOwnerStillAllowed } from './schedules.ts';

/**
 * Event triggers (docs/ARCHITECTURE.md section 10.3). Evaluated by the server, never by an agent: a sweep reads the
 * event log after a stored cursor (`schedule_trigger_cursor`), once per scheduler tick and when the notifier sees new
 * events. A sweep rather than a hook on the append path because the log is the source of truth: a restart, a slow
 * action or a crash never loses an event (the cursor moves only after its events were handled), the action runs after
 * the event's own transaction committed (a failing schedule can never fail a phase or a card), and the dedupe key
 * (`schedule_runs (schedule_id, source_key)`) makes a replayed event run its schedule once.
 */

/** The domain events each trigger is read from: the one table in `SCHEDULE_EVENT_TRIGGERS` (shared), by event type. */
const EVENT_TYPES: Record<string, ScheduleEventName> = Object.fromEntries(
  SCHEDULE_EVENT_TRIGGERS.map((t) => [t.eventType, t.id]),
);

interface EventContext {
  name: ScheduleEventName;
  orgId: string;
  projectId: string | null;
  interestId: string | null;
  ref: string;
  projectKey: string | null;
  label: string;
  details: Record<string, unknown>;
}

async function contextOf(db: Queryable, e: Row): Promise<EventContext | null> {
  const name = EVENT_TYPES[e.type as string];
  if (!name) return null;
  const p = e.payload as Record<string, any>;
  let projectId: string | null = e.project_id ?? null;
  let interestId: string | null = null;
  let ref = '';
  let what = '';
  const details: Record<string, unknown> = {};
  if (name === 'phase_completed') {
    const ph = await one(db, 'SELECT ref, name, project_id FROM phases WHERE id=$1', [p.phaseId]);
    if (!ph) return null;
    projectId = ph.project_id;
    ref = ph.ref;
    what = `phase ${ph.ref} (${ph.name}) completed`;
    details.phase = { ref: ph.ref, name: ph.name };
  } else if (name === 'card_finalized' || name === 'interest_run_done') {
    const c = await one(db, 'SELECT ref, title, project_id, interest_id FROM cards WHERE id=$1', [p.cardId]);
    if (!c) return null;
    projectId = c.project_id;
    interestId =
      name === 'interest_run_done' ? (p.interestId ?? c.interest_id ?? null) : (c.interest_id ?? null);
    ref = c.ref;
    if (name === 'card_finalized') {
      what = `card ${c.ref} (${c.title}) finalized`;
      details.card = {
        ref: c.ref,
        title: c.title,
        action: p.action,
        ...(p.resultRef ? { result: p.resultRef } : {}),
      };
    } else {
      if (!interestId) return null;
      const i = await one(db, 'SELECT name FROM interests WHERE id=$1', [interestId]);
      what = `interest run done: ${i?.name ?? c.ref}`;
      details.interest = {
        id: interestId,
        name: i?.name ?? null,
        kind: p.kind,
        status: p.status,
        newItems: typeof p.published === 'number' ? p.published : 0,
      };
    }
  } else {
    projectId = p.projectId ?? projectId;
    what = 'project converted';
  }
  const proj = projectId
    ? await one(db, 'SELECT key, name FROM projects WHERE id=$1', [projectId])
    : undefined;
  if (proj) details.project = { key: proj.key, name: proj.name };
  return {
    name,
    orgId: e.org_id,
    projectId,
    interestId,
    ref,
    projectKey: proj?.key ?? null,
    label: `${what.charAt(0).toUpperCase()}${what.slice(1)}`.slice(0, 280),
    details,
  };
}

async function readCursor(ctx: Ctx): Promise<bigint> {
  await ctx.pool.query(
    `INSERT INTO schedule_trigger_cursor (id, last_seq) VALUES (1, (SELECT COALESCE(max(seq), 0) FROM events))
     ON CONFLICT (id) DO NOTHING`,
  );
  const r = await one<{ last_seq: string }>(
    ctx.pool,
    'SELECT last_seq FROM schedule_trigger_cursor WHERE id=1',
  );
  return BigInt(r?.last_seq ?? 0);
}

/** One pass over the new events. Returns how many schedule runs it started. */
export async function sweepEventTriggers(ctx: Ctx): Promise<number> {
  const cursor = await readCursor(ctx);
  const head = BigInt(
    (await one<{ m: string | null }>(ctx.pool, 'SELECT max(seq) AS m FROM events'))?.m ?? 0,
  );
  if (head <= cursor) return 0;
  // Are there event schedules at all? Most deployments have none: skip the read, still move the cursor.
  const any = await one(
    ctx.pool,
    `SELECT 1 FROM schedules WHERE enabled AND trigger->>'kind' = 'event' LIMIT 1`,
  );
  let started = 0;
  let at = cursor;
  if (any) {
    for (;;) {
      const batch = await rows(
        ctx.pool,
        `SELECT seq, type, payload, org_id, project_id, created_at FROM events
          WHERE seq > $1 AND seq <= $2 AND type = ANY($3::text[]) ORDER BY seq LIMIT 100`,
        [at.toString(), head.toString(), Object.keys(EVENT_TYPES)],
      );
      for (const e of batch) {
        started += await handleEvent(ctx, e).catch((err) => {
          ctx.log.error({ err, seq: e.seq }, 'event trigger failed');
          return 0;
        });
        at = BigInt(e.seq);
      }
      if (batch.length < 100) break;
    }
  }
  await ctx.pool.query('UPDATE schedule_trigger_cursor SET last_seq=$1 WHERE id=1 AND last_seq < $1', [
    head.toString(),
  ]);
  return started;
}

async function handleEvent(ctx: Ctx, e: Row): Promise<number> {
  const ec = await contextOf(ctx.pool, e);
  if (!ec) return 0;
  const list = await rows(
    ctx.pool,
    `SELECT s.* FROM schedules s
      WHERE s.enabled AND s.trigger->>'kind' = 'event' AND s.trigger->>'event' = $1 AND s.org_id = $2
        AND s.created_at <= $3
        AND (s.trigger->>'projectId' IS NULL OR s.trigger->>'projectId' = $4::text)
        AND (s.trigger->>'interestId' IS NULL OR s.trigger->>'interestId' = $5::text)
      ORDER BY s.created_at, s.id`,
    [ec.name, ec.orgId, e.created_at, ec.projectId, ec.interestId],
  );
  let n = 0;
  for (const s of list) if (await runForEvent(ctx, s, e, ec)) n++;
  return n;
}

async function runForEvent(ctx: Ctx, s: Row, e: Row, ec: EventContext): Promise<boolean> {
  const sourceKey = `event:${e.seq}`;
  const spec: RunSpec = {
    trigger: 'event',
    sourceKey,
    label: ec.label,
    firedFor: new Date(e.created_at),
    text: {
      event: scheduleEventLabel(ec.name).toLowerCase(),
      ref: ec.ref,
      ...(ec.projectKey ? { project: ec.projectKey } : {}),
    },
    details: { event: ec.name, ...ec.details },
  };
  let outcome: RunOutcome | null = null;
  try {
    outcome = await withAppendTx(ctx.pool, async (tx) => {
      const cur = await one(tx, 'SELECT * FROM schedules WHERE id=$1 AND enabled FOR UPDATE', [s.id]);
      if (!cur?.action) return null;
      if (
        await one(tx, 'SELECT 1 FROM schedule_runs WHERE schedule_id=$1 AND source_key=$2', [s.id, sourceKey])
      )
        return null;
      const org = await one(tx, 'SELECT status FROM organizations WHERE id=$1', [cur.org_id]);
      if (org && !isOrgOperational(org.status)) return null;
      if (cur.project_id) {
        const p = await one(tx, 'SELECT status FROM projects WHERE id=$1', [cur.project_id]);
        if (!p || p.status !== 'active') return null;
      }
      await assertOwnerStillAllowed(tx, cur);
      // The owner acts on what they can see: an event of a project they are not on does not run their schedule.
      if (ec.projectId && cur.owner_user_id) {
        const m = await one(
          tx,
          `SELECT 1 FROM project_members WHERE project_id=$1 AND user_id=$2 AND status='active'`,
          [ec.projectId, cur.owner_user_id],
        );
        if (!m) return null;
      }
      const o = await executeAction(ctx, tx, cur, spec);
      await ctx.store.append([...o.events, runRecordedEvent(cur, o, spec, ctx.clock.now())], { tx });
      return o;
    });
  } catch (err) {
    // Record the failure so the event is not retried on every sweep, and the history says why nothing happened.
    const msg = err instanceof Error ? err.message : String(err);
    await withAppendTx(ctx.pool, async (tx) => {
      if (
        await one(tx, 'SELECT 1 FROM schedule_runs WHERE schedule_id=$1 AND source_key=$2', [s.id, sourceKey])
      )
        return;
      await ctx.store.append([failedRun(randomUUID(), s, spec, msg)], { tx });
    }).catch(() => {});
    return false;
  }
  if (!outcome) return false;
  await afterRun(ctx, outcome);
  return true;
}

// ------------------------------------------------------------------------------------ issue polling

const issueNote = (provider: string, i: PolledIssue, projectKey: string | null): string =>
  [
    `New ${provider === 'github' ? 'GitHub' : 'Jira'} issue ${i.key}: ${i.title}`,
    i.url ?? '',
    projectKey ? `A schedule found it for project ${projectKey}.` : 'A schedule found it.',
    '',
    i.body.trim().slice(0, 6000),
  ]
    .filter((l, idx) => l || idx > 2)
    .join('\n');

/**
 * The workstation answered an `integration.run`. Either the answer of an `issues_poll` action (`runId`): the new
 * issues become intakes with the BA and the run is completed; or of a labelled-issue trigger (no `runId`): the action
 * runs once for each issue not seen before.
 */
export async function applyIntegrationResult(
  ctx: Ctx,
  payload: IntegrationRunPayload,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const s = await one(ctx.pool, 'SELECT * FROM schedules WHERE id=$1', [payload.scheduleId]);
  if (!s?.action) return;
  const parsed = IntegrationRunResultSchema.safeParse(result);
  const failure = !ok
    ? (error ?? 'the workstation could not poll')
    : !parsed.success
      ? 'the workstation answered something unexpected'
      : !parsed.data.ok
        ? (parsed.data.error ?? 'the poll failed')
        : null;
  const complete = (status: 'ok' | 'failed', summary: string, extra: Partial<RunOutcome> = {}) =>
    withAppendTx(ctx.pool, (tx) =>
      ctx.store.append(
        [
          {
            streamId: streamId.schedule(s.id),
            event: {
              type: 'ScheduleRunCompleted',
              payload: {
                runId: payload.runId as string,
                scheduleId: s.id,
                status,
                summary,
                ...(extra.result ? { result: extra.result } : {}),
                ...(extra.error ? { error: extra.error } : {}),
              },
            },
            actor: SYSTEM_ACTOR,
            scope: scheduleScope(s),
          },
        ],
        { tx },
      ),
    );
  if (failure || !parsed.success) {
    const msg = (failure ?? 'the poll failed').slice(0, 1900);
    if (payload.runId) await complete('failed', 'The poll failed', { error: msg });
    else
      await withAppendTx(ctx.pool, (tx) =>
        ctx.store.append(
          [failedRun(randomUUID(), s, { trigger: 'cron', firedFor: ctx.clock.now(), label: 'poll' }, msg)],
          { tx },
        ),
      );
    return;
  }
  const issues = parsed.data.issues;
  const seen = issues.length
    ? await rows<{ issue_key: string }>(
        ctx.pool,
        'SELECT issue_key FROM schedule_issues WHERE schedule_id=$1 AND issue_key = ANY($2::text[])',
        [s.id, issues.map((i) => i.key)],
      )
    : [];
  const known = new Set(seen.map((r) => r.issue_key));
  const fresh = issues.filter((i) => !known.has(i.key));

  if (payload.runId) {
    if (fresh.length === 0) {
      await complete('ok', issues.length ? 'No new issues' : 'No matching issues');
      return;
    }
    const projectKey = s.project_id
      ? ((await one(ctx.pool, 'SELECT key FROM projects WHERE id=$1', [s.project_id]))?.key ?? null)
      : null;
    const intakeIds: string[] = [];
    const taken: string[] = [];
    let firstError: string | undefined;
    for (const i of fresh) {
      try {
        const intake = await startIntakeIn(ctx, { id: s.owner_user_id }, s.org_id, {
          externalSystem: payload.integration,
          externalKey: i.key,
          note: issueNote(payload.integration, i, projectKey),
        });
        intakeIds.push(intake.id);
        taken.push(i.key);
      } catch (err) {
        firstError ??= err instanceof Error ? err.message : String(err);
      }
    }
    const left = fresh.length - taken.length;
    await complete(
      taken.length === 0 ? 'failed' : 'ok',
      taken.length
        ? `Took ${taken.length} new issue${taken.length === 1 ? '' : 's'} into intake: ${taken.join(', ')}${left ? `; ${left} will be tried again` : ''}`
        : `Found ${fresh.length} new issue${fresh.length === 1 ? '' : 's'} but could not start intake`,
      {
        result: { intakeIds, issueKeys: taken },
        ...(firstError && left ? { error: firstError.slice(0, 1900) } : {}),
      },
    );
    return;
  }

  // A labelled-issue trigger: the action runs for each issue not seen before.
  const trigger = s.trigger as Extract<ScheduleTrigger, { kind: 'issue_labelled' }>;
  for (const i of fresh) {
    const spec: RunSpec = {
      trigger: 'issue',
      sourceKey: `issue:${trigger.provider}:${i.key}`,
      label: `${trigger.provider === 'github' ? 'GitHub' : 'Jira'} issue ${i.key} labelled ${trigger.label}`,
      firedFor: ctx.clock.now(),
      text: {
        event: 'labelled issue',
        ref: i.key,
        issue: { key: i.key, title: i.title, ...(i.url ? { url: i.url } : {}) },
      },
      details: { issue: { key: i.key, title: i.title, url: i.url ?? null, labels: i.labels } },
    };
    let outcome: RunOutcome | null = null;
    try {
      outcome = await withAppendTx(ctx.pool, async (tx) => {
        const cur = await one(tx, 'SELECT * FROM schedules WHERE id=$1 AND enabled FOR UPDATE', [s.id]);
        if (!cur?.action) return null;
        await assertOwnerStillAllowed(tx, cur);
        const o = await executeAction(ctx, tx, cur, spec);
        o.result = { ...(o.result ?? {}), issueKeys: [i.key] };
        await ctx.store.append([...o.events, runRecordedEvent(cur, o, spec, ctx.clock.now())], { tx });
        return o;
      });
    } catch (err) {
      // Not marked seen: the next poll tries again, and the history says why this one did not work.
      const msg = err instanceof Error ? err.message : String(err);
      await withAppendTx(ctx.pool, (tx) =>
        ctx.store.append([failedRun(randomUUID(), s, { ...spec, sourceKey: undefined as never }, msg)], {
          tx,
        }),
      ).catch(() => {});
      continue;
    }
    if (outcome) await afterRun(ctx, outcome);
  }
}

export type { IntegrationRunPayload };
