import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

type SessionEventType =
  | 'SessionThreadCreated'
  | 'SessionThreadUpdated'
  | 'ThreadParticipantAdded'
  | 'ThreadParticipantUpdated'
  | 'ThreadParticipantRemoved'
  | 'SessionTurnQueued'
  | 'SessionTurnStarted'
  | 'SessionTurnRequeued'
  | 'SessionTurnCompleted'
  | 'SessionTurnFailed';

const ev = <T extends SessionEventType>(e: StoredEvent) => e.event as EventOf<T>;

/** Discovery and boardroom sessions: threads, participants and durable turns. Every write uses the event's time. */
export const sessionProjectors: Record<string, Projector> = {
  SessionThreadCreated: async (tx, e) => {
    const p = ev<'SessionThreadCreated'>(e).payload;
    await exec(
      tx,
      `INSERT INTO threads (id, org_id, project_id, kind, agent_id, title, created_by, created_at, workstation_id, session_config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.threadId,
        e.scope.orgId,
        p.projectId ?? null,
        p.kind,
        p.agentId ?? null,
        p.title,
        p.createdBy,
        e.createdAt,
        p.workstationId ?? null,
        JSON.stringify(p.config),
      ],
    );
  },
  SessionThreadUpdated: async (tx, e) => {
    const p = ev<'SessionThreadUpdated'>(e).payload;
    await exec(
      tx,
      `UPDATE threads SET title = COALESCE($2, title),
              workstation_id = COALESCE($3, workstation_id),
              session_config = CASE WHEN $4::jsonb IS NULL THEN session_config
                                    ELSE jsonb_strip_nulls(session_config || $4::jsonb) END
        WHERE id = $1`,
      [p.threadId, p.title ?? null, p.workstationId ?? null, p.config ? JSON.stringify(p.config) : null],
    );
  },
  ThreadParticipantAdded: async (tx, e) => {
    const p = ev<'ThreadParticipantAdded'>(e).payload;
    await exec(
      tx,
      `INSERT INTO thread_participants (id, thread_id, kind, ref_id, seat, stance, display_name, added_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (id) DO NOTHING`,
      [p.participantId, p.threadId, p.kind, p.refId, p.seat, p.stance ?? null, p.displayName, e.createdAt],
    );
  },
  ThreadParticipantUpdated: async (tx, e) => {
    const p = ev<'ThreadParticipantUpdated'>(e).payload;
    await exec(
      tx,
      `UPDATE thread_participants SET seat = COALESCE($2, seat), stance = COALESCE($3, stance) WHERE id = $1`,
      [p.participantId, p.seat ?? null, p.stance ?? null],
    );
  },
  // Soft removal: the messages the participant wrote keep their name.
  ThreadParticipantRemoved: async (tx, e) => {
    const p = ev<'ThreadParticipantRemoved'>(e).payload;
    await exec(tx, 'UPDATE thread_participants SET removed_at = $2 WHERE id = $1', [
      p.participantId,
      e.createdAt,
    ]);
  },

  SessionTurnQueued: async (tx, e) => {
    const p = ev<'SessionTurnQueued'>(e).payload;
    await exec(
      tx,
      `INSERT INTO session_turns (id, org_id, thread_id, participant_id, speaker_kind, speaker_name, agent_id, persona_key, seat,
         instructions, message, context, model, workstation_id, status, round, reply_to_message_id, requested_by, queued_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued',$15,$16,$17,$18)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.turnId,
        p.orgId,
        p.threadId,
        p.participantId,
        p.speaker.kind,
        p.speaker.name,
        p.speaker.agentId ?? null,
        p.speaker.personaKey ?? null,
        p.speaker.seat ?? null,
        p.instructions ?? null,
        p.message,
        JSON.stringify(p.context),
        JSON.stringify(p.model),
        p.workstationId,
        p.round ?? null,
        p.replyToMessageId ?? null,
        p.requestedBy,
        e.createdAt,
      ],
    );
  },
  SessionTurnStarted: async (tx, e) => {
    const p = ev<'SessionTurnStarted'>(e).payload;
    await exec(
      tx,
      `UPDATE session_turns SET status='running', attempts=$2, workstation_id=$3, started_at=$4 WHERE id=$1 AND status IN ('queued','running')`,
      [p.turnId, p.attempt, p.workstationId, e.createdAt],
    );
  },
  SessionTurnRequeued: async (tx, e) => {
    const p = ev<'SessionTurnRequeued'>(e).payload;
    await exec(
      tx,
      `UPDATE session_turns SET status='queued', started_at=NULL, workstation_id=COALESCE($2, workstation_id) WHERE id=$1 AND status='running'`,
      [p.turnId, p.workstationId ?? null],
    );
  },
  SessionTurnCompleted: async (tx, e) => {
    const p = ev<'SessionTurnCompleted'>(e).payload;
    await exec(
      tx,
      `UPDATE session_turns SET status='done', message_id=$2, usage=$3, runtime_session_id=$4, error=NULL, finished_at=$5
        WHERE id=$1 AND status IN ('queued','running')`,
      [p.turnId, p.messageId, JSON.stringify(p.usage), p.runtimeSessionId ?? null, e.createdAt],
    );
  },
  SessionTurnFailed: async (tx, e) => {
    const p = ev<'SessionTurnFailed'>(e).payload;
    await exec(
      tx,
      `UPDATE session_turns SET status='failed', error=$2, finished_at=$3 WHERE id=$1 AND status IN ('queued','running')`,
      [p.turnId, p.error, e.createdAt],
    );
  },
};
