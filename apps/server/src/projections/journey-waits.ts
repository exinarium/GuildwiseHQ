import type { EventOf, EventType } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;
type Tx = Parameters<Projector>[0];

/** Adds a timeline entry to the wait row (shown on the instance). `guard` is extra SQL using $3.. as its own parameters. */
async function note(
  tx: Tx,
  waitId: string,
  at: Date | string,
  type: string,
  text: string,
  guard = '',
  params: unknown[] = [],
): Promise<void> {
  await exec(tx, `UPDATE journey_waits SET events = events || $2::jsonb WHERE id=$1 ${guard}`, [
    waitId,
    JSON.stringify([{ at: new Date(at).toISOString(), type, text }]),
    ...params,
  ]);
}

/**
 * Waits, gates, outbound calls and hook triggers. A fire (timeout, reminder, elapse) is applied only when its `firedFor`
 * equals the row's `next_fire_at` and the row is still open, so a second event for the same fire, or a replay, changes nothing.
 */
export const journeyWaitProjectors: Record<string, Projector> = {
  JourneyWaitStarted: async (tx, e) => {
    const p = ev<'JourneyWaitStarted'>(e).payload;
    await exec(
      tx,
      `INSERT INTO journey_waits (id, org_id, project_id, journey_id, instance_id, visit, step_id, kind, status, started_at,
         deadline_at, next_fire_at, config, link_id, link_expires_at, trigger_id)
       SELECT $1, i.org_id, i.project_id, i.journey_id, i.id, $3, $4, $5, 'open', $6, $7, $8, $9, $10, $11, $12
         FROM journey_instances i WHERE i.id=$2
       ON CONFLICT DO NOTHING`,
      [
        p.waitId,
        p.instanceId,
        p.visit,
        p.stepId,
        p.kind,
        p.startedAt,
        p.deadlineAt ?? null,
        p.nextFireAt ?? null,
        JSON.stringify(p.config),
        p.linkId ?? null,
        p.linkExpiresAt ?? null,
        p.triggerId ?? null,
      ],
    );
    await note(tx, p.waitId, e.createdAt, 'started', p.kind === 'gate' ? 'Waiting for a decision' : `Waiting (${p.kind})`);
  },

  JourneyWaitLinkSent: async (tx, e) => {
    const p = ev<'JourneyWaitLinkSent'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_waits SET link_id=$2, link_expires_at=$3, desk_item_id=COALESCE($4, desk_item_id) WHERE id=$1`,
      [p.waitId, p.linkId, p.expiresAt, p.deskItemId ?? null],
    );
    await note(
      tx,
      p.waitId,
      e.createdAt,
      'link',
      p.via === 'desk'
        ? 'Link shown on the desk'
        : p.via === 'offline_email'
          ? 'Secure link emailed (runner back online)'
          : 'Link passed to a webhook step',
    );
  },

  JourneyWaitOfflinePending: async (tx, e) => {
    const p = ev<'JourneyWaitOfflinePending'>(e).payload;
    await note(tx, p.waitId, p.attemptedAt, 'offline_pending', 'Documents pending, runner offline');
  },

  JourneyWaitTimedOut: async (tx, e) => {
    const p = ev<'JourneyWaitTimedOut'>(e).payload;
    await note(
      tx,
      p.waitId,
      e.createdAt,
      'timed_out',
      p.action === 'remind' ? `Timed out: reminder ${p.n ?? ''}`.trim() : `Timed out: ${p.action}`,
      `AND status='open' AND next_fire_at = $3::timestamptz`,
      [p.firedFor],
    );
  },

  JourneyWaitReminded: async (tx, e) => {
    const p = ev<'JourneyWaitReminded'>(e).payload;
    const r = await exec(
      tx,
      `UPDATE journey_waits SET reminders_sent=$2, next_fire_at=$3, deadline_at=$3, link_id=COALESCE($5, link_id), desk_item_id=COALESCE($7, desk_item_id),
         events = events || $6::jsonb
        WHERE id=$1 AND status='open' AND next_fire_at=$4::timestamptz`,
      [
        p.waitId,
        p.n,
        p.nextFireAt,
        p.firedFor,
        p.linkId ?? null,
        JSON.stringify([{ at: new Date(e.createdAt).toISOString(), type: 'reminded', text: `Reminder ${p.n} of ${p.of}` }]),
        p.deskItemId ?? null,
      ],
    );
    void r;
  },

  JourneyWaitEscalated: async (tx, e) => {
    const p = ev<'JourneyWaitEscalated'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_waits SET status='escalated', next_fire_at=NULL, desk_item_id=$2, events = events || $4::jsonb
        WHERE id=$1 AND status='open' AND ($3::timestamptz IS NULL OR next_fire_at=$3::timestamptz)`,
      [
        p.waitId,
        p.deskItemId,
        p.firedFor ?? null,
        JSON.stringify([
          {
            at: new Date(e.createdAt).toISOString(),
            type: 'escalated',
            text: p.reason === 'date_missing' ? 'The date could not be read: asked on the desk' : 'Timed out: asked on the desk',
          },
        ]),
      ],
    );
  },

  JourneyWaitExtended: async (tx, e) => {
    const p = ev<'JourneyWaitExtended'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_waits SET status='open', deadline_at=$2, next_fire_at=$2, events = events || $3::jsonb
        WHERE id=$1 AND status IN ('open','escalated')`,
      [
        p.waitId,
        p.deadlineAt,
        JSON.stringify([{ at: new Date(e.createdAt).toISOString(), type: 'extended', text: 'Deadline extended' }]),
      ],
    );
  },

  JourneyWaitResolved: async (tx, e) => {
    const p = ev<'JourneyWaitResolved'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_waits SET status='resolved', resolution=$2, resolved_at=$3, resolved_by=$4, submission_id=$5,
         next_fire_at=NULL, events = events || $7::jsonb
        WHERE id=$1 AND status IN ('open','escalated') AND ($6::timestamptz IS NULL OR next_fire_at=$6::timestamptz)`,
      [
        p.waitId,
        p.reason,
        e.createdAt,
        p.by ?? null,
        p.submissionId ?? null,
        p.firedFor ?? null,
        JSON.stringify([
          { at: new Date(e.createdAt).toISOString(), type: 'resolved', text: `Ended: ${p.reason.replace(/_/g, ' ')}` },
        ]),
      ],
    );
  },

  JourneyWaitCancelled: async (tx, e) => {
    const p = ev<'JourneyWaitCancelled'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_waits SET status='cancelled', resolution='cancelled', resolved_at=$2, next_fire_at=NULL,
         events = events || $3::jsonb
        WHERE id=$1 AND status IN ('open','escalated')`,
      [
        p.waitId,
        e.createdAt,
        JSON.stringify([{ at: new Date(e.createdAt).toISOString(), type: 'cancelled', text: `Cancelled: ${p.reason}` }]),
      ],
    );
  },

  JourneyGateOpened: async (tx, e) => {
    const p = ev<'JourneyGateOpened'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_waits SET desk_item_id=$2, approver_user_id=$3, approver_role=$4, fell_back=$5 WHERE id=$1`,
      [p.waitId, p.deskItemId, p.approverUserId ?? null, p.approverRole ?? null, p.fellBack],
    );
  },

  JourneyGateDecided: async (tx, e) => {
    const p = ev<'JourneyGateDecided'>(e).payload;
    await note(tx, p.waitId, e.createdAt, p.decision, p.decision === 'approved' ? 'Approved' : 'Rejected');
  },

  JourneyWebhookCallStarted: async (tx, e) => {
    const p = ev<'JourneyWebhookCallStarted'>(e).payload;
    await exec(
      tx,
      `INSERT INTO journey_webhook_calls (id, org_id, project_id, instance_id, visit, step_id, workstation_id, status, next_attempt_at, started_at)
       SELECT $1, i.org_id, i.project_id, i.id, $3, $4, $5, 'pending', $6, $6 FROM journey_instances i WHERE i.id=$2
       ON CONFLICT DO NOTHING`,
      [p.callId, p.instanceId, p.visit, p.stepId, p.workstationId, e.createdAt],
    );
  },

  JourneyWebhookCallDispatched: async (tx, e) => {
    const p = ev<'JourneyWebhookCallDispatched'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_webhook_calls SET status='dispatched', command_id=$2, command_deadline=$3, next_attempt_at=NULL, attempts=$4
        WHERE id=$1 AND status='pending'`,
      [p.callId, p.commandId, p.deadline, p.attempt],
    );
  },

  JourneyWebhookCallAttempted: async (tx, e) => {
    const p = ev<'JourneyWebhookCallAttempted'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_webhook_calls SET attempts=GREATEST(attempts,$2), last_http_status=$3, last_error=$4,
         command_id=NULL, command_deadline=NULL,
         status=CASE WHEN $5::timestamptz IS NOT NULL THEN 'pending' ELSE status END, next_attempt_at=$5::timestamptz
        WHERE id=$1 AND status IN ('pending','dispatched')`,
      [p.callId, p.attempt, p.httpStatus ?? null, p.error ?? null, p.nextAttemptAt ?? null],
    );
  },

  JourneyWebhookCallFinished: async (tx, e) => {
    const p = ev<'JourneyWebhookCallFinished'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_webhook_calls SET status=$2, attempts=$3, last_http_status=COALESCE($4, last_http_status),
         finished_at=$5, next_attempt_at=NULL, command_id=NULL, command_deadline=NULL
        WHERE id=$1 AND status IN ('pending','dispatched')`,
      [p.callId, p.ok ? 'ok' : 'failed', p.attempts, p.httpStatus ?? null, e.createdAt],
    );
  },

  JourneyHookTriggerCreated: async (tx, e) => {
    const p = ev<'JourneyHookTriggerCreated'>(e).payload;
    await exec(
      tx,
      `INSERT INTO journey_hook_triggers (id, org_id, project_id, journey_id, purpose, name, token_hash, secret_enc, scheme,
         mapping, on_no_match, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (id) DO NOTHING`,
      [
        p.triggerId,
        p.orgId,
        p.projectId,
        p.journeyId,
        p.purpose,
        p.name,
        p.tokenHash,
        p.secretEnc,
        p.scheme,
        JSON.stringify(p.mapping),
        p.onNoMatch,
        p.by,
        e.createdAt,
      ],
    );
  },

  JourneyHookTriggerUpdated: async (tx, e) => {
    const p = ev<'JourneyHookTriggerUpdated'>(e).payload;
    await exec(
      tx,
      `UPDATE journey_hook_triggers SET name=COALESCE($2,name), scheme=COALESCE($3,scheme),
         mapping=COALESCE($4::jsonb,mapping), on_no_match=COALESCE($5,on_no_match) WHERE id=$1`,
      [p.triggerId, p.name ?? null, p.scheme ?? null, p.mapping ? JSON.stringify(p.mapping) : null, p.onNoMatch ?? null],
    );
  },

  JourneyHookTriggerRotated: async (tx, e) => {
    const p = ev<'JourneyHookTriggerRotated'>(e).payload;
    await exec(tx, `UPDATE journey_hook_triggers SET token_hash=$2, secret_enc=$3, rotated_at=$4 WHERE id=$1`, [
      p.triggerId,
      p.tokenHash,
      p.secretEnc,
      e.createdAt,
    ]);
  },

  JourneyHookTriggerDisabled: async (tx, e) => {
    const p = ev<'JourneyHookTriggerDisabled'>(e).payload;
    await exec(tx, `UPDATE journey_hook_triggers SET enabled=false WHERE id=$1`, [p.triggerId]);
  },
};
