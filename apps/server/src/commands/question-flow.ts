import { randomUUID } from 'node:crypto';
import {
  AFFINITY_HOURS,
  DESK_SUBKIND,
  DEVOPS_TOPICS,
  getStage,
  QUESTION_WAIT,
  type QuestionTopic,
  type ShiftReport,
  streamId,
} from '@aom/shared';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentActor, cardMessage, projectScope, SYSTEM_ACTOR } from './common.ts';
import { createDevOpsRequestIn, devopsAgentOn } from './devops.ts';
import { DUPLICATE_SIMILARITY, questionSimilarity } from './escalation.ts';
import { rejectionBackoffEvents } from './loop-breaker.ts';
import { releaseClaimEvents } from './shifts.ts';
import { environmentNotReadyEvents } from './testing.ts';

type QuestionReport = Extract<ShiftReport, { kind: 'question' }>;

/** Same shape as `QuestionResult` of `questions.ts` (kept here so the two files do not import each other's types). */
interface Result {
  accepted: boolean;
  error?: string;
  message?: string;
}

/** The earliest moment a waiting question may be converted: never earlier than this after it was raised. */
const WAIT_SAFETY_MS = 3 * 60_000;

/** `CardAffinitySet` for `agentId`: only that agent may claim the card for the next hours. */
export function affinityEvent(
  ctx: Ctx,
  card: Row,
  agentId: string,
  reason: 'question' | 'review',
  sessionId?: string | null,
  deskItemId?: string,
): AppendInput {
  return {
    streamId: streamId.card(card.id),
    event: {
      type: 'CardAffinitySet',
      payload: {
        cardId: card.id,
        agentId,
        ...(sessionId ? { sessionId } : {}),
        until: new Date(ctx.clock.now().getTime() + AFFINITY_HOURS * 3600_000).toISOString(),
        reason,
        ...(deskItemId ? { deskItemId } : {}),
      },
    },
    actor: SYSTEM_ACTOR,
    scope: projectScope(card.org_id, card.project_id),
  };
}

/**
 * The repeat guard (design 6.2): a second similar question on the same card and stage with no state change in between
 * (no handoff since the first one) does not reach anybody. The card is parked with back-off and exactly one desk item
 * says so. Keyed on card, stage and the question text (`questionSimilarity`), for every route and every kind of question.
 */
export async function repeatGuard(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  agent: Row,
  report: QuestionReport,
): Promise<Result | undefined> {
  const prior = await rows(
    tx,
    `SELECT d.id, d.title, d.created_at FROM desk_items d
      WHERE d.card_id=$1 AND d.kind='question' AND d.subkind IS DISTINCT FROM $3 AND d.stage IS NOT DISTINCT FROM $2
        AND d.status = 'open'
        AND NOT EXISTS (SELECT 1 FROM card_handoffs h WHERE h.card_id = d.card_id AND h.created_at > d.created_at)
      ORDER BY d.created_at DESC LIMIT 30`,
    [card.id, card.stage, DESK_SUBKIND.stopLoss],
  );
  const same = prior.find((p) => questionSimilarity(report.text, p.title) >= DUPLICATE_SIMILARITY);
  if (!same) return serialRepeat(ctx, tx, card, agent, report);

  const alert = await one(tx, `SELECT 1 FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`, [
    card.id,
    DESK_SUBKIND.repeatQuestion,
  ]);
  const text = String(report.text).replace(/\s+/g, ' ').trim();
  const events: AppendInput[] = [
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `The same question was asked again on ${card.ref} in this stage with nothing changed since ("${text.slice(0, 200)}"). The card is parked with a back-off and the owner was told.`,
      { deskItemId: same.id },
    ),
    ...rejectionBackoffEvents(ctx, card),
  ];
  if (!alert) {
    const deskItemId = randomUUID();
    events.push({
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'escalation',
          subkind: DESK_SUBKIND.repeatQuestion,
          title: `${card.ref} asks the same question again: "${text.slice(0, 120)}"`,
          body: `${agent.name} asked "${text}" a second time in the ${card.stage} stage, and nothing on the card changed since the first time (${same.id}). Answering it again would not help, so the card is parked with a back-off instead of going round again.\n\nSay what is missing (a decision, a dependency, an environment) on the card or in an answer, then resolve this item and the card returns to the queue.`,
          options: [],
          blocking: true,
          pinned: true,
          cardId: card.id,
          projectId: card.project_id,
          affectedCardIds: [card.id],
          askedBy: { kind: 'system' },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    });
  }
  await ctx.store.append(await releaseClaimEvents(tx, card, 'question', null, null, events), { tx });
  return {
    accepted: true,
    message:
      'This is the same question as an earlier one on this card and nothing has changed since: it was not sent again. The card is parked and the owner was told. Finish now; do not make further changes.',
  };
}

