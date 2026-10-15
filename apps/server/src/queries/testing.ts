import type { CardTesting, RelatedCard } from '@aom/shared';
import { effectiveCompletionAction } from '../commands/completion.ts';
import { mergeGate } from '../commands/finalize.ts';
import { suiteResultsOf } from '../commands/integration-tests.ts';
import { HIGH_RISK_MERGE_REASON, isHighRisk } from '../commands/review-risk.ts';
import type { Ctx } from '../context.ts';
import { iso, type Row, rows } from '../db/sql.ts';

const related = (r: Row): RelatedCard => ({
  id: r.id,
  ref: r.ref,
  title: r.title,
  cardType: r.card_type,
  stage: r.stage,
  status: r.status,
});

/** Testing and finalize facts of a card for the detail view (evidence panel, bug links, finalize panel). */
export async function cardTesting(ctx: Ctx, card: Row, canManage: boolean): Promise<CardTesting> {
  const runs = await rows(
    ctx.pool,
    'SELECT * FROM test_runs WHERE card_id=$1 ORDER BY created_at, event_seq',
    [card.id],
  );
  const parent = card.parent_card_id
    ? (await rows(ctx.pool, 'SELECT * FROM cards WHERE id=$1', [card.parent_card_id]))[0]
    : undefined;
  const children = await rows(ctx.pool, 'SELECT * FROM cards WHERE parent_card_id=$1 ORDER BY number', [
    card.id,
  ]);
  const open = children.find((c) => c.origin === 'test_failure' && !['done', 'cancelled'].includes(c.status));
  // `none` (an investigation finalized without a git step) is no completion action the Finalize panel can offer.
  const action = ((card.finalize_action === 'none' ? null : card.finalize_action) ??
    (await effectiveCompletionAction(ctx.pool, card)) ??
    null) as CardTesting['finalize']['action'];
  const env = (
    await rows(
      ctx.pool,
      `SELECT e.*, w.name AS workstation_name FROM run_environments e JOIN workstations w ON w.id = e.workstation_id
        WHERE e.card_id=$1 AND e.purpose='test' ORDER BY e.created_at DESC LIMIT 1`,
      [card.id],
    )
  )[0];
  const open_ = card.stage === 'finalize' && card.status === 'queued' && !card.claim_id;
  return {
    testRuns: runs.map((r) => ({
      id: r.id,
      cardId: r.card_id,
      shiftId: r.shift_id,
      kind: r.kind,
      platform: r.platform,
      result: r.result,
      evidence: r.evidence,
      createdAt: iso(r.created_at) as string,
    })),
    parent: parent ? related(parent) : null,
    children: children.map(related),
    waitingOn: card.status === 'waiting' && open ? related(open) : null,
    parkedOn: card.parked_request_id
      ? { requestId: card.parked_request_id, problem: card.park_problem ?? 'unknown' }
      : null,
    finalize: {
      available: canManage && open_,
      action,
      requiresApproval: action ? (await mergeGate(ctx.pool, card, action)) === 'approval' : false,
      approvalReason: action === 'merge' && isHighRisk(card) ? HIGH_RISK_MERGE_REASON : null,
      state: card.finalize_state ?? 'idle',
      deskItemId: card.finalize_desk_item_id ?? null,
      lastError: card.finalize_error ?? null,
    },
    suiteKind: card.origin === 'full_suite' || card.origin === 'regression' ? card.origin : null,
    suiteResults: await suiteResultsOf(ctx.pool, card.id),
    testEnvironment: env
      ? {
          envId: env.id,
          state: env.state,
          activity: env.activity ?? null,
          workstationName: env.workstation_name,
          // kept for inspection after a failure: it ends at `expires_at`
          keptUntil:
            env.verdict_at && env.expires_at && !['stopped', 'failed'].includes(env.state)
              ? (iso(env.expires_at) as string)
              : null,
          lastError: env.last_error ?? null,
          commit:
            ((env.sources ?? []) as Array<{ repoId: string; commit?: string | null }>).find(
              (s) => s.repoId === card.repo_id,
            )?.commit ?? null,
          urls: ((env.services_status ?? []) as Array<{ urls?: string[] }>).flatMap((s) => s.urls ?? []),
        }
      : null,
  };
}
