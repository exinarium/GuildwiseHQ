import type { EventOf, EventType } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;
const j = (v: unknown) => JSON.stringify(v);

/** A CEO created without a training period (the built-in CEO) is graduated from the start. */
const GRADUATED = { on: false, startedAt: null, until: null, graduatedAt: null, extensions: 0 };

const DESK_CLASSES = ['desk.answer_question', 'desk.triage', 'desk.resolve_notice'];

/** The CEO agent: settings, policy, the action audit, tasks and memory metadata (docs/design/ceo-agent-v2.md). */

/** Merges `patch` into the CEO-decision block of a desk item's data. */
async function patchDecision(
  tx: Parameters<Projector>[0],
  deskItemId: string,
  patch: (cur: Record<string, any>) => Record<string, any>,
): Promise<void> {
  const row = await one<{ data: Record<string, any> | null }>(tx, 'SELECT data FROM desk_items WHERE id=$1', [
    deskItemId,
  ]);
  if (!row) return;
  const data = row.data ?? {};
  await exec(tx, 'UPDATE desk_items SET data=$2::jsonb WHERE id=$1', [deskItemId, j(patch(data))]);
}

export const ceoProjectors: Record<string, Projector> = {
  // The owner's review of a CEO decision, shown on the desk item.
  CeoDecisionReviewed: async (tx, e) => {
    const p = ev<'CeoDecisionReviewed'>(e).payload;
    await patchDecision(tx, p.deskItemId, (data) => {
      if (p.outcome === 'acknowledged') return { ...data, acknowledgedAt: e.createdAt.toISOString() };
      const cur = (data.correction ?? {}) as Record<string, any>;
      return {
        ...data,
        correction: {
          ...cur,
          ...(p.correction ? { text: p.correction } : {}),
          ...(cur.at ? {} : { at: e.createdAt.toISOString() }),
          ...(p.applied ? { applied: p.applied } : {}),
          ...(p.reviewId ? { reviewId: p.reviewId } : {}),
          ...(p.memoryId ? { memoryId: p.memoryId } : {}),
          by: p.by,
          review: cur.review ?? 'pending',
        },
      };
    });
  },
  CeoCorrectionAnalysed: async (tx, e) => {
    const p = ev<'CeoCorrectionAnalysed'>(e).payload;
    await patchDecision(tx, p.deskItemId, (data) => {
      const cur = (data.correction ?? {}) as Record<string, any>;
      return {
        ...data,
        correction: {
          ...cur,
          analysis: p.analysis,
          analysedAt: e.createdAt.toISOString(),
          ...(p.baAgentId ? { baAgentId: p.baAgentId } : {}),
          ...(p.proposedRule ? { proposedRule: p.proposedRule } : {}),
          ...(p.proposedCards ? { proposedCards: p.proposedCards } : {}),
          ...(p.noFixReason ? { noFixReason: p.noFixReason } : {}),
          ...(p.consequences ? { consequences: p.consequences } : {}),
          review: cur.review === 'done' || cur.review === 'lesson' ? cur.review : 'analysed',
        },
      };
    });
  },
  CeoLessonRecorded: async (tx, e) => {
    const p = ev<'CeoLessonRecorded'>(e).payload;
    await patchDecision(tx, p.deskItemId, (data) => ({
      ...data,
      correction: {
        ...(data.correction ?? {}),
        lesson: p.lesson,
        lessonMemoryId: p.memoryId,
        lessonAt: e.createdAt.toISOString(),
        ceoReply: {
          stance: p.stance ?? null,
          reflection: p.reflection ?? null,
          cardChanges: p.cardChanges ?? null,
          withoutCeo: p.withoutCeo === true,
          at: e.createdAt.toISOString(),
        },
        // Older lessons ended the review; with a final BA turn the review ends with `CeoReviewConcluded`.
        review: p.finalTurn ? 'lesson' : 'done',
      },
    }));
  },
  CeoReviewConcluded: async (tx, e) => {
    const p = ev<'CeoReviewConcluded'>(e).payload;
    await patchDecision(tx, p.deskItemId, (data) => ({
      ...data,
      correction: {
        ...(data.correction ?? {}),
        review: 'done',
        final: {
          summary: p.summary,
          cards: p.cards,
          skipped: p.skipped,
          fallback: p.fallback === true,
          at: e.createdAt.toISOString(),
        },
      },
    }));
  },
  CeoEnabled: async (tx, e) => {
    const p = ev<'CeoEnabled'>(e).payload;
    await exec(
      tx,
      `INSERT INTO ceo_settings (org_id, agent_id, enabled, paused, settings, policy, policy_version, training, enabled_at, updated_at)
       VALUES ($1,$2,true,false,$3,$4,$5,$6,$7,$7)
       ON CONFLICT (org_id) DO UPDATE SET agent_id=EXCLUDED.agent_id, enabled=true, paused=false, paused_reason=NULL,
         settings=EXCLUDED.settings, policy=EXCLUDED.policy, policy_version=EXCLUDED.policy_version,
         training=EXCLUDED.training, enabled_at=EXCLUDED.enabled_at, updated_at=EXCLUDED.updated_at`,
      [
        p.orgId,
        p.agentId,
        j(p.settings),
        j(p.policy),
        p.policy.version,
        j(p.training ?? GRADUATED),
        e.createdAt,
      ],
    );
  },
  CeoDisabled: async (tx, e) => {
    const p = ev<'CeoDisabled'>(e).payload;
    await exec(
      tx,
      'UPDATE ceo_settings SET enabled=false, agent_id=NULL, paused=false, updated_at=$2 WHERE org_id=$1',
      [p.orgId, e.createdAt],
    );
  },
  CeoPaused: async (tx, e) => {
    const p = ev<'CeoPaused'>(e).payload;
    await exec(tx, 'UPDATE ceo_settings SET paused=true, paused_reason=$2, updated_at=$3 WHERE org_id=$1', [
      p.orgId,
      p.reason ?? null,
      e.createdAt,
    ]);
  },
  CeoResumed: async (tx, e) => {
    const p = ev<'CeoResumed'>(e).payload;
    await exec(
      tx,
      'UPDATE ceo_settings SET paused=false, paused_reason=NULL, updated_at=$2 WHERE org_id=$1',
      [p.orgId, e.createdAt],
    );
  },
  CeoPolicyChanged: async (tx, e) => {
    const p = ev<'CeoPolicyChanged'>(e).payload;
    await exec(tx, 'UPDATE ceo_settings SET policy=$2, policy_version=$3, updated_at=$4 WHERE org_id=$1', [
      p.orgId,
      j(p.policy),
      p.version,
      e.createdAt,
    ]);
  },
  CeoSettingsChanged: async (tx, e) => {
    const p = ev<'CeoSettingsChanged'>(e).payload;
    await exec(tx, 'UPDATE ceo_settings SET settings=$2, updated_at=$3 WHERE org_id=$1', [
      p.orgId,
      j(p.settings),
      e.createdAt,
    ]);
  },
  CeoTrainingChanged: async (tx, e) => {
    const p = ev<'CeoTrainingChanged'>(e).payload;
    await exec(tx, 'UPDATE ceo_settings SET training=$2, updated_at=$3 WHERE org_id=$1', [
      p.orgId,
      j(p.training),
      e.createdAt,
    ]);
  },
  CeoChatLinked: async (tx, e) => {
    const p = ev<'CeoChatLinked'>(e).payload;
    await exec(tx, 'UPDATE ceo_settings SET chat_thread_id=$2, updated_at=$3 WHERE org_id=$1', [
      p.orgId,
      p.threadId,
      e.createdAt,
    ]);
  },
  CeoReportPosted: async (tx, e) => {
    const p = ev<'CeoReportPosted'>(e).payload;
    await exec(tx, 'UPDATE ceo_settings SET report_day=$2, updated_at=$3 WHERE org_id=$1', [
      p.orgId,
      p.localDate,
      e.createdAt,
    ]);
  },

  CeoShiftDispatched: async (tx, e) => {
    const p = ev<'CeoShiftDispatched'>(e).payload;
    const a = await one<{ runtime: string; model: string }>(
      tx,
      'SELECT runtime, model FROM agents WHERE id=$1',
      [p.agentId],
    );
    if (!a) return;
    await exec(
      tx,
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, runtime, model, overflow, started_at)
       VALUES ($1,$2,$3,$4,NULL,'ceo',NULL,'starting',$5,$6,false,$7) ON CONFLICT (id) DO NOTHING`,
      [p.shiftId, p.orgId, p.agentId, p.workstationId, a.runtime, a.model, e.createdAt],
    );
  },
  CeoActionTaken: async (tx, e) => {
    const p = ev<'CeoActionTaken'>(e).payload;
    const status = p.mode === 'decided' ? 'done' : p.mode;
    await exec(
      tx,
      `INSERT INTO ceo_actions (id, org_id, class, action, mode, status, subject_kind, subject_id, subject_label, params,
         reason, confidence, evidence, policy_version, verdict_reason, cause, wake_batch_id, chat_thread_id, accepted_from,
         untrusted, inverse, idem_key, result, created_at, event_seq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.actionId,
        p.orgId,
        p.class,
        p.action,
        p.mode,
        status,
        p.subjectKind,
        p.subjectId,
        p.subjectLabel,
        j(p.params),
        p.reason,
        p.confidence,
        j(p.evidence),
        p.policyVersion,
        p.verdictReason,
        p.cause ?? null,
        p.wakeBatchId ?? null,
        p.chatThreadId ?? null,
        p.acceptedFrom ?? null,
        p.origin.untrusted,
        p.inverse ? j(p.inverse) : null,
        p.idemKey,
        j(p.result),
        e.createdAt,
        e.seq,
      ],
    );
    if (p.mode === 'decided' && DESK_CLASSES.includes(p.class) && p.subjectKind === 'desk' && p.subjectId)
      await exec(tx, 'UPDATE desk_items SET ceo_action_id=$2 WHERE id=$1', [p.subjectId, p.actionId]);
  },
  CeoRecommendationMade: async (tx, e) => {
    const p = ev<'CeoRecommendationMade'>(e).payload;
    if (p.deskItemId) {
      await exec(tx, 'UPDATE ceo_actions SET desk_item_id=$2 WHERE id=$1', [p.actionId, p.deskItemId]);
      await exec(tx, 'UPDATE desk_items SET ceo_recommendation=$2, updated_at=$3 WHERE id=$1', [
        p.deskItemId,
        j({
          actionId: p.actionId,
          option: p.option ?? null,
          text: p.text ?? null,
          reason: p.reason,
          confidence: p.confidence,
          at: e.createdAt.toISOString(),
        }),
        e.createdAt,
      ]);
    }
  },
  CeoRecommendationResponded: async (tx, e) => {
    const p = ev<'CeoRecommendationResponded'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_actions SET response=$2, response_note=$3, response_choice=$4, responded_at=$5
        WHERE id=$1 AND response IS NULL`,
      [p.actionId, p.response, p.note ?? null, p.ownerChoice ?? null, e.createdAt],
    );
  },
  CeoActionUndone: async (tx, e) => {
    const p = ev<'CeoActionUndone'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_actions SET status='undone', undone_at=$2, undone_by=$3, undo_kind=$4 WHERE id=$1`,
      [p.actionId, e.createdAt, p.by, p.kind],
    );
    await exec(tx, 'UPDATE desk_items SET ceo_action_id=NULL WHERE ceo_action_id=$1', [p.actionId]);
  },

  CeoTaskCreated: async (tx, e) => {
    const p = ev<'CeoTaskCreated'>(e).payload;
    await exec(
      tx,
      `INSERT INTO ceo_tasks (id, org_id, title, request, status, thread_id, due_at, watch, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'open',$5,$6,$7,$8,$9,$9) ON CONFLICT (id) DO NOTHING`,
      [
        p.taskId,
        p.orgId,
        p.title,
        p.request,
        p.threadId ?? null,
        p.due ?? null,
        j(p.watch),
        p.by,
        e.createdAt,
      ],
    );
  },
  CeoTaskUpdated: async (tx, e) => {
    const p = ev<'CeoTaskUpdated'>(e).payload;
    const cur = await one<{ notes: unknown[] }>(tx, 'SELECT notes FROM ceo_tasks WHERE id=$1', [p.taskId]);
    if (!cur) return;
    const notes = p.note
      ? [...(cur.notes ?? []), { at: e.createdAt.toISOString(), by: p.by, note: p.note }]
      : cur.notes;
    const terminal = p.status === 'done' || p.status === 'failed' || p.status === 'cancelled';
    await exec(
      tx,
      `UPDATE ceo_tasks SET status=COALESCE($2,status), title=COALESCE($3,title), notes=$4,
              watch=COALESCE($5::jsonb, watch), due_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE due_at END,
              updated_at=$8, done_at = CASE WHEN $9::boolean THEN $8 ELSE done_at END
        WHERE id=$1`,
      [
        p.taskId,
        p.status ?? null,
        p.title ?? null,
        j(notes),
        p.watch ? j(p.watch) : null,
        p.due !== undefined,
        p.due ?? null,
        e.createdAt,
        terminal,
      ],
    );
  },

  CeoMemoryAdded: async (tx, e) => {
    const p = ev<'CeoMemoryAdded'>(e).payload;
    await exec(
      tx,
      `INSERT INTO ceo_memories (id, org_id, kind, scope, source, source_ref, confidence, status, class, text_hash, created_at, last_confirmed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::timestamptz,CASE WHEN $8::text='active' THEN $11::timestamptz ELSE NULL END)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.memoryId,
        p.orgId,
        p.kind,
        p.scope,
        p.source,
        p.sourceRef,
        p.confidence,
        p.status,
        p.class ?? null,
        p.textHash,
        e.createdAt,
      ],
    );
  },
  CeoMemoryConfirmed: async (tx, e) => {
    const p = ev<'CeoMemoryConfirmed'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_memories SET status=$2, last_confirmed_at=$3, confidence=GREATEST(confidence, 0.9) WHERE id=$1 AND status <> 'forgotten'`,
      [p.memoryId, p.status, e.createdAt],
    );
  },
  CeoMemoryEdited: async (tx, e) => {
    const p = ev<'CeoMemoryEdited'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_memories SET text_hash=$2, scope=COALESCE($3, scope), last_confirmed_at=$4, source='owner_edit' WHERE id=$1 AND status <> 'forgotten'`,
      [p.memoryId, p.textHash, p.scope ?? null, e.createdAt],
    );
  },
  CeoMemoryRetired: async (tx, e) => {
    const p = ev<'CeoMemoryRetired'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_memories SET status='retired', retired_reason=$2 WHERE id=$1 AND status <> 'forgotten'`,
      [p.memoryId, p.reason],
    );
  },
  CeoMemoryAdjusted: async (tx, e) => {
    const p = ev<'CeoMemoryAdjusted'>(e).payload;
    await exec(
      tx,
      `UPDATE ceo_memories SET confidence=$2::real, observations=COALESCE($3::int, observations),
              status = CASE WHEN $2::real < 0.4 AND status='active' THEN 'retired' ELSE status END
        WHERE id=$1 AND status <> 'forgotten'`,
      [p.memoryId, p.confidence, p.observations ?? null],
    );
  },
  CeoMemoryForgotten: async (tx, e) => {
    const p = ev<'CeoMemoryForgotten'>(e).payload;
    await exec(tx, `UPDATE ceo_memories SET status='forgotten', text_hash='' WHERE id=$1`, [p.memoryId]);
    await exec(tx, 'DELETE FROM ceo_memory_text WHERE memory_id=$1', [p.memoryId]);
  },

  // Agent pause and resume (generic, used by the CEO and by managers).
  AgentPaused: async (tx, e) => {
    const p = ev<'AgentPaused'>(e).payload;
    await exec(
      tx,
      `UPDATE agents SET paused_at=$2, paused_by=$3, pause_reason=$4, paused_via_ceo=$5 WHERE id=$1`,
      [p.agentId, e.createdAt, p.by ?? null, p.reason, p.viaCeo],
    );
  },
  AgentResumed: async (tx, e) => {
    const p = ev<'AgentResumed'>(e).payload;
    await exec(
      tx,
      `UPDATE agents SET paused_at=NULL, paused_by=NULL, pause_reason=NULL, paused_via_ceo=false WHERE id=$1`,
      [p.agentId],
    );
  },
  // A retired agent cannot stay paused.
  AgentRetired: async (tx, e) => {
    const p = ev<'AgentRetired'>(e).payload;
    await exec(tx, 'UPDATE agents SET paused_at=NULL WHERE id=$1', [p.agentId]);
  },

  // An answered question taken back: open again, its cards wait again.
  QuestionReopened: async (tx, e) => {
    const p = ev<'QuestionReopened'>(e).payload;
    await exec(
      tx,
      `UPDATE desk_items SET status='open', answer=NULL, answer_option=NULL, answered_by=NULL, answered_at=NULL,
              answered_by_agent_id=NULL, ceo_action_id=NULL, updated_at=$2 WHERE id=$1`,
      [p.deskItemId, e.createdAt],
    );
    for (const cardId of p.blockedCardIds) {
      await exec(
        tx,
        `UPDATE cards SET status='blocked', blocked_since=COALESCE(blocked_since,$2), updated_at=$2
          WHERE id=$1 AND status='queued'`,
        [cardId, e.createdAt],
      );
      await exec(
        tx,
        'INSERT INTO card_blockers (card_id, desk_item_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [cardId, p.deskItemId],
      );
    }
  },
};
