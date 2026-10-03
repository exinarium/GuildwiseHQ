import { countsAgainstBuilder, type EventOf, type EventType, type ReworkReason } from '@aom/shared';
import { exec, one } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

/** UTC calendar day of an event: the bucket of `agent_stats_daily`. */
const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

interface Delta {
  questions?: number;
  reworkRounds?: number;
  specUnclearRounds?: number;
  bugs?: number;
  criteriaMissed?: number;
  tokens?: number;
  shiftMs?: number;
  done?: boolean;
  submitted?: boolean;
  diffFiles?: number;
  testFiles?: number;
}

/** Adds to the (agent, card) row, creating it on the first touch. The card's current risk tier is kept on the row. */
async function touch(tx: Tx, e: StoredEvent, agentId: string, cardId: string, d: Delta = {}): Promise<void> {
  const agent = await one<{ role_key: string }>(tx, 'SELECT role_key FROM agents WHERE id=$1', [agentId]);
  const card = await one<{ org_id: string; project_id: string; risk_tier: string | null }>(
    tx,
    'SELECT org_id, project_id, risk_tier FROM cards WHERE id=$1',
    [cardId],
  );
  if (!agent || !card) return;
  await exec(
    tx,
    `INSERT INTO agent_card_stats (agent_id, card_id, org_id, project_id, role_key, risk_tier, first_at, last_at, done_at,
        submitted, questions, rework_rounds, spec_unclear_rounds, bugs, criteria_missed, tokens, shift_ms, diff_files, test_files)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (agent_id, card_id) DO UPDATE SET
       last_at = GREATEST(agent_card_stats.last_at, EXCLUDED.last_at),
       risk_tier = COALESCE(EXCLUDED.risk_tier, agent_card_stats.risk_tier),
       role_key = EXCLUDED.role_key,
       done_at = COALESCE(EXCLUDED.done_at, agent_card_stats.done_at),
       submitted = agent_card_stats.submitted OR EXCLUDED.submitted,
       questions = agent_card_stats.questions + EXCLUDED.questions,
       rework_rounds = agent_card_stats.rework_rounds + EXCLUDED.rework_rounds,
       spec_unclear_rounds = agent_card_stats.spec_unclear_rounds + EXCLUDED.spec_unclear_rounds,
       bugs = agent_card_stats.bugs + EXCLUDED.bugs,
       criteria_missed = agent_card_stats.criteria_missed + EXCLUDED.criteria_missed,
       tokens = agent_card_stats.tokens + EXCLUDED.tokens,
       shift_ms = agent_card_stats.shift_ms + EXCLUDED.shift_ms,
       diff_files = COALESCE(EXCLUDED.diff_files, agent_card_stats.diff_files),
       test_files = COALESCE(EXCLUDED.test_files, agent_card_stats.test_files)`,
    [
      agentId,
      cardId,
      card.org_id,
      card.project_id,
      agent.role_key,
      card.risk_tier,
      e.createdAt,
      d.done ? e.createdAt : null,
      d.submitted ?? false,
      d.questions ?? 0,
      d.reworkRounds ?? 0,
      d.specUnclearRounds ?? 0,
      d.bugs ?? 0,
      d.criteriaMissed ?? 0,
      d.tokens ?? 0,
      d.shiftMs ?? 0,
      d.diffFiles ?? null,
      d.testFiles ?? null,
    ],
  );
}

async function daily(
  tx: Tx,
  e: StoredEvent,
  agentId: string,
  d: { shifts?: number; shiftMs?: number; tokens?: number; cardsDone?: number },
): Promise<void> {
  await exec(
    tx,
    `INSERT INTO agent_stats_daily (agent_id, day, shifts, shift_ms, tokens, cards_done)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (agent_id, day) DO UPDATE SET shifts = agent_stats_daily.shifts + EXCLUDED.shifts,
       shift_ms = agent_stats_daily.shift_ms + EXCLUDED.shift_ms, tokens = agent_stats_daily.tokens + EXCLUDED.tokens,
       cards_done = agent_stats_daily.cards_done + EXCLUDED.cards_done`,
    [agentId, dayOf(e.createdAt), d.shifts ?? 0, d.shiftMs ?? 0, d.tokens ?? 0, d.cardsDone ?? 0],
  );
}

/** The agent that wrote the latest handoff of `stage` on the card (the builder of a card under review, the BA of a spec). */
async function lastHandoffAgent(tx: Tx, cardId: string, stage: string): Promise<string | null> {
  const r = await one<{ agent_id: string | null }>(
    tx,
    `SELECT agent_id FROM card_handoffs WHERE card_id=$1 AND stage=$2 AND agent_id IS NOT NULL
      ORDER BY event_seq DESC LIMIT 1`,
    [cardId, stage],
  );
  return r?.agent_id ?? null;
}

