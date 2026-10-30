import { type EventOf, legacyAction, type ScheduleAction, type ScheduleTrigger } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

type Body = Omit<EventOf<'ScheduleCreated'>['payload'], 'interestId'> & { interestId?: string | undefined };

/** The trigger and action of an event written before generic schedules are derived from `cron`, `kind` and `cardTemplate`. */
export function resolveBody(p: Body): { trigger: ScheduleTrigger; action: ScheduleAction | null } {
  const trigger: ScheduleTrigger = p.trigger ?? {
    kind: 'cron',
    cron: p.cron as string,
    timezone: p.timezone as string,
  };
  const action =
    p.action ?? (p.projectId && p.cardTemplate ? legacyAction(p.kind, p.projectId, p.cardTemplate) : null);
  return { trigger, action };
}

async function upsert(tx: Parameters<Projector>[0], p: Body, at: Date, orgId: string): Promise<void> {
  const proj = p.projectId
    ? await one<{ org_id: string }>(tx, 'SELECT org_id FROM projects WHERE id=$1', [p.projectId])
    : undefined;
  const { trigger, action } = resolveBody(p);
  const cron = trigger.kind === 'cron' || trigger.kind === 'issue_labelled' ? trigger.cron : null;
  const timezone = trigger.kind === 'cron' || trigger.kind === 'issue_labelled' ? trigger.timezone : null;
  const template =
    p.cardTemplate ??
    (action && (action.kind === 'create_card' || action.kind === 'regression_run') ? action.template : null);
  await exec(
    tx,
    `INSERT INTO schedules (id, org_id, project_id, name, kind, cron, timezone, card_template, enabled, next_fire_at,
       created_at, updated_at, interest_id, trigger, action, owner_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13,$14,$15)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, kind=EXCLUDED.kind, cron=EXCLUDED.cron,
       timezone=EXCLUDED.timezone, card_template=EXCLUDED.card_template, enabled=EXCLUDED.enabled,
       next_fire_at=EXCLUDED.next_fire_at, updated_at=EXCLUDED.updated_at, fail_count=0, last_error=NULL,
       trigger=EXCLUDED.trigger, action=EXCLUDED.action,
       owner_user_id=COALESCE(EXCLUDED.owner_user_id, schedules.owner_user_id)`,
    [
      p.scheduleId,
      proj?.org_id ?? orgId,
      p.projectId,
      p.name,
      p.kind,
      cron,
      timezone,
      template ? JSON.stringify(template) : null,
      p.enabled,
      p.nextFireAt,
      at,
      p.interestId ?? null,
      JSON.stringify(trigger),
      action ? JSON.stringify(action) : null,
      p.ownerUserId ?? null,
    ],
  );
}

/** The issues a run took: they never run this schedule again. */
async function markIssues(
  tx: Parameters<Projector>[0],
  scheduleId: string,
  runId: string,
  keys: string[] | undefined,
  at: Date,
): Promise<void> {
  for (const key of keys ?? [])
    await exec(
      tx,
      `INSERT INTO schedule_issues (schedule_id, issue_key, run_id, seen_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (schedule_id, issue_key) DO NOTHING`,
      [scheduleId, key, runId, at],
    );
}

/** Mirrors a run's outcome on its schedule (not for a test delivery: it is not a run of the schedule). */
async function mirrorStatus(
  tx: Parameters<Projector>[0],
  scheduleId: string,
  runId: string,
  status: string,
  summary: string | null,
): Promise<void> {
  await exec(
    tx,
    `UPDATE schedules SET last_status=$2, last_summary=COALESCE($4, last_summary)
      WHERE id=$1 AND (SELECT trigger FROM schedule_runs WHERE id=$3) <> 'test'`,
    [scheduleId, status, runId, summary],
  );
}