/** The serial repeat guard: a question answered on the card and asked again within `windowMinutes`, nothing changed since. */
export const SERIAL_REPEAT = { windowMinutes: 30, parkAt: 3 } as const;

/**
 * A question that matches one already *answered* on the same card and stage within `SERIAL_REPEAT.windowMinutes`, with
 * no handoff since (so no stage change either: items are per stage), is a serial repeat. It does not become a fresh item
 * that gets answered the same way again: the earlier item's `repeat_count` goes up and the agent gets the earlier answer
 * back. The `SERIAL_REPEAT.parkAt`-th time the same question comes, the card is parked with one `repeat_loop`
 * escalation quoting the question and the earlier answers. Resolving that escalation ends the episode: items from before
 * it no longer count (cut-off below) and the back-off is cleared (projections/desk.ts `unblock`).
 */
async function serialRepeat(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  agent: Row,
  report: QuestionReport,
): Promise<Result | undefined> {
  const since = new Date(ctx.clock.now().getTime() - SERIAL_REPEAT.windowMinutes * 60_000);
  const prior = await rows(
    tx,
    `SELECT d.id, d.title, d.answer, d.repeat_count, d.created_at FROM desk_items d
      WHERE d.card_id=$1 AND d.kind='question' AND d.status='answered' AND d.subkind IS DISTINCT FROM $3
        AND d.stage IS NOT DISTINCT FROM $2
        AND COALESCE(d.answered_at, d.created_at) > $4
        AND d.created_at > COALESCE((SELECT max(x.created_at) FROM desk_items x WHERE x.card_id=d.card_id AND x.subkind=$5),
                                    '-infinity'::timestamptz)
        AND NOT EXISTS (SELECT 1 FROM card_handoffs h WHERE h.card_id = d.card_id AND h.created_at > d.created_at)
      ORDER BY d.created_at DESC LIMIT 30`,
    [card.id, card.stage, DESK_SUBKIND.stopLoss, since, DESK_SUBKIND.repeatLoop],
  );
  const same = prior.filter((p) => questionSimilarity(report.text, p.title) >= DUPLICATE_SIMILARITY);
  const newest = same[0];
  if (!newest) return undefined;
  const count = same.reduce((n, p) => n + Number(p.repeat_count ?? 1), 0) + 1;
  const scope = projectScope(card.org_id, card.project_id);
  const repeated: AppendInput = {
    streamId: streamId.desk(newest.id),
    event: {
      type: 'DeskItemRepeated',
      payload: { deskItemId: newest.id, count: Number(newest.repeat_count ?? 1) + 1 },
    },
    actor: agentActor(agent.id),
    scope,
  };
  const text = String(report.text).replace(/\s+/g, ' ').trim();
  const answers = same.map((p) => String(p.answer ?? '').trim()).filter(Boolean);
  if (count < SERIAL_REPEAT.parkAt) {
    await ctx.store.append([repeated], { tx });
    const last = answers[0];
    return {
      accepted: true,
      message: `This question was already answered on this card and nothing has changed since, so it was not asked again.${last ? ` The answer was: "${last.slice(0, 1000)}".` : ''} Act on that answer and carry on; do not ask the same thing again.`,
    };
  }

  const alert = await one(tx, `SELECT 1 FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`, [
    card.id,
    DESK_SUBKIND.repeatLoop,
  ]);
  const events: AppendInput[] = [
    repeated,
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `The same question came ${count} times on ${card.ref} in this stage with nothing changed after each answer ("${text.slice(0, 200)}"). The card is parked and escalated.`,
      { deskItemId: newest.id },
    ),
    ...rejectionBackoffEvents(ctx, card),
  ];
  if (!alert) {
    const deskItemId = randomUUID();
    const quoted = answers.length
      ? answers.map((a, i) => `${i + 1}. ${a.slice(0, 500)}`).join('\n')
      : '(no answer text recorded)';
    events.push({
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'DeskItemCreated',
        payload: {
          deskItemId,
          kind: 'escalation',
          subkind: DESK_SUBKIND.repeatLoop,
          title: `${card.ref} keeps asking the same question (${count} times): "${text.slice(0, 120)}"`,
          body: `${agent.name} asked "${text}" ${count} times in the ${card.stage} stage. Each time it was answered and nothing on the card changed, so the answers are not what the agent needs. The card is parked instead of going round again.\n\nPrevious answers:\n${quoted}\n\nSay what is missing (a decision, a dependency, an environment), move the card, or tell the agent how to proceed, then resolve this item: the card returns to the queue and the repeat count starts again.`,
          options: [],
          blocking: true,
          pinned: true,
          cardId: card.id,
          projectId: card.project_id,
          affectedCardIds: [card.id],
          data: { question: text, answers, count, previousItemIds: same.map((p) => p.id) },
          askedBy: { kind: 'system' },
          subjectKey: `repeat_loop:${card.id}`,
        },
      },
      actor: SYSTEM_ACTOR,
      scope,
    });
  }
  await ctx.store.append(await releaseClaimEvents(tx, card, 'question', null, null, events), { tx });
  return {
    accepted: true,
    message:
      'This question was already answered on this card and keeps coming back with nothing changed. It was not sent again: the card is parked and escalated. Finish now; do not make further changes.',
  };
}

