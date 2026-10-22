import { randomUUID } from 'node:crypto';
import {
  bugDescription,
  DESK_SUBKIND,
  emptyFields,
  streamId,
  TESTER_LOOP_OPTIONS,
  TESTER_REWORK_CAP,
  TESTER_TOTAL_REWORK_CAP,
  type TestEvidence,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cancelCardIn } from './cards.ts';
import { agentActor, cardMessage, projectScope, SYSTEM_ACTOR } from './common.ts';
import { spawnCardEvent } from './spawn.ts';
import { stopLossRoute } from './stop-loss.ts';

/**
 * The tester loop (production, GWP-11): a card whose remaining work is in the E2E spec went round tester -> bug card for a
 * builder (who may not change E2E paths) -> cancelled -> tester -> a new bug card, every 20 seconds. These are the pieces
 * that stop it: the bug card of a failure, the rework (the card goes back to the tester), the cap on reworks without
 * progress, and the `tester_loop` question the CEO answers (the owner after three arbitrations).
 */

/** Bug child of a failed feature test: shares the parent's worktree and branch. Events: the child, `TestFailed`, a note. */
export async function bugCardEvents(
  tx: Tx,
  card: Row,
  agentId: string,
  note: string,
  evidence: TestEvidence,
  title: string,
): Promise<AppendInput[]> {
  const desc = bugDescription({ note, evidence, parentRef: card.ref });
  const child = await spawnCardEvent(tx, {
    from: card,
    title,
    cardType: 'bug',
    origin: 'test_failure',
    workflowKey: 'code-bugfix',
    stage: 'build',
    status: 'queued',
    fields: {
      ...emptyFields('code'),
      context: desc,
      requirements: `Fix the bug described in the context.`,
      constraints: `Fix on the branch of ${card.ref}; add a regression unit test.`,
    },
    parentCardId: card.id,
    worktreeCardId: card.worktree_card_id ?? card.id,
    completionAction: card.completion_action,
    riskTier: null,
  });
  return [
    child.event,
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'TestFailed',
        payload: {
          cardId: card.id,
          testerAgentId: agentId,
          bugCardId: child.cardId,
          evidence,
          summary: title,
        },
      },
      actor: agentActor(agentId),
      scope: projectScope(card.org_id, card.project_id),
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `Test failed: bug card ${child.ref} ("${title}") was created for the original builder. ${card.ref} waits in Test until the fix passed review.`,
      { bugCardId: child.cardId },
    ),
  ];
}