async function logReview(
  tx: Tx,
  e: StoredEvent,
  p: {
    cardId: string;
    reviewerAgentId: string;
    verdict: 'approved' | 'changes';
    score: number;
    reasons: string[];
    criteriaMissed: number;
  },
  builder: string | null,
): Promise<void> {
  const card = await one<{ org_id: string; project_id: string; risk_tier: string | null }>(
    tx,
    'SELECT org_id, project_id, risk_tier FROM cards WHERE id=$1',
    [p.cardId],
  );
  if (!card) return;
  await exec(
    tx,
    `INSERT INTO agent_review_log (org_id, project_id, card_id, builder_agent_id, reviewer_agent_id, spec_author_agent_id,
        verdict, score, reasons, criteria_missed, risk_tier, at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      card.org_id,
      card.project_id,
      p.cardId,
      builder,
      p.reviewerAgentId,
      await lastHandoffAgent(tx, p.cardId, 'spec'),
      p.verdict,
      p.score,
      p.reasons,
      p.criteriaMissed,
      card.risk_tier,
      e.createdAt,
    ],
  );
}

/**
 * Projectors of the HR track record. They run after the card projectors (registry order), so the card row and the
 * handoff of the same append are already in place: failures are attributed to the stage that caused them.
 */
export const trackRecordProjectors: Record<string, Projector> = {
  CardClaimed: async (tx, e) => {
    const p = ev<'CardClaimed'>(e).payload;
    await touch(tx, e, p.agentId, p.cardId);
  },

  HandoffWritten: async (tx, e) => {
    const p = ev<'HandoffWritten'>(e).payload;
    await touch(tx, e, p.agentId, p.cardId, { done: true });
    await daily(tx, e, p.agentId, { cardsDone: 1 });
  },

  ShiftEnded: async (tx, e) => {
    const p = ev<'ShiftEnded'>(e).payload;
    const tokens = p.usage.inputTokens + p.usage.outputTokens;
    await daily(tx, e, p.agentId, { shifts: 1, shiftMs: p.durationMs, tokens });
    if (p.cardId) await touch(tx, e, p.agentId, p.cardId, { tokens, shiftMs: p.durationMs });
  },

  QuestionRaised: async (tx, e) => {
    const p = ev<'QuestionRaised'>(e).payload;
    if (p.askedBy.kind === 'agent' && p.askedBy.agentId && p.cardId)
      await touch(tx, e, p.askedBy.agentId, p.cardId, { questions: 1 });
  },

  ReviewRequested: async (tx, e) => {
    const p = ev<'ReviewRequested'>(e).payload;
    const builder = await lastHandoffAgent(tx, p.cardId, 'build');
    if (builder)
      await touch(tx, e, builder, p.cardId, {
        submitted: true,
        diffFiles: p.diffStats.files,
        ...(p.diffStats.testFiles !== undefined ? { testFiles: p.diffStats.testFiles } : {}),
      });
  },

  ChangesRequested: async (tx, e) => {
    const p = ev<'ChangesRequested'>(e).payload;
    const builder = await lastHandoffAgent(tx, p.cardId, 'build');
    const reasons = p.reasons as ReworkReason[];
    // A bounce blamed only on an unclear spec is not the builder's: it shows on the spec's author instead.
    const specOnly = reasons.length > 0 && reasons.every((r) => !countsAgainstBuilder(r));
    if (builder)
      await touch(
        tx,
        e,
        builder,
        p.cardId,
        specOnly ? { specUnclearRounds: 1 } : { reworkRounds: 1, criteriaMissed: p.criteriaMissed.length },
      );
    await logReview(
      tx,
      e,
      {
        cardId: p.cardId,
        reviewerAgentId: p.reviewerAgentId,
        verdict: 'changes',
        score: p.score,
        reasons,
        criteriaMissed: p.criteriaMissed.length,
      },
      builder,
    );
  },

  ReviewApproved: async (tx, e) => {
    const p = ev<'ReviewApproved'>(e).payload;
    const builder = await lastHandoffAgent(tx, p.cardId, 'build');
    await logReview(
      tx,
      e,
      {
        cardId: p.cardId,
        reviewerAgentId: p.reviewerAgentId,
        verdict: 'approved',
        score: p.score,
        reasons: [],
        criteriaMissed: 0,
      },
      builder,
    );
  },

  TestFailed: async (tx, e) => {
    const p = ev<'TestFailed'>(e).payload;
    const builder = await lastHandoffAgent(tx, p.cardId, 'build');
    if (builder) await touch(tx, e, builder, p.cardId, { bugs: 1 });
  },

  /** A later regression of the full suite is traced to the builder of the finalized card the suite ran after. */
  FullSuiteFailed: async (tx, e) => {
    const p = ev<'FullSuiteFailed'>(e).payload;
    const suite = await one<{ parent_card_id: string | null; origin: string }>(
      tx,
      'SELECT parent_card_id, origin FROM cards WHERE id=$1',
      [p.suiteCardId],
    );
    if (!suite?.parent_card_id || suite.origin !== 'full_suite') return;
    const builder = await lastHandoffAgent(tx, suite.parent_card_id, 'build');
    if (builder) await touch(tx, e, builder, suite.parent_card_id, { bugs: 1 });
  },

  RecommendationApplied: async (tx, e) => {
    const p = ev<'RecommendationApplied'>(e).payload;
    await exec(
      tx,
      `INSERT INTO hr_applied (org_id, recommendation_id, applied_at, applied_by) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, recommendation_id) DO UPDATE SET applied_at = EXCLUDED.applied_at, applied_by = EXCLUDED.applied_by`,
      [p.orgId, p.recommendationId, e.createdAt, p.appliedBy],
    );
  },
};