/**
 * `--topic environment|sandbox|tooling`: a DevOps request instead of a question shift. A blocking question parks the
 * card on the request (the same park as a tester without an environment, `environmentNotReadyEvents`); a waiting one
 * only files it. An open request of the card is attached to, not asked twice. Undefined: nobody to ask, the normal chain.
 */
export async function devopsTopicQuestion(
  ctx: Ctx,
  tx: Tx,
  shift: Row,
  card: Row,
  agent: Row,
  report: QuestionReport,
): Promise<Result | undefined> {
  const topic = report.topic as QuestionTopic | undefined;
  if (!topic || !DEVOPS_TOPICS.includes(topic)) return undefined;
  const ws = await one<{ id: string; user_id: string }>(
    tx,
    `SELECT id, user_id FROM workstations WHERE id=$1 AND status='active'`,
    [shift.workstation_id],
  );
  if (!ws || !(await devopsAgentOn(tx, ws.id, card.org_id))) return undefined;
  const detail = report.text.replace(/\s+/g, ' ').trim().slice(0, 300);
  const problem = topic === 'environment' ? 'app_not_deployed' : (topic as 'sandbox' | 'tooling');
  const summary = `${card.ref} (${agent.name}, ${shift.stage ?? card.stage}) asks about ${topic}: ${detail}${report.doing ? `\nWhat it was doing: ${report.doing}` : ''}`;
  const open = await one<{ id: string }>(
    tx,
    `SELECT id FROM devops_requests WHERE card_id=$1 AND status IN ('queued','running','needs_approval')
      ORDER BY created_at DESC LIMIT 1`,
    [card.id],
  );
  const requestedBy = { kind: 'agent' as const, id: agent.id as string, name: agent.name as string };

  if (!report.blocking) {
    if (!open)
      await createDevOpsRequestIn(ctx, tx, {
        workstationId: ws.id,
        summary,
        requestedBy,
        cardId: card.id,
        orgId: card.org_id,
      });
    await ctx.store.append(
      [
        cardMessage(
          card,
          { kind: 'agent', agentId: agent.id },
          'question',
          `${detail}\n\n(asked of DevOps: topic ${topic}${open ? ', attached to the open request' : ''})`,
        ),
      ],
      { tx },
    );
    return {
      accepted: true,
      message: `Recorded. The DevOps engineer was ${open ? 'already working a request for this card; yours was attached to it' : 'asked'}. Carry on with your best assumption.`,
    };
  }

  let events: AppendInput[];
  if (open) {
    events = [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'TestEnvironmentParked',
          payload: { cardId: card.id, requestId: open.id, problem, detail },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(card.org_id, card.project_id),
      },
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `${agent.name} asked about ${topic}. The DevOps engineer is already working a request for this card; ${card.ref} is parked until it completes.`,
        { requestId: open.id, problem },
      ),
    ];
  } else {
    events = await environmentNotReadyEvents(
      ctx,
      tx,
      { id: ws.id, userId: ws.user_id },
      card,
      { problem, detail },
      { summary, requestedBy },
    );
  }
  await ctx.store.append(
    await releaseClaimEvents(tx, card, 'question', null, null, [
      cardMessage(
        card,
        { kind: 'agent', agentId: agent.id },
        'question',
        `${detail}\n\n(topic ${topic}: sent to the DevOps engineer)`,
      ),
      ...events,
    ]),
    { tx },
  );
  return {
    accepted: true,
    message: `Recorded. The DevOps engineer was asked about ${topic} and ${card.ref} is parked until the request completes. Finish now; do not make further changes.`,
  };
}