export const scheduleProjectors: Record<string, Projector> = {
  ScheduleCreated: async (tx, e) =>
    upsert(tx, (e.event as EventOf<'ScheduleCreated'>).payload, e.createdAt, e.scope.orgId as string),
  ScheduleUpdated: async (tx, e) =>
    upsert(tx, (e.event as EventOf<'ScheduleUpdated'>).payload, e.createdAt, e.scope.orgId as string),
  /** `ScheduleUpdated` never touches `interest_id`, so old and new events replay identically. */
  ScheduleLinked: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleLinked'>).payload;
    await exec(tx, 'UPDATE schedules SET interest_id=$2, updated_at=$3 WHERE id=$1', [
      p.scheduleId,
      p.interestId,
      e.createdAt,
    ]);
    // Back-fill the cards the schedule emitted before it was adopted (deterministic: they are earlier in the log).
    if (p.interestId)
      await exec(tx, 'UPDATE cards SET interest_id=$2 WHERE schedule_id=$1 AND interest_id IS NULL', [
        p.scheduleId,
        p.interestId,
      ]);
  },
  ScheduleDeleted: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleDeleted'>).payload;
    await exec(tx, 'DELETE FROM schedules WHERE id=$1', [p.scheduleId]);
  },
  ScheduleFired: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleFired'>).payload;
    await exec(
      tx,
      `UPDATE schedules SET last_fired_at=$2, next_fire_at=$3, last_card_id=COALESCE($4, last_card_id), updated_at=$2, fail_count=0,
              last_error=NULL, failure_desk_item_id=NULL WHERE id=$1`,
      [p.scheduleId, e.createdAt, p.nextFireAt, p.cardId ?? null],
    );
  },
  /** A due fire skipped (organization not running, feature off): the next fire moves on, nothing else changes. */
  ScheduleSkipped: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleSkipped'>).payload;
    await exec(tx, 'UPDATE schedules SET next_fire_at=$2, updated_at=$3 WHERE id=$1', [
      p.scheduleId,
      p.nextFireAt,
      e.createdAt,
    ]);
  },
  /** Backs off: the retry time replaces `next_fire_at`; the first failure of a streak remembers its desk notice. */
  ScheduleFireFailed: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleFireFailed'>).payload;
    await exec(
      tx,
      `UPDATE schedules SET next_fire_at=$2, fail_count=$3, last_error=$4,
              failure_desk_item_id = COALESCE($5::uuid, failure_desk_item_id), updated_at=$6 WHERE id=$1`,
      [p.scheduleId, p.nextFireAt, p.attempts, p.error, p.deskItemId ?? null, e.createdAt],
    );
  },
  ScheduleRunRecorded: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleRunRecorded'>).payload;
    const org = e.scope.orgId as string;
    const done = p.status !== 'pending' || !p.delivery;
    await exec(
      tx,
      `INSERT INTO schedule_runs (id, schedule_id, org_id, trigger, source_key, label, status, summary, error, result,
         delivery, next_attempt_at, started_at, finished_at, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (id) DO NOTHING`,
      [
        p.runId,
        p.scheduleId,
        org,
        p.trigger,
        p.sourceKey ?? null,
        p.label ?? null,
        p.status,
        p.summary,
        p.error ?? null,
        p.result ? JSON.stringify(p.result) : null,
        p.delivery ? JSON.stringify(p.delivery) : null,
        p.nextAttemptAt ?? null,
        e.createdAt,
        done && p.status !== 'pending' ? e.createdAt : null,
        p.dedupeKey ?? null,
      ],
    );
    await markIssues(tx, p.scheduleId, p.runId, p.result?.issueKeys, e.createdAt);
    if (p.trigger !== 'test') {
      await exec(
        tx,
        `UPDATE schedules SET last_fired_at=$2, last_status=$3, last_summary=$4,
                last_card_id=COALESCE($5::uuid, last_card_id), updated_at=$2 WHERE id=$1`,
        [p.scheduleId, e.createdAt, p.status, p.summary, p.result?.cardIds?.[0] ?? null],
      );
    }
  },
  /** Handed to the runner: no new try before the deadline. */
  ScheduleDeliveryDispatched: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleDeliveryDispatched'>).payload;
    await exec(tx, `UPDATE schedule_runs SET next_attempt_at=$2 WHERE id=$1 AND status='pending'`, [
      p.runId,
      p.deadline,
    ]);
  },
  ScheduleDeliveryAttempted: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleDeliveryAttempted'>).payload;
    await exec(
      tx,
      `INSERT INTO schedule_attempts (run_id, schedule_id, attempt, at, ok, http_status, error, duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        p.runId,
        p.scheduleId,
        p.attempt,
        e.createdAt,
        p.ok,
        p.httpStatus ?? null,
        p.error ?? null,
        p.durationMs ?? null,
      ],
    );
    await exec(
      tx,
      `UPDATE schedule_runs SET attempts=$2, status=$3, next_attempt_at=$4, error=$5,
              finished_at = CASE WHEN $3 = 'pending' THEN NULL ELSE $6::timestamptz END WHERE id=$1`,
      [p.runId, p.attempt, p.status, p.nextAttemptAt ?? null, p.ok ? null : (p.error ?? null), e.createdAt],
    );
    await mirrorStatus(tx, p.scheduleId, p.runId, p.status, null);
  },
  ScheduleRunCompleted: async (tx, e) => {
    const p = (e.event as EventOf<'ScheduleRunCompleted'>).payload;
    await exec(
      tx,
      `UPDATE schedule_runs SET status=$2, summary=$3, result=$4, error=$5, finished_at=$6 WHERE id=$1`,
      [
        p.runId,
        p.status,
        p.summary,
        p.result ? JSON.stringify(p.result) : null,
        p.error ?? null,
        e.createdAt,
      ],
    );
    await mirrorStatus(tx, p.scheduleId, p.runId, p.status, p.summary);
    await markIssues(tx, p.scheduleId, p.runId, p.result?.issueKeys, e.createdAt);
    if (p.result?.cardIds?.[0])
      await exec(tx, 'UPDATE schedules SET last_card_id=$2 WHERE id=$1', [p.scheduleId, p.result.cardIds[0]]);
  },
  FeedRunRequested: async (tx, e) => {
    const p = (e.event as EventOf<'FeedRunRequested'>).payload;
    if (!p.scheduleId) return;
    await exec(tx, `UPDATE schedules SET last_fired_at=$2, last_card_id=$3, updated_at=$2 WHERE id=$1`, [
      p.scheduleId,
      e.createdAt,
      p.cardId,
    ]);
  },
};
