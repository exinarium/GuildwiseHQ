import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  eventTypesOf,
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

/** The triggers the sweep serves: the internal events of `SCHEDULE_EVENT_TRIGGERS` and `intake_ticket`. */
type TriggerName = ScheduleEventName | 'intake_ticket';

/** Domain event type -> the triggers read from it (`CardFinalized` feeds both `card_finalized` and `card_done`). */
const EVENT_TYPES = new Map<string, TriggerName[]>();
for (const t of SCHEDULE_EVENT_TRIGGERS)
  for (const type of eventTypesOf(t.id)) EVENT_TYPES.set(type, [...(EVENT_TYPES.get(type) ?? []), t.id]);
EVENT_TYPES.set('IntakeStarted', ['intake_ticket']);

const TRIGGER_LABEL = (n: TriggerName): string =>
  n === 'intake_ticket' ? 'An intake ticket is created' : scheduleEventLabel(n);

interface EventContext {
  name: TriggerName;
  orgId: string;
  projectId: string | null;
  interestId: string | null;
  ref: string;
  projectKey: string | null;
  label: string;
  details: Record<string, unknown>;
  /** The card the event is about (card triggers) or the intake. */
  sourceId: string | null;
  /** Card triggers: what the filters look at. */
  card?: {
    workflowKey: string | null;
    cardType: string;
    fields: Record<string, unknown>;
    scheduleId: string | null;
    toStage?: string;
  };
  /** `intake_ticket`: where the ticket came from. */
  intakeSource?: 'issues' | 'web';
  /** Values for the `{tokens}` of a field mapping. */
  tokens: Record<string, string | undefined>;
}

const fieldText = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);

async function contextOf(db: Queryable, e: Row, name: TriggerName): Promise<EventContext | null> {
  const p = e.payload as Record<string, any>;
  let projectId: string | null = e.project_id ?? null;
  let interestId: string | null = null;
  let ref = '';
  let what = '';
  let sourceId: string | null = null;
  let card: EventContext['card'];
  let intakeSource: EventContext['intakeSource'];
  const tokens: Record<string, string | undefined> = {};
  const details: Record<string, unknown> = {};
  if (name === 'phase_completed') {
    const ph = await one(db, 'SELECT ref, name, project_id FROM phases WHERE id=$1', [p.phaseId]);
    if (!ph) return null;
    projectId = ph.project_id;
    ref = ph.ref;
    what = `phase ${ph.ref} (${ph.name}) completed`;
    details.phase = { ref: ph.ref, name: ph.name };
    sourceId = p.phaseId;
  } else if (name === 'intake_ticket') {
    ref = (p.externalKey as string | undefined) ?? '';
    const note = String(p.note ?? '').trim();
    const title = (note.split('\n')[0] || 'Intake').slice(0, 200);
    intakeSource = p.externalSystem ? 'issues' : 'web';
    what = `intake ticket ${ref || title} created`;
    sourceId = p.intakeId;
    tokens['issue.key'] = ref;
    tokens['issue.title'] = title;
    details.intake = { id: p.intakeId, source: intakeSource, key: ref || null };
    projectId = null;
  } else if (name === 'interest_run_done') {
    const c = await one(db, 'SELECT ref, title, project_id, interest_id FROM cards WHERE id=$1', [p.cardId]);
    if (!c) return null;
    projectId = c.project_id;
    interestId = p.interestId ?? c.interest_id ?? null;
    ref = c.ref;
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
    sourceId = p.cardId;
  } else if (name === 'project_converted') {
    projectId = p.projectId ?? projectId;
    what = 'project converted';
  } else {
    // A card trigger: card_finalized, card_done, card_stage_reached, investigation_reported.
    const c = await one(
      db,
      `SELECT c.ref, c.title, c.project_id, c.interest_id, c.card_type, c.fields, c.schedule_id, v.key AS workflow_key
         FROM cards c LEFT JOIN workflow_versions v ON v.id = c.workflow_version_id WHERE c.id=$1`,
      [p.cardId],
    );
    if (!c) return null;
    projectId = c.project_id;
    interestId = c.interest_id ?? null;
    ref = c.ref;
    sourceId = p.cardId;
    card = {
      workflowKey: c.workflow_key ?? null,
      cardType: c.card_type,
      fields: (c.fields ?? {}) as Record<string, unknown>,
      scheduleId: c.schedule_id ?? null,
      ...(name === 'card_stage_reached' ? { toStage: p.toStage as string } : {}),
    };
    tokens['card.ref'] = c.ref;
    tokens['card.title'] = c.title;
    for (const [k, v] of Object.entries(card.fields)) tokens[`card.fields.${k}`] = fieldText(v);
    const base = { ref: c.ref, title: c.title, workflow: card.workflowKey };
    if (name === 'card_finalized' || name === 'card_done') {
      what = `card ${c.ref} (${c.title}) ${name === 'card_done' ? 'done' : 'finalized'}`;
      details.card = { ...base, action: p.action, ...(p.resultRef ? { result: p.resultRef } : {}) };
    } else if (name === 'card_stage_reached') {
      what = `card ${c.ref} (${c.title}) reached ${p.toStage}`;
      details.card = { ...base, stage: p.toStage };
    } else {
      what = `investigation of card ${c.ref} (${c.title}) reported`;
      details.card = { ...base, report: p.reportPath, investigationOnly: Boolean(p.investigationOnly) };
    }
  }
  const proj = projectId
    ? await one(db, 'SELECT key, name FROM projects WHERE id=$1', [projectId])
    : undefined;
  if (proj) details.project = { key: proj.key, name: proj.name };
  const label = `${what.charAt(0).toUpperCase()}${what.slice(1)}`.slice(0, 280);
  tokens.event = label;
  return {
    name,
    orgId: e.org_id,
    projectId,
    interestId,
    ref,
    projectKey: proj?.key ?? null,
    label,
    details,
    sourceId,
    ...(card ? { card } : {}),
    ...(intakeSource ? { intakeSource } : {}),
    tokens,
  };
}