/**
 * A waiting question (`aom question --wait`) ran out of time, or nobody can answer it in time: it becomes a blocking
 * question, the card is parked on it, the claim is released and the card keeps affinity to the asker, so the answer
 * resumes the same session first (design 6.2).
 */
export async function convertWaitingQuestion(
  ctx: Ctx,
  tx: Tx,
  shift: Row,
  card: Row,
  agent: Row,
  why: { reason?: 'timeout' | 'owner_only'; waitedMinutes?: number } = {},
): Promise<Result> {
  const ownerOnly = why.reason === 'owner_only';
  const item = await one(
    tx,
    `SELECT * FROM desk_items WHERE shift_id=$1 AND kind='question' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [shift.id],
  );
  let target = item;
  if (item?.status === 'superseded' && item.merged_into)
    target = (await one(tx, 'SELECT * FROM desk_items WHERE id=$1 FOR UPDATE', [item.merged_into])) ?? item;
  if (target && target.status !== 'open')
    return {
      accepted: false,
      error: `your question was ${target.status} just now${target.answer ? `: ${target.answer}` : ''}. Carry on; no need to wait any longer.`,
    };
  const session = (shift.runtime_session_id as string | null) ?? undefined;
  if (target) {
    await ctx.store.append(
      await releaseClaimEvents(
        tx,
        card,
        'question',
        ownerOnly
          ? `${agent.name} asked a question only the owner can answer; ${card.ref} is Blocked on it until it is answered, then ${agent.name} resumes it.`
          : `${agent.name} waited for an answer and none came in time; ${card.ref} is Blocked on the question until it is answered, then ${agent.name} resumes it.`,
        null,
        [
          {
            streamId: streamId.desk(target.id),
            event: { type: 'QuestionMadeBlocking', payload: { deskItemId: target.id, cardId: card.id } },
            actor: agentActor(agent.id),
            scope: projectScope(card.org_id, card.project_id),
          },
          affinityEvent(ctx, card, agent.id, 'question', session, target.id),
        ],
      ),
      { tx },
    );
    return {
      accepted: true,
      message: ownerOnly
        ? 'Recorded. Only the owner can answer this; the card waits on the desk and your session resumes when they answer. Finish now; do not make further changes.'
        : `Recorded. No answer within ${why.waitedMinutes ?? QUESTION_WAIT.defaultMinutes} minutes, so the card is Blocked on your question and you keep it: the answer resumes this work. Finish now; do not make further changes.`,
    };
  }
  // A waiting DevOps request of this shift: park the card on it.
  const req = await one<{ id: string }>(
    tx,
    `SELECT id FROM devops_requests WHERE card_id=$1 AND requested_by_id=$2 AND created_at >= $3
        AND status IN ('queued','running','needs_approval') ORDER BY created_at DESC LIMIT 1`,
    [card.id, agent.id, shift.started_at],
  );
  if (!req) return { accepted: false, error: 'there is no waiting question of this shift to convert' };
  await ctx.store.append(
    await releaseClaimEvents(
      tx,
      card,
      'question',
      `${agent.name} waited for the DevOps engineer and it did not finish in time; ${card.ref} is parked until the request completes.`,
      null,
      [
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'TestEnvironmentParked',
            payload: { cardId: card.id, requestId: req.id, problem: 'tooling', detail: 'waiting question' },
          },
          actor: SYSTEM_ACTOR,
          scope: projectScope(card.org_id, card.project_id),
        },
        affinityEvent(ctx, card, agent.id, 'question', session),
      ],
    ),
    { tx },
  );
  return {
    accepted: true,
    message:
      'Recorded. The DevOps engineer did not finish in time, so the card is parked on its request and you keep it. Finish now; do not make further changes.',
  };
}

export interface QuestionStatus {
  state: 'open' | 'answered' | 'unattended' | 'parked' | 'none';
  /** The asker should stop waiting after this many milliseconds (the shift's own limit, less a margin). */
  remainingMs: number;
  text?: string;
  answer?: string;
  answerOption?: string;
  keepBlockedUntil?: string;
  routedTo?: string;
}

/**
 * `question.status`: has the question this shift raised been answered? An open question routed to nobody but the
 * manager is `unattended`: the asker should convert it at once instead of waiting for a person.
 */
export async function questionStatus(ctx: Ctx, shift: Row): Promise<QuestionStatus> {
  const card = shift.card_id
    ? await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1', [shift.card_id])
    : undefined;
  let remainingMs = 10 * 60_000;
  if (card) {
    const wf = await loadWorkflowById(ctx.pool, card.workflow_version_id);
    const max = (wf ? getStage(wf.definition, shift.stage ?? card.stage)?.maxShiftMinutes : undefined) ?? 60;
    remainingMs = Math.max(
      0,
      max * 60_000 - (ctx.clock.now().getTime() - new Date(shift.started_at).getTime()) - WAIT_SAFETY_MS,
    );
  }
  const base = { remainingMs };
  const first = await one(
    ctx.pool,
    `SELECT * FROM desk_items WHERE shift_id=$1 AND kind='question' ORDER BY created_at DESC LIMIT 1`,
    [shift.id],
  );
  if (!first) {
    const req = card
      ? await one(
          ctx.pool,
          `SELECT status, result_summary FROM devops_requests WHERE card_id=$1 AND requested_by_id=$2 AND created_at >= $3
            ORDER BY created_at DESC LIMIT 1`,
          [card.id, shift.agent_id, shift.started_at],
        )
      : undefined;
    if (!req) return { state: 'none', ...base };
    if (req.status === 'done' || req.status === 'failed')
      return {
        state: 'answered',
        answer:
          req.status === 'done'
            ? `The DevOps engineer finished: ${req.result_summary ?? 'no summary'}`
            : `The DevOps engineer could not finish: ${req.result_summary ?? 'it failed'}`,
        ...base,
      };
    return { state: 'open', ...base };
  }
  const it =
    first.status === 'superseded' && first.merged_into
      ? ((await one(ctx.pool, 'SELECT * FROM desk_items WHERE id=$1', [first.merged_into])) ?? first)
      : first;
  if (it.status === 'answered' || it.status === 'dismissed' || it.status === 'superseded') {
    return {
      state: 'answered',
      answer: it.answer ?? (it.status === 'answered' ? '' : `The question was ${it.status}.`),
      ...(it.answer_option ? { answerOption: it.answer_option } : {}),
      ...(it.keep_blocked_until ? { keepBlockedUntil: it.keep_blocked_until } : {}),
      ...base,
    };
  }
  if (card && card.claim_shift_id !== shift.id) return { state: 'parked', ...base };
  return {
    state: it.routed_to === 'manager' ? 'unattended' : 'open',
    text: it.title,
    routedTo: it.routed_to,
    ...base,
  };
}
