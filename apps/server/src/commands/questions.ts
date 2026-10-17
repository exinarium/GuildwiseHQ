import { randomUUID } from 'node:crypto';
import {
  type DeskOption,
  formatLedgerMatches,
  type LedgerMatch,
  optionId,
  type ShiftReport,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { dedupMatches } from '../queries/ledger.ts';
import { reportingOf } from '../reporter/settings.ts';
import { agentActor, cardMessage, projectScope } from './common.ts';
import {
  DUPLICATE_SIMILARITY,
  findOpenDuplicate,
  mergeEvents,
  nextRoute,
  questionSimilarity,
  routedMessage,
} from './escalation.ts';
import { questionLoopEvents } from './loop-breaker.ts';
import { convertWaitingQuestion, devopsTopicQuestion, repeatGuard } from './question-flow.ts';
import { releaseClaimEvents } from './shifts.ts';

type QuestionReport = Extract<ShiftReport, { kind: 'question' }>;

export interface QuestionResult {
  accepted: boolean;
  error?: string;
  message?: string;
  matches?: LedgerMatch[];
}

/** The card plus the open cards that depend on it: what a blocking question holds up. */
async function affectedCards(tx: Tx, card: Row): Promise<string[]> {
  const dependents = await rows<{ id: string }>(
    tx,
    `SELECT c.id FROM card_dependencies d JOIN cards c ON c.id = d.card_id
      WHERE d.depends_on_card_id = $1 AND c.status NOT IN ('done','cancelled')`,
    [card.id],
  );
  return [card.id, ...dependents.map((d) => d.id)];
}

/**
 * An agent raises a question on its card (`aom question`). Ledger duplicate check first (top 3 matches are stored on
 * the desk item and returned to the agent); then `QuestionRaised`. Blocking questions park the card in Blocked and
 * release the claim in the same append, so the builder can take its next card (docs/ARCHITECTURE.md section 15).
 * M7: the question starts in the escalation chain (a senior of the same role or the previous holder, then the BA)
 * and reaches the manager's desk only when nobody up the chain can answer (`commands/escalation.ts`).
 */
export async function raiseQuestion(
  ctx: Ctx,
  tx: Tx,
  shift: Row,
  card: Row,
  agent: Row,
  report: QuestionReport,
): Promise<QuestionResult> {
  // A waiting question that ran out of time becomes a blocking one (no new item).
  if (report.converts) return convertWaitingQuestion(ctx, tx, shift, card, agent);
  const matches = await dedupMatches(tx, card.org_id, card.project_id, report.text);
  // Every question gets the ledger duplicate check. A non-blocking one is refused on any match (--force overrides); a
  // blocking or waiting one only when an entry is practically the same question, so a stuck agent is not sent round.
  const nearDuplicate = matches.some((m) => questionSimilarity(report.text, m.title) >= DUPLICATE_SIMILARITY);
  if (matches.length > 0 && !report.force && (nearDuplicate || (!report.blocking && !report.wait))) {
    return {
      accepted: false,
      error: `The ledger already has similar entries (below). If they do not answer your question, run the command again with --force.\n${formatLedgerMatches(matches)}`,
      matches,
    };
  }
  if (report.recommend !== undefined && report.recommend >= report.options.length) {
    return {
      accepted: false,
      error: `--recommend ${report.recommend} does not match an --option (you gave ${report.options.length}; the first option is 0)`,
    };
  }
  const repeated = await repeatGuard(ctx, tx, card, agent, report);
  if (repeated) return repeated;
  const viaDevops = await devopsTopicQuestion(ctx, tx, shift, card, agent, report);
  if (viaDevops) return viaDevops;
  const options: DeskOption[] = report.options.map((label, i) => ({ id: optionId(i), label }));
  const deskItemId = randomUUID();
  const affected = report.blocking ? await affectedCards(tx, card) : [card.id];
  // Part B: with BA routing on, a non-blocking question starts at the BA, which answers it, merges it or passes it on.
  // A blocking one walks the whole chain (senior peer, then the BA from the ledger, then the manager) with a short
  // time limit at each step (`QUESTION_STALL_MS`), exactly as with routing off; only approvals and pinned items go
  // straight to the manager (owner decision, 2026-10-06).
  const viaBa = (await reportingOf(tx, card.org_id)).routeViaBa && !report.blocking;
  const route = await nextRoute(ctx, tx, {
    orgId: card.org_id,
    projectId: card.project_id,
    cardId: card.id,
    askerAgentId: agent.id,
    askerRole: agent.role_key,
    from: 'raise',
    tried: [],
    topic: report.topic ?? null,
    ...(viaBa ? { via: 'ba' as const } : {}),
  });
  const scope = projectScope(card.org_id, card.project_id);
  // The same question is already open (whatever step it would start at): attach to it instead of a second item.
  const duplicate = await findOpenDuplicate(tx, {
    orgId: card.org_id,
    projectId: card.project_id,
    text: report.text,
  });
  const raised: AppendInput = {
    streamId: streamId.desk(deskItemId),
    event: {
      type: 'QuestionRaised',
      payload: {
        deskItemId,
        cardId: card.id,
        projectId: card.project_id,
        shiftId: shift.id,
        askedBy: { kind: 'agent', agentId: agent.id, role: agent.role_key },
        doing: report.doing,
        question: report.text,
        options,
        ...(report.recommend !== undefined ? { recommendation: optionId(report.recommend) } : {}),
        blocking: report.blocking,
        routedTo: route.routedTo,
        ...(route.routedAgentId ? { routedAgentId: route.routedAgentId } : {}),
        chainLevel: route.level,
        ...(report.topic ? { topic: report.topic } : {}),
        dedupLedgerIds: matches.map((m) => m.id),
        affectedCardIds: affected,
        pinned: report.blocking,
      },
    },
    actor: agentActor(agent.id),
    scope,
  };
  const thread = cardMessage(
    card,
    { kind: 'agent', agentId: agent.id },
    'question',
    options.length ? `${report.text}\n\nOptions: ${options.map((o) => o.label).join(' / ')}` : report.text,
    { deskItemId },
  );

  const merged = duplicate
    ? mergeEvents(
        { id: deskItemId, org_id: card.org_id, project_id: card.project_id },
        undefined,
        duplicate,
        agent.id,
      )
    : [];

  // Question shifts count for the loop breaker too (whatever the wording): a card going round gets a back-off.
  const loop = await questionLoopEvents(ctx, tx, card);
  if (report.blocking) {
    await ctx.store.append(
      await releaseClaimEvents(
        tx,
        card,
        'question',
        route.routedTo === 'manager'
          ? 'Raised a question for the manager; the card is Blocked until it is answered.'
          : `Raised a question for ${route.agentName} (${route.agentRole}); the card is Blocked until it is answered.`,
        null,
        [raised, thread, ...merged, ...loop],
      ),
      { tx },
    );
  } else {
    await ctx.store.append([raised, thread, ...merged, ...loop], { tx });
  }
  const seen = matches.length
    ? `\nThe ledger has similar entries; the manager sees them next to your question:\n${formatLedgerMatches(matches)}`
    : '';
  if (duplicate)
    return {
      accepted: true,
      message: `Recorded. The same question is already open ("${duplicate.title}"), so yours was attached to it.${report.blocking ? ' The card is Blocked until it is answered. Finish now; do not make further changes.' : ' Carry on with your best assumption.'}${seen}`,
      matches,
    };
  return {
    accepted: true,
    message: routedMessage(route, report.blocking, seen),
    matches,
  };
}
