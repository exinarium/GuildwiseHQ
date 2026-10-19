import { type EventOf, type EventType, REPEAT_DISMISS_DAYS } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;
const j = (v: unknown) => JSON.stringify(v);

/** The CEO as the owner's front door, step 1: turns, permission questions, the job log, corrections and order authority. */
export const ceoFrontDoorProjectors: Record<string, Projector> = {
  CeoTurnQueued: async (tx, e) => {
    const p = ev<'CeoTurnQueued'>(e).payload;
    await exec(
      tx,
      `INSERT INTO ceo_turns (id, org_id, thread_id, message_id, mode, status, queued, model, workstation_id,
         order_entry_id, order_version_hash, queued_at)
       VALUES ($1,$2,$3,$4,$5,'queued',$6,$7::jsonb,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
      [
        p.turnId,
        p.orgId,
        p.threadId,
        p.messageId ?? null,
        p.mode,
        p.queued,
        j(p.model),
        p.workstationId ?? null,
        p.orderEntryId ?? null,
        p.orderVersionHash ?? null,
        e.createdAt,
      ],
    );
  },
  CeoTurnStarted: async (tx, e) => {
    const p = ev<'CeoTurnStarted'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_turns SET status='running', started_at=$2, workstation_id=$3, model=$4::jsonb WHERE id=$1`,
      [p.turnId, e.createdAt, p.workstationId, j(p.model)],
    );
  },
  CeoTurnFinished: async (tx, e) => {
    const p = ev<'CeoTurnFinished'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_turns SET status=$2, finished_at=$3, error=$4, degraded=$5, tool_counts=$6::jsonb,
              model=COALESCE($7::jsonb, model) WHERE id=$1`,
      [
        p.turnId,
        p.status,
        e.createdAt,
        p.error ?? null,
        p.degraded ?? null,
        p.toolCounts ? j(p.toolCounts) : null,
        p.model ? j(p.model) : null,
      ],
    );
  },
  CeoOrderTurnRequested: async (tx, e) => {
    const p = ev<'CeoOrderTurnRequested'>(e).payload;
    await exec(tx, `UPDATE ceo_turns SET order_wake_id=$2, order_subject=$3, order_why=$4 WHERE id=$1`, [
      p.turnId,
      p.wakeId ?? null,
      p.subject,
      p.why,
    ]);
  },
  CeoOrderTurnFinished: async (tx, e) => {
    const p = ev<'CeoOrderTurnFinished'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_turns SET order_outcome=$2, order_summary=$3, order_commands=$4::jsonb, order_ask=$5 WHERE id=$1`,
      [p.turnId, p.outcome, p.summary, j(p.commands), p.ask ?? null],
    );
  },
  ChatThreadModelSet: async (tx, e) => {
    const p = ev<'ChatThreadModelSet'>(e).payload;
    await exec(tx, 'UPDATE threads SET model_override=$2::jsonb WHERE id=$1', [
      p.threadId,
      p.choice ? j(p.choice) : null,
    ]);
  },
  ChatThreadDirsSet: async (tx, e) => {
    const p = ev<'ChatThreadDirsSet'>(e).payload;
    await exec(tx, 'UPDATE threads SET dirs=$2::text[] WHERE id=$1', [p.threadId, p.dirs]);
  },
  CeoOffboardJobLogged: async (tx, e) => {
    const p = ev<'CeoOffboardJobLogged'>(e).payload;
    await exec(
      tx,
      `INSERT INTO ceo_offboard_jobs (id, org_id, turn_id, kind, title, summary, project_id, cost_micros, duration_ms, auto,
         first_token, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [
        p.jobId,
        p.orgId,
        p.turnId ?? null,
        p.kind,
        p.title,
        p.summary,
        p.projectId ?? null,
        p.costMicros,
        p.durationMs,
        p.auto,
        p.firstToken ?? null,
        e.createdAt,
      ],
    );
  },
  CeoRepeatDetected: async (tx, e) => {
    const p = ev<'CeoRepeatDetected'>(e).payload;
    await exec(
      tx,
      `INSERT INTO ceo_repeats (id, org_id, key, job_ids, suggestion, count7, count30, project_id, detected_at)
       VALUES ($1,$2,$3,$4::uuid[],$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [
        p.repeatId,
        p.orgId,
        p.key,
        p.jobIds,
        p.suggestion,
        p.count7,
        p.count30,
        p.projectId ?? null,
        e.createdAt,
      ],
    );
  },
  CeoRepeatResolved: async (tx, e) => {
    const p = ev<'CeoRepeatResolved'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_repeats SET status='resolved', decision=$2, resolved_by=$3, resolved_at=$4,
              suppressed_until = CASE WHEN $2 = 'dismissed' THEN $5::timestamptz ELSE suppressed_until END WHERE id=$1`,
      [
        p.repeatId,
        p.decision,
        p.by,
        e.createdAt,
        new Date(e.createdAt.getTime() + REPEAT_DISMISS_DAYS * 86_400_000),
      ],
    );
  },
  CeoCorrected: async (tx, e) => {
    const p = ev<'CeoCorrected'>(e).payload;
    await exec(
      tx,
      `INSERT INTO ceo_corrections (id, org_id, by_user_id, action_id, order_turn_id, chat_message_id, desk_item_id, text, rule,
         memory_id, remedy, redo, class, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14) ON CONFLICT (id) DO NOTHING`,
      [
        p.correctionId,
        p.orgId,
        p.by,
        p.actionId ?? null,
        p.orderTurnId ?? null,
        p.chatMessageId ?? null,
        p.deskItemId ?? null,
        p.text,
        p.rule,
        p.memoryId,
        p.remedy,
        p.redo ? j(p.redo) : null,
        p.class ?? null,
        e.createdAt,
      ],
    );
  },
  CeoCorrectionEdited: async (tx, e) => {
    const p = ev<'CeoCorrectionEdited'>(e).payload;
    await exec(tx, 'UPDATE ceo_corrections SET rule=$2, edited_at=$3 WHERE id=$1', [
      p.correctionId,
      p.rule,
      e.createdAt,
    ]);
  },
  CeoPermissionAsked: async (tx, e) => {
    const p = ev<'CeoPermissionAsked'>(e).payload;
    await exec(
      tx,
      `INSERT INTO ceo_permission_asks (id, org_id, turn_id, thread_id, mode, tool, input, reason, desk_item_id, asked_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
      [
        p.askId,
        p.orgId,
        p.turnId,
        p.threadId ?? null,
        p.mode,
        p.tool,
        p.input,
        p.reason,
        p.deskItemId,
        e.createdAt,
        new Date(e.createdAt.getTime() + 10 * 60_000),
      ],
    );
  },
  CeoPermissionAnswered: async (tx, e) => {
    const p = ev<'CeoPermissionAnswered'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_permission_asks SET status=$2, answered_by=$3, answered_at=$4 WHERE id=$1 AND status='pending'`,
      [p.askId, p.decision, p.by ?? null, e.createdAt],
    );
  },
  StandingOrderAuthorized: async (tx, e) => {
    const p = ev<'StandingOrderAuthorized'>(e).payload;
    await exec(
      tx,
      `INSERT INTO standing_order_authority (entry_id, org_id, version_hash, scope, covers, authorized_by, authorized_at)
       VALUES ($1,$2,$3,$4::jsonb,$5::text[],$6,$7)
       ON CONFLICT (entry_id) DO UPDATE SET version_hash=EXCLUDED.version_hash, scope=EXCLUDED.scope,
         covers=EXCLUDED.covers, authorized_by=EXCLUDED.authorized_by, authorized_at=EXCLUDED.authorized_at,
         voided_at=NULL, void_reason=NULL, revoked_at=NULL, revoked_by=NULL`,
      [p.entryId, p.orgId, p.versionHash, j(p.scope), p.covers, p.by, e.createdAt],
    );
  },
  StandingOrderAuthorityVoided: async (tx, e) => {
    const p = ev<'StandingOrderAuthorityVoided'>(e).payload;
    await exec(
      tx,
      `UPDATE standing_order_authority SET voided_at=COALESCE(voided_at,$2), void_reason=COALESCE(void_reason,$3)
        WHERE entry_id=$1 AND version_hash IS NOT NULL AND revoked_at IS NULL`,
      [p.entryId, e.createdAt, p.reason],
    );
  },
  StandingOrderAuthorityRevoked: async (tx, e) => {
    const p = ev<'StandingOrderAuthorityRevoked'>(e).payload;
    await exec(tx, `UPDATE standing_order_authority SET revoked_at=$2, revoked_by=$3 WHERE entry_id=$1`, [
      p.entryId,
      e.createdAt,
      p.by,
    ]);
  },
  StandingOrderEscalated: async (tx, e) => {
    const p = ev<'StandingOrderEscalated'>(e).payload;
    await exec(
      tx,
      `INSERT INTO standing_order_authority (entry_id, org_id, escalated_by, escalated_at, escalation_note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (entry_id) DO UPDATE SET escalated_by=EXCLUDED.escalated_by, escalated_at=EXCLUDED.escalated_at,
         escalation_note=EXCLUDED.escalation_note`,
      [p.entryId, p.orgId, p.by, e.createdAt, p.note],
    );
  },
};