/** The conditions of the trigger that SQL does not check: workflow, stage and the filter on the card. */
function matches(
  t: Extract<ScheduleTrigger, { kind: 'event' | 'intake_ticket' }>,
  ec: EventContext,
): boolean {
  if (t.kind === 'intake_ticket') return !t.source || t.source === ec.intakeSource;
  const card = ec.card;
  if (!card) return !t.workflowKey && !t.stageId && !t.filter;
  if (t.workflowKey && t.workflowKey !== card.workflowKey) return false;
  if (t.stageId && t.stageId !== card.toStage) return false;
  if (t.filter?.cardType && t.filter.cardType !== card.cardType) return false;
  for (const f of t.filter?.fieldEquals ?? [])
    if (!isDeepStrictEqual(card.fields[f.field], f.equals)) return false;
  return true;
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
    `SELECT 1 FROM schedules WHERE enabled AND trigger->>'kind' IN ('event','intake_ticket') LIMIT 1`,
  );
  let started = 0;
  let at = cursor;
  if (any) {
    for (;;) {
      const batch = await rows(
        ctx.pool,
        `SELECT seq, type, payload, org_id, project_id, created_at FROM events
          WHERE seq > $1 AND seq <= $2 AND type = ANY($3::text[]) ORDER BY seq LIMIT 100`,
        [at.toString(), head.toString(), [...EVENT_TYPES.keys()]],
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
  let n = 0;
  for (const name of EVENT_TYPES.get(e.type as string) ?? []) {
    const ec = await contextOf(ctx.pool, e, name);
    if (!ec) continue;
    const list = await rows(
      ctx.pool,
      `SELECT s.* FROM schedules s
        WHERE s.enabled AND s.org_id = $2 AND s.created_at <= $3
          AND (($6::text = 'intake_ticket' AND s.trigger->>'kind' = 'intake_ticket')
            OR ($6::text <> 'intake_ticket' AND s.trigger->>'kind' = 'event' AND s.trigger->>'event' = $1::text))
          AND (s.trigger->>'projectId' IS NULL OR s.trigger->>'projectId' = $4::text)
          AND (s.trigger->>'interestId' IS NULL OR s.trigger->>'interestId' = $5::text)
        ORDER BY s.created_at, s.id`,
      [ec.name, ec.orgId, e.created_at, ec.projectId, ec.interestId, ec.name],
    );
    for (const s of list) {
      if (!matches(s.trigger, ec)) continue;
      // An automation never answers a card it made itself (a stage trigger that creates cards would loop).
      if (ec.card?.scheduleId && ec.card.scheduleId === s.id) continue;
      if (await runForEvent(ctx, s, e, ec)) n++;
    }
  }
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
      event: TRIGGER_LABEL(ec.name).toLowerCase(),
      ref: ec.ref,
      ...(ec.projectKey ? { project: ec.projectKey } : {}),
    },
    tokens: ec.tokens,
    ...(ec.sourceId ? { sourceId: ec.sourceId } : {}),
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
      tokens: { 'issue.key': i.key, 'issue.title': i.title, event: 'labelled issue' },
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
