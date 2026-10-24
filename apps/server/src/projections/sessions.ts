import { costUsdMicros, type EventOf, isCostUnknown, PERSONA_HOST_AGENT_ID } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
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
  | 'DelegateCompleted'
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
         instructions, message, context, model, workstation_id, status, round, reply_to_message_id, requested_by, queued_at, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'queued',$15,$16,$17,$18,$19)
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
        p.meta ? JSON.stringify(p.meta) : null,
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
    // A session turn is not a shift, but its tokens are the organization's cost: one `shift_costs` row keyed by the turn id
    // (kind `session`), so the cost ledger, the project budgets and the cost pages count it. Priced like a shift: a stamped
    // price is used as is, otherwise the default table (a replay of an event that carried no price).
    const t = await one(
      tx,
      `SELECT st.org_id, st.thread_id, st.agent_id, st.model, th.project_id
         FROM session_turns st LEFT JOIN threads th ON th.id = st.thread_id WHERE st.id = $1`,
      [p.turnId],
    );
    if (!t) return;
    const model = p.usage.model ?? (t.model as { model?: string } | null)?.model ?? 'unknown';
    await exec(
      tx,
      `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, kind, model, tokens_input, tokens_output,
         tokens_cache_read, tokens_cache_write, cost_usd_micros, reported_usd_micros, ended_at, cost_stamped, cost_unknown,
         key_source, key_provider, owner_priced)
       VALUES ($1,$2,$3,$4,'session',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (shift_id) DO NOTHING`,
      [
        p.turnId,
        t.org_id,
        t.agent_id ?? PERSONA_HOST_AGENT_ID,
        t.project_id ?? null,
        model,
        p.usage.inputTokens,
        p.usage.outputTokens,
        p.usage.cacheReadTokens,
        p.usage.cacheWriteTokens,
        p.costMicros ?? costUsdMicros(model, { ...p.usage }),
        p.usage.costUsd === undefined ? null : Math.round(p.usage.costUsd * 1_000_000),
        e.createdAt,
        p.costMicros !== undefined,
        // Stamped by the interceptor; an event from before it is judged by the model, which is deterministic on replay.
        p.costUnknown ?? (p.usage.ownerPriced ? false : isCostUnknown(model)),
        p.usage.keySource ?? null,
        p.usage.keyProvider ?? null,
        p.usage.ownerPriced === true,
      ],
    );
  },
  /**
   * A nested `aom delegate` call: one `shift_costs` row of kind `delegate` keyed by the delegate id, attributed to the
   * caller's agent, project, card and phase; `parent_id` is the caller, so the session meter (`sessionCost`) adds it to its turns.
   */
  DelegateCompleted: async (tx, e) => {
    const p = ev<'DelegateCompleted'>(e).payload;
    const c =
      p.callerKind === 'session_turn'
        ? await one(
            tx,
            `SELECT st.org_id, st.agent_id, th.project_id, NULL::uuid AS card_id, NULL::uuid AS phase_id
               FROM session_turns st LEFT JOIN threads th ON th.id = st.thread_id WHERE st.id = $1`,
            [p.callerId],
          )
        : await one(
            tx,
            `SELECT s.org_id, s.agent_id, COALESCE(s.project_id, c.project_id, bt.project_id) AS project_id, s.card_id, bt.phase_id
               FROM shifts s LEFT JOIN cards c ON c.id = s.card_id LEFT JOIN ba_tasks bt ON bt.id = s.ba_task_id
              WHERE s.id = $1`,
            [p.callerId],
          );
    if (!c) return;
    const model = p.usage.model ?? 'unknown';
    await exec(
      tx,
      `INSERT INTO shift_costs (shift_id, org_id, agent_id, project_id, card_id, phase_id, kind, model, tokens_input,
         tokens_output, tokens_cache_read, tokens_cache_write, cost_usd_micros, reported_usd_micros, ended_at, cost_stamped,
         cost_unknown, parent_id, key_source, key_provider, owner_priced)
       VALUES ($1,$2,$3,$4,$5,$6,'delegate',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (shift_id) DO NOTHING`,
      [
        p.delegateId,
        c.org_id,
        c.agent_id ?? PERSONA_HOST_AGENT_ID,
        c.project_id ?? null,
        c.card_id ?? null,
        c.phase_id ?? null,
        model,
        p.usage.inputTokens,
        p.usage.outputTokens,
        p.usage.cacheReadTokens,
        p.usage.cacheWriteTokens,
        p.costMicros ?? costUsdMicros(model, { ...p.usage }),
        p.usage.costUsd === undefined ? null : Math.round(p.usage.costUsd * 1_000_000),
        e.createdAt,
        p.costMicros !== undefined,
        p.costUnknown ?? (p.usage.ownerPriced ? false : isCostUnknown(model)),
        p.callerId,
        p.usage.keySource ?? null,
        p.usage.keyProvider ?? null,
        p.usage.ownerPriced === true,
      ],
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