/** The newest bug card a test failure of `parentId` created, whatever its status. */
export async function latestFailureChild(tx: Tx, parentId: string): Promise<Row | undefined> {
  return one(
    tx,
    `SELECT id, ref, status FROM cards WHERE parent_card_id=$1 AND card_type='bug' AND origin='test_failure'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [parentId],
  );
}

/**
 * Reworks of this card in a row whose tester shift started at the same commit as the reporting shift (`head`: the shift's
 * `start_sha`, so a commit the tester made shows when its next shift starts): since the last test result, and since the last
 * `tester_loop` question of the card (its answer starts the count again). `total` counts every tester rework in that window,
 * whatever commit it started at: a tester that commits every shift is not progress either.
 */
export async function reworkCounts(
  tx: Tx,
  card: Row,
  head: string | null,
): Promise<{ consecutive: number; total: number }> {
  const stream = streamId.card(card.id);
  const last = await one<{ seq: string | null }>(
    tx,
    `SELECT max(seq)::text AS seq FROM events WHERE stream_id=$1 AND type IN ('TestFailed','TestPassed')`,
    [stream],
  );
  const asked = await one<{ at: Date | null }>(
    tx,
    `SELECT max(created_at) AS at FROM desk_items WHERE card_id=$1 AND subkind=$2`,
    [card.id, DESK_SUBKIND.testerLoop],
  );
  const evs = await tx.query(
    `SELECT payload->>'headSha' AS sha, payload->>'instruction' AS instruction FROM events
      WHERE stream_id=$1 AND type='TestReworkRequested' AND seq > $2::bigint AND created_at > $3::timestamptz
      ORDER BY seq DESC`,
    [stream, last?.seq ?? '0', asked?.at ?? '-infinity'],
  );
  const list = evs.rows as Array<{ sha: string | null; instruction: string | null }>;
  let consecutive = 0;
  for (const r of list) {
    if ((r.sha ?? null) !== head) break;
    consecutive++;
  }
  // Reworks the CEO or an answer ordered (they carry an instruction) are the reset, not tester reworks.
  return { consecutive, total: list.filter((r) => r.instruction == null).length };
}

/** The `tester_loop` question: one blocking item through the stop-loss route (the CEO, three times, then the owner). */
export async function testerLoopQuestionEvents(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  q: {
    reason: 'cancelled_bug' | 'rework_cap';
    /** Which cap a `rework_cap` question hit. */
    cap?: 'consecutive' | 'total';
    /** The text after the colon of the question. */
    summary: string;
    testerAgentId: string;
    evidence: TestEvidence;
    note: string;
    title: string;
    cancelledRef?: string;
    /** Shown in the question when the evidence only names E2E paths. */
    e2eHint?: string;
  },
): Promise<AppendInput[]> {
  const open = await one(tx, `SELECT 1 FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`, [
    card.id,
    DESK_SUBKIND.testerLoop,
  ]);
  if (open) return [];
  const { route, ceoHold, note } = await stopLossRoute(ctx, tx, card, DESK_SUBKIND.testerLoop);
  const deskItemId = randomUUID();
  const stale =
    q.reason === 'rework_cap' && q.cancelledRef ? ' (a bug card was cancelled earlier on this card)' : '';
  const hint = q.e2eHint ? ` Note: ${q.e2eHint}.` : '';
  const text =
    q.reason === 'cancelled_bug'
      ? `The tester reports the failure again after bug card ${q.cancelledRef} was cancelled: ${q.summary}${hint}`
      : q.cap === 'total'
        ? `The tester asked for E2E rework ${TESTER_TOTAL_REWORK_CAP} times since the last test result or answer${stale}: ${q.summary}`
        : `The tester asked for E2E rework ${TESTER_REWORK_CAP} times in a row with no new commit on the branch${stale}: ${q.summary}`;
  return [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'QuestionRaised',
        payload: {
          deskItemId,
          cardId: card.id,
          projectId: card.project_id,
          askedBy: { kind: 'system' },
          doing: `${card.ref} (${card.title}) failed its test again`,
          question: text,
          options: [
            {
              id: TESTER_LOOP_OPTIONS.builder,
              label: 'Send to a builder (new bug card)',
              description:
                'The product is wrong: a bug card for the original builder is created from the failure.',
            },
            {
              id: TESTER_LOOP_OPTIONS.tester,
              label: 'Back to the tester (E2E spec work)',
              description:
                'The work is in the E2E spec, its fixtures or the capture run: the tester makes the edit and runs it itself. Raise the card model first if it keeps failing.',
            },
            {
              id: TESTER_LOOP_OPTIONS.cancel,
              label: 'Cancel/accept: cancel the card',
              description: 'Give up on the card.',
            },
          ],
          blocking: true,
          routedTo: route.routedTo,
          ...(route.routedAgentId ? { routedAgentId: route.routedAgentId } : {}),
          chainLevel: route.level,
          ...(ceoHold ? { triage: ceoHold } : {}),
          topic: 'code',
          subkind: DESK_SUBKIND.testerLoop,
          dedupLedgerIds: [],
          affectedCardIds: [card.id],
          pinned: true,
          data: {
            reason: q.reason,
            ...(q.cap ? { cap: q.cap } : {}),
            testerAgentId: q.testerAgentId,
            title: q.title,
            note: q.note,
            evidence: q.evidence,
            ...(q.cancelledRef ? { cancelledRef: q.cancelledRef } : {}),
          },
        },
      },
      actor: SYSTEM_ACTOR,
      scope: projectScope(card.org_id, card.project_id),
    },
    cardMessage(
      card,
      { kind: 'system' },
      'system',
      `${card.ref} failed its test again but no bug card was created: ${
        q.reason === 'cancelled_bug'
          ? `its earlier bug card ${q.cancelledRef} was cancelled`
          : q.cap === 'total'
            ? `the tester asked for rework ${TESTER_TOTAL_REWORK_CAP} times without a test result`
            : `the tester asked for rework ${TESTER_REWORK_CAP} times with no new commit`
      }. The card waits in Test on one question. ${note}\n\n${q.summary}`,
      { deskItemId, failureScope: 'tester_loop' },
    ),
  ];
}

/**
 * The card goes back to the tester (`TestReworkRequested`) unless it already went back `TESTER_REWORK_CAP` times with the
 * branch unchanged, or `TESTER_TOTAL_REWORK_CAP` times in all without a test result: then the CEO is asked (`tester_loop`) instead.
 */
export async function reworkOrEscalateEvents(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  agentId: string,
  evidence: TestEvidence,
  title: string,
  note: string,
  /** The thread note: why this is a rework. */
  why: string,
  /** The commit the reporting shift started at: the progress signal of the rework cap. */
  head: string | null,
): Promise<AppendInput[]> {
  const counts = await reworkCounts(tx, card, head);
  if (counts.consecutive >= TESTER_REWORK_CAP || counts.total >= TESTER_TOTAL_REWORK_CAP) {
    const previous = await latestFailureChild(tx, card.id);
    return testerLoopQuestionEvents(ctx, tx, card, {
      reason: 'rework_cap',
      cap: counts.consecutive >= TESTER_REWORK_CAP ? 'consecutive' : 'total',
      ...(previous?.status === 'cancelled' ? { cancelledRef: previous.ref as string } : {}),
      summary: `${title}. ${note}`.slice(0, 1500),
      testerAgentId: agentId,
      evidence,
      note,
      title,
    });
  }
  return [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'TestReworkRequested',
        payload: {
          cardId: card.id,
          testerAgentId: agentId,
          evidence,
          summary: title,
          headSha: head,
        },
      },
      actor: agentActor(agentId),
      scope: projectScope(card.org_id, card.project_id),
    },
    cardMessage(card, { kind: 'system' }, 'system', `${why}\n\n${note}`, { failureScope: 'e2e_spec' }),
  ];
}

/** Who answered a `tester_loop` question, for the events its action appends. */
export interface Answerer {
  user: { id: string; displayName: string };
  actor: AppendInput['actor'];
  author: Parameters<typeof cardMessage>[1];
}

/**
 * The answer of a `tester_loop` question performs its action, in the answer's transaction (after `QuestionAnswered`,
 * which put the card back in the Test queue): `builder` creates the bug card, `tester` sends the card back to the tester
 * (an answer without an option too: its text is the instruction), `cancel` cancels the card.
 */
export async function testerLoopAnswered(
  ctx: Ctx,
  tx: Tx,
  item: Row,
  optionId: string | undefined,
  answer: string,
  by: Answerer,
): Promise<void> {
  if (item.subkind !== DESK_SUBKIND.testerLoop || !item.card_id) return;
  const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [item.card_id]);
  if (!card || ['done', 'cancelled'].includes(card.status)) return;
  const data = (item.data ?? {}) as {
    testerAgentId?: string;
    title?: string;
    note?: string;
    evidence?: TestEvidence;
  };
  const choice = optionId ?? TESTER_LOOP_OPTIONS.tester;
  if (choice === TESTER_LOOP_OPTIONS.cancel) {
    await cancelCardIn(ctx, tx, by.user, card, `cancelled after the tester failed it again: ${answer}`, {
      actor: by.actor,
    });
    return;
  }
  if (card.stage !== 'test') {
    // Someone moved the card meanwhile: say on its thread that the choice was not carried out.
    await ctx.store.append(
      [
        cardMessage(
          card,
          by.author,
          'comment',
          `The tester-loop answer ("${choice}") was not carried out: ${card.ref} is no longer in Test (it is at '${card.stage}').`,
          { failureScope: 'tester_loop' },
        ),
      ],
      { tx },
    );
    return;
  }
  const evidence: TestEvidence = data.evidence ?? {
    commands: [],
    summary: data.title ?? answer,
    outputExcerpt: '',
  };
  const title = data.title?.trim() || evidence.title?.trim() || `Bug found testing ${card.ref}`;
  const testerId = data.testerAgentId ?? card.original_builder_agent_id ?? (by.actor as { id: string }).id;
  if (choice === TESTER_LOOP_OPTIONS.builder) {
    await ctx.store.append(await bugCardEvents(tx, card, testerId, data.note ?? answer, evidence, title), {
      tx,
    });
    return;
  }
  const instruction = optionId
    ? [data.note, answer && answer !== data.note ? `Decision: ${answer}` : ''].filter(Boolean).join('\n\n')
    : answer;
  await ctx.store.append(
    [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'TestReworkRequested',
          payload: {
            cardId: card.id,
            testerAgentId: testerId,
            evidence: { ...evidence, failureScope: 'e2e_spec' },
            summary: title,
            headSha: null,
            instruction,
          },
        },
        actor: by.actor,
        scope: projectScope(card.org_id, card.project_id),
      },
      cardMessage(
        card,
        by.author,
        'comment',
        `${card.ref} goes back to the tester. Do the work yourself in this shift: edit the E2E spec or fixtures and run the capture or suites. ${instruction}`,
        { failureScope: 'e2e_spec' },
      ),
    ],
    { tx },
  );
}
