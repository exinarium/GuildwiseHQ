import { randomUUID } from 'node:crypto';
import {
  CEO_DECISION_REVIEW_REASON,
  CEO_DECISION_SUBKIND,
  CEO_REVIEW_REPLY_TIMEOUT_MS,
  type FixCard,
  type FixPlan,
  renderCeoData,
  renderUntrusted,
  splitFixPlan,
  streamId,
} from '@aom/shared';
import { agentActor, cardMessage, orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { carrierProject } from '../reporter/tasks.ts';
import { CEO_REVIEW_FINAL_TASK_NAME, citedBy, clip, decisionOf, proposedRuleOf } from './decisions.ts';
import { addMemoryIn } from './memory.ts';
import { loadCeo } from './state.ts';
import { enqueueWake } from './wakes.ts';

/**
 * The CEO-BA discussion after the owner corrected a decision: the BA analyses (and proposes fix cards), the CEO replies
 * (agree or disagree, what it got wrong, the lesson), the BA finalises and creates the fix cards. Exactly these three turns.
 * The state lives in the decision item's `data.correction` (`review`: pending -> analysed -> lesson -> done), written by the
 * `Ceo*` events only. When either side does not come, the server continues with what exists.
 */

type Correction = {
  reviewId?: string;
  review?: string;
  text?: string;
  by?: string;
  baAgentId?: string;
  analysis?: string;
  analysedAt?: string;
  proposedRule?: string;
  proposedCards?: FixCard[];
  noFixReason?: string;
  consequences?: string;
  lesson?: string;
  ceoReply?: { stance: string | null; cardChanges: string | null; withoutCeo: boolean };
};

const correctionOf = (item: Row): Correction =>
  (item.data as { correction?: Correction } | null)?.correction ?? {};

// ---------------------------------------------------------------------------------------- the BA's analysis

/** The BA's analysis arrived (or the BA never came, `fallback`): it goes on the item and the card thread. */
export async function reviewAnalysisEvents(
  tx: Tx,
  item: Row,
  input: { analysis: string; baAgentId?: string | undefined; fallback?: boolean },
): Promise<AppendInput[]> {
  const reviewId = correctionOf(item).reviewId;
  if (!reviewId) return [];
  const card = item.card_id ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [item.card_id]) : undefined;
  const { prose, plan } = splitFixPlan(input.analysis);
  const rule = proposedRuleOf(prose);
  const cards = plan?.fixCards ?? [];
  const events: AppendInput[] = [
    {
      streamId: streamId.ceo(item.org_id),
      event: {
        type: 'CeoCorrectionAnalysed',
        payload: {
          orgId: item.org_id,
          deskItemId: item.id,
          reviewId,
          analysis: prose.slice(0, 8000),
          ...(rule ? { proposedRule: rule } : {}),
          ...(input.baAgentId ? { baAgentId: input.baAgentId } : {}),
          ...(input.fallback ? { fallback: true } : {}),
          ...(cards.length ? { proposedCards: cards } : {}),
          ...(plan?.noFixNeeded ? { noFixReason: plan.noFixNeeded } : {}),
          ...(plan?.consequences ? { consequences: plan.consequences } : {}),
        },
      },
      actor: input.baAgentId ? agentActor(input.baAgentId) : SYSTEM_ACTOR,
      scope: orgScope(item.org_id),
    },
  ];
  if (card)
    events.push(
      cardMessage(
        card,
        input.baAgentId ? { kind: 'agent', agentId: input.baAgentId } : { kind: 'system' },
        'comment',
        [
          `BA review of the CEO decision after the owner's correction:\n\n${clip(prose, 1500)}`,
          cards.length
            ? `Proposed fix cards (not created yet; the CEO comments first):\n${cards.map((c) => `- ${c.project}: ${c.title}`).join('\n')}`
            : plan?.noFixNeeded
              ? `No fix work needed: ${clip(plan.noFixNeeded, 300)}`
              : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        { deskItemId: item.id, ceoReview: true },
      ),
    );
  return events;
}

// ------------------------------------------------------------------------------------------ the CEO's turn

/** Starts the CEO's turn once the BA's analysis is committed: a `decision_review` wake, or the fallback when there is no CEO. */
async function startCeoTurn(ctx: Ctx, deskItemId: string, reviewId: string): Promise<void> {
  const item = await one(ctx.pool, 'SELECT * FROM desk_items WHERE id=$1', [deskItemId]);
  if (!item) return;
  const corr = correctionOf(item);
  if (corr.reviewId !== reviewId || corr.review !== 'analysed') return;
  const ceo = await loadCeo(ctx.pool, item.org_id);
  if (!ceo?.enabled || !ceo.agentId) {
    await recordLesson(ctx, deskItemId, reviewId, { by: 'server' });
    return;
  }
  await enqueueWake(
    ctx.pool,
    item.org_id,
    {
      reason: CEO_DECISION_REVIEW_REASON,
      urgency: 'normal',
      subjectKind: 'desk',
      subjectId: item.id,
      subjectLabel: item.title,
      detail: { reviewId },
      // The BA's analysis is agent text: the wake is handled as untrusted input.
      untrusted: true,
    },
    ctx.clock.now(),
  );
  ctx.services.dispatcher?.trigger?.();
}

/** Store hook: once the BA's analysis is committed, the CEO is woken for its turn. */
export function registerCeoReviewHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e) => {
    if (e.event.type !== 'CeoCorrectionAnalysed') return;
    const p = e.event.payload;
    try {
      await startCeoTurn(ctx, p.deskItemId, p.reviewId);
    } catch (err) {
      ctx.log.error({ err }, 'starting the CEO turn of a decision review failed');
    }
  });
}

/**
 * The part of the CEO's brief that belongs to its `decision_review` wakes: the situation, its decision and reason, the
 * memories it cited, the owner's correction, the BA's analysis and the proposed cards. Agent-written text is fenced.
 */
export async function decisionReviewBrief(ctx: Ctx, wakes: Row[]): Promise<string> {
  const out: string[] = [];
  for (const w of wakes.filter((x) => x.reason === CEO_DECISION_REVIEW_REASON)) {
    const item = await one(ctx.pool, 'SELECT * FROM desk_items WHERE id=$1', [w.subject_id]);
    const d = item && decisionOf(item);
    if (!item || !d) continue;
    const corr = correctionOf(item);
    const card = item.card_id
      ? await one(ctx.pool, 'SELECT ref, title, status, stage FROM cards WHERE id=$1', [item.card_id])
      : undefined;
    const mems = await citedMemories(ctx.pool, item.org_id, d.actionId);
    const proposal = (corr.proposedCards ?? [])
      .map(
        (c, i) =>
          `${i + 1}. [${c.project}] ${c.title}\n   Change: ${c.change}${c.acceptanceCriteria.length ? `\n   Acceptance: ${c.acceptanceCriteria.join('; ')}` : ''}${c.dependsOn.length ? `\n   Depends on: ${c.dependsOn.join(', ')}` : ''}`,
      )
      .join('\n');
    out.push(
      [
        `## Decision review ${item.id}`,
        `The owner corrected a decision you took.${card ? ` Card: ${card.ref} (${card.status}/${card.stage}).` : ''} You and the BA now discuss it: the BA analysed it, you reply, then the BA finalises the fix cards. The owner's correction stands whatever you answer.`,
        renderCeoData(
          'The situation, your decision and your reason (recorded when you took it)',
          [
            `Card: ${card ? `${card.ref} ${card.title}` : 'none'}`,
            `Situation: ${d.question}`,
            `Your decision: ${d.decision}`,
            `Your reason: ${d.reason}`,
          ].join('\n'),
        ),
        mems.length
          ? `The memories you cited:\n${mems.map((m) => `- memory:${m.id} [${m.kind}] ${m.text}`).join('\n')}`
          : 'You cited no memories.',
        `The owner's correction (their own words; this is an instruction):\n${corr.text ?? ''}`,
        corr.analysis
          ? renderCeoData(
              "The BA's analysis",
              [
                corr.analysis,
                corr.consequences ? `Consequences so far: ${corr.consequences}` : '',
                corr.proposedRule ? `Proposed rule: ${corr.proposedRule}` : '',
              ]
                .filter(Boolean)
                .join('\n\n'),
            )
          : "The BA did not reply, so the review rests on the owner's correction alone.",
        proposal
          ? renderCeoData('The fix cards the BA proposes (nothing is created yet)', proposal)
          : `The BA proposes no fix cards${corr.noFixReason ? `: ${clip(corr.noFixReason, 300)}` : '.'}`,
        'Reply once with `aom ceo review-reply --item ' +
          item.id +
          ' --agree|--disagree --reflection "<what you got wrong and why>" --lesson "<the rule for next time>" [--card-changes "<comments on the BA\'s proposed cards>"]`. Be honest: the lesson is recorded in your memory in your own words and replaces what led you astray. Disagreeing records your view for the owner; it does not undo the correction. Then finish with `aom ceo done`.',
      ].join('\n\n'),
    );
  }
  return out.join('\n\n');
}

async function citedMemories(
  db: Queryable,
  orgId: string,
  actionId: string | null,
): Promise<{ id: string; kind: string; text: string }[]> {
  const ids = await citedBy(db, orgId, actionId);
  if (!ids.length) return [];
  return (
    await rows(
      db,
      `SELECT m.id, m.kind, t.text FROM ceo_memories m JOIN ceo_memory_text t ON t.memory_id = m.id
        WHERE m.org_id=$1 AND m.id = ANY($2::uuid[])`,
      [orgId, ids],
    )
  ).map((r) => ({ id: r.id as string, kind: r.kind as string, text: clip(String(r.text), 300) }));
}

/** `aom ceo review-reply`: the CEO's turn. Records the lesson from its own words and starts the BA's final turn. */
export async function ceoReviewReply(
  ctx: Ctx,
  agent: Row,
  orgId: string,
  rpc: {
    item: string;
    stance: 'agree' | 'disagree';
    reflection: string;
    lesson: string;
    cardChanges?: string | undefined;
  },
): Promise<{ status: 'executed' | 'refused'; message: string }> {
  const item = await one(ctx.pool, `SELECT * FROM desk_items WHERE id=$1 AND org_id=$2 AND subkind=$3`, [
    rpc.item,
    orgId,
    CEO_DECISION_SUBKIND,
  ]);
  const corr = item ? correctionOf(item) : undefined;
  if (!item || !corr?.reviewId)
    return { status: 'refused', message: 'that is not a corrected CEO decision under review' };
  if (corr.lesson)
    return {
      status: 'refused',
      message: 'the lesson for this correction is already recorded; there is no second round',
    };
  if (corr.review !== 'analysed')
    return { status: 'refused', message: "the BA's analysis is not in yet; you are woken when it is" };
  const done = await recordLesson(ctx, item.id, corr.reviewId, {
    by: 'ceo',
    ceoAgentId: agent.id,
    lesson: rpc.lesson,
    stance: rpc.stance,
    reflection: rpc.reflection,
    ...(rpc.cardChanges ? { cardChanges: rpc.cardChanges } : {}),
  });
  if (!done) return { status: 'refused', message: 'the lesson for this correction is already recorded' };
  return {
    status: 'executed',
    message:
      'Recorded as your lesson. The BA now finalises the fix cards with your comments; there is no further round. Finish with `aom ceo done`.',
  };
}

// ----------------------------------------------------------------------------------------------- the lesson

export interface LessonInput {
  /** The CEO wrote the lesson, or the server did because the CEO did not reply. */
  by: 'ceo' | 'server';
  ceoAgentId?: string;
  lesson?: string;
  stance?: 'agree' | 'disagree';
  reflection?: string;
  cardChanges?: string;
}

/**
 * Records the lesson: an owner-confirmed rule linked to the correction (`desk:<item>`), replacing the memories the decision
 * cited that the CEO had learned itself (owner statements are never retired, only lowered). From the CEO's own words; the
 * server records it on its behalf (marked "recorded without the CEO") when the CEO cannot. Then the BA's final turn is
 * queued when there is anything for it to do. Idempotent per review: returns false when the lesson already exists.
 */
export async function recordLesson(
  ctx: Ctx,
  deskItemId: string,
  reviewId: string,
  input: LessonInput,
): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const item = await one(tx, 'SELECT * FROM desk_items WHERE id=$1 FOR UPDATE', [deskItemId]);
    const d = item && decisionOf(item);
    if (!item || !d) return false;
    const corr = correctionOf(item);
    if (corr.reviewId !== reviewId || corr.lesson || corr.review === 'done') return false;
    const withoutCeo = input.by === 'server';
    const ceo = await loadCeo(tx, item.org_id);
    const ceoId = input.ceoAgentId ?? (ceo?.enabled && ceo.agentId ? ceo.agentId : null);
    const rule = (
      input.lesson?.trim() ||
      corr.proposedRule ||
      `When deciding "${clip(d.question, 160)}", the right decision is: ${clip(corr.text ?? '', 300)}`
    ).slice(0, 700);
    const lesson = `Lesson (owner correction, ${withoutCeo ? 'recorded without the CEO' : 'discussed with the BA'}): ${rule}`;
    const memoryId = await addMemoryIn(ctx, tx, {
      orgId: item.org_id,
      kind: 'rule',
      scope: d.class ? `desk:${d.class}` : 'org',
      source: 'owner_override',
      sourceRef: `desk:${item.id}`,
      confidence: 0.9,
      status: 'active',
      text: lesson,
      quote: (corr.text ?? '').slice(0, 1000),
      ...(ceoId ? { byAgentId: ceoId } : {}),
    });
    const actor = !withoutCeo && ceoId ? agentActor(ceoId) : SYSTEM_ACTOR;
    const retired: string[] = [];
    const events: AppendInput[] = [];
    for (const mid of await citedBy(tx, item.org_id, d.actionId)) {
      const m = await one(tx, `SELECT status, source FROM ceo_memories WHERE id=$1 AND org_id=$2`, [
        mid,
        item.org_id,
      ]);
      if (!m || m.status === 'retired' || m.source === 'owner_statement') continue;
      retired.push(mid);
      events.push({
        streamId: streamId.ceo(item.org_id),
        event: {
          type: 'CeoMemoryRetired',
          payload: {
            memoryId: mid,
            orgId: item.org_id,
            reason: 'replaced by a lesson from an owner correction',
          },
        },
        actor,
        scope: orgScope(item.org_id),
      });
    }
    const cardChanges = input.cardChanges?.trim() || undefined;
    const finalTurn = (corr.proposedCards?.length ?? 0) > 0 || !!cardChanges;
    events.push({
      streamId: streamId.ceo(item.org_id),
      event: {
        type: 'CeoLessonRecorded',
        payload: {
          orgId: item.org_id,
          deskItemId: item.id,
          reviewId,
          memoryId,
          lesson: lesson.slice(0, 1000),
          retiredMemoryIds: retired,
          recordedBy: withoutCeo ? 'server' : 'ceo',
          ...(input.stance ? { stance: input.stance } : {}),
          ...(input.reflection ? { reflection: input.reflection.slice(0, 2000) } : {}),
          ...(cardChanges ? { cardChanges: cardChanges.slice(0, 2000) } : {}),
          ...(withoutCeo ? { withoutCeo: true } : {}),
          ...(finalTurn ? { finalTurn: true } : {}),
        },
      },
      actor,
      scope: orgScope(item.org_id),
    });
    const card = item.card_id ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [item.card_id]) : undefined;
    if (card)
      events.push(
        cardMessage(
          card,
          !withoutCeo && ceoId ? { kind: 'agent', agentId: ceoId } : { kind: 'system' },
          'comment',
          withoutCeo
            ? `CEO lesson recorded without the CEO (it did not reply): ${rule}`
            : [
                `CEO ${input.stance === 'disagree' ? 'disagrees but records' : 'agrees and records'} the lesson after the owner's correction: ${rule}`,
                input.reflection ? `What it got wrong: ${clip(input.reflection, 600)}` : '',
                cardChanges ? `On the proposed fix cards: ${clip(cardChanges, 500)}` : '',
              ]
                .filter(Boolean)
                .join('\n\n'),
          { deskItemId: item.id, ceoReview: true },
        ),
      );
    const finalProject = finalTurn ? await carrierProject(tx, item.org_id, item.project_id) : null;
    if (finalProject) {
      const taskId = randomUUID();
      events.push({
        streamId: streamId.baTask(taskId),
        event: {
          type: 'BaTaskQueued',
          payload: {
            taskId,
            projectId: finalProject,
            kind: 'scheduled_brief',
            ...(corr.baAgentId ? { preferredAgentId: corr.baAgentId } : {}),
            instructions: finalInstructions(),
            deliver: 'desk_notice',
            scheduleName: CEO_REVIEW_FINAL_TASK_NAME,
            deskItemIds: [item.id],
            ...(item.project_id ? {} : { orgLevel: true }),
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(item.org_id, finalProject),
      });
    }
    await ctx.store.append(events, { tx });
    // Nothing left for the BA to do (or nobody to give it to): the discussion ends here.
    if (!finalProject) {
      const fresh = (await one(tx, 'SELECT * FROM desk_items WHERE id=$1', [item.id])) as Row;
      await ctx.store.append(
        await reviewConclusionEvents(ctx, tx, fresh, {
          fallback: finalTurn,
          note: finalTurn ? 'No BA or project was available for the final turn.' : undefined,
        }),
        { tx },
      );
    }
    return true;
  });
}

/** What the BA is asked in its final turn (at most 2000 characters; the facts are added when the shift starts). */
export function finalInstructions(): string {
  return [
    'CEO decision review, final turn. The CEO has replied to your analysis (its reply and your earlier proposal follow under Facts).',
    'Read-only: adjust your proposal to the CEO comments and report the FINAL fix cards. Do not create anything yourself: the server creates the cards you list, in the right project, drafted by you, and links them to the decision and the original card.',
    'Write a short note (what you changed and why), then end the file with one fenced json block: {"fixCards":[{"title","project","cardType","change","acceptanceCriteria":[],"dependsOn":[],"priority"}],"noFixNeeded":"<reason, only when no cards are needed>"}.',
    'Post it with `aom report brief --summary-file <report.md>`.',
  ].join('\n');
}

// ------------------------------------------------------------------------------------------ the final turn

/** True when a BA task is the final turn of a review (its report creates the fix cards). */
export const isFinalReviewTask = (task: Row): boolean => task.schedule_name === CEO_REVIEW_FINAL_TASK_NAME;

/**
 * The server-composed facts a review task starts with: the decision, what happened since (the card's thread, the work
 * that moved, what the CEO did afterwards) and, in the final turn, the CEO's reply and the earlier proposal. This is
 * appended to the instructions when the shift starts, so it is never cut at the event size.
 */
export async function reviewFacts(db: Queryable, task: Row, item: Row): Promise<string> {
  const d = decisionOf(item);
  if (!d) return '';
  const corr = correctionOf(item);
  const final = task.schedule_name === CEO_REVIEW_FINAL_TASK_NAME;
  // From the moment the CEO took the decision (its action is the first row), else from the item.
  const act0 = d.actionId
    ? await one(db, 'SELECT created_at FROM ceo_actions WHERE id=$1 AND org_id=$2', [d.actionId, item.org_id])
    : undefined;
  const since = new Date(act0?.created_at ?? item.created_at);
  const out: string[] = ['## Facts'];
  out.push(
    [
      `Decision item: ${item.id} (CEO decision, ${new Date(item.created_at).toISOString()})`,
      `Situation: ${d.question}`,
      `The CEO decided: ${d.decision}`,
      `The CEO's reason: ${d.reason}`,
      `The owner's correction: ${corr.text ?? ''}`,
    ].join('\n'),
  );
  const card = item.card_id ? await one(db, 'SELECT * FROM cards WHERE id=$1', [item.card_id]) : undefined;
  if (card) {
    out.push(`Original card: ${card.ref} ${card.title} (${card.status}, stage ${card.stage})`);
    const msgs = await rows(
      db,
      `SELECT kind, body, author_kind, created_at FROM thread_messages WHERE thread_id=$1 ORDER BY created_at DESC LIMIT 15`,
      [card.id],
    );
    out.push(
      renderUntrusted(
        `Thread of ${card.ref}, newest last`,
        msgs
          .reverse()
          .map(
            (m) =>
              `[${new Date(m.created_at).toISOString()} ${m.author_kind}/${m.kind}] ${clip(String(m.body), 400)}`,
          )
          .join('\n'),
      ),
    );
  }
  const projectId = item.project_id ?? card?.project_id;
  if (projectId) {
    const moved = await rows(
      db,
      `SELECT ref, title, status, stage, created_at >= $2 AS created_since FROM cards
        WHERE project_id=$1 AND (updated_at >= $2 OR created_at >= $2) ORDER BY updated_at DESC LIMIT 20`,
      [projectId, since],
    );
    if (moved.length)
      out.push(
        renderUntrusted(
          'Cards of the project that were created or moved since the decision',
          moved
            .map(
              (c) =>
                `${c.ref} ${clip(String(c.title), 100)} (${c.status}/${c.stage}${c.created_since ? ', created since' : ''})`,
            )
            .join('\n'),
        ),
      );
    const repos = await rows(
      db,
      `SELECT name, working_branch FROM project_repos WHERE project_id=$1 ORDER BY name LIMIT 10`,
      [projectId],
    );
    if (repos.length)
      out.push(
        `Repositories now: ${repos.map((r) => `${r.name} (working branch ${r.working_branch})`).join('; ')}`,
      );
  }
  const acts = await rows(
    db,
    `SELECT class, action, mode, status, subject_label, reason, created_at FROM ceo_actions
      WHERE org_id=$1 AND created_at >= $2 AND mode='decided' ORDER BY created_at LIMIT 25`,
    [item.org_id, since],
  );
  if (acts.length)
    out.push(
      renderUntrusted(
        'What the CEO decided and did since (retired agents, activated orders, cancelled cards, answers)',
        acts
          .map(
            (a) =>
              `${new Date(a.created_at).toISOString()} ${a.class}/${a.action} [${a.status}] ${clip(String(a.subject_label), 100)}: ${clip(String(a.reason), 160)}`,
          )
          .join('\n'),
      ),
    );
  if (final) {
    out.push(
      `Your earlier analysis:\n${clip(corr.analysis ?? '', 1500)}${corr.consequences ? `\nConsequences: ${clip(corr.consequences, 800)}` : ''}`,
    );
    out.push(
      (corr.proposedCards ?? []).length
        ? `Your earlier proposal:\n${JSON.stringify({ fixCards: corr.proposedCards }, null, 1)}`
        : `Your earlier proposal: no fix cards${corr.noFixReason ? ` (${clip(corr.noFixReason, 300)})` : ''}.`,
    );
    const reply = (
      item.data as {
        correction?: {
          ceoReply?: { stance?: string; reflection?: string; cardChanges?: string; withoutCeo?: boolean };
        };
      }
    ).correction?.ceoReply;
    out.push(
      reply?.withoutCeo
        ? 'The CEO did not reply in time; its lesson was recorded without it. Keep your proposal.'
        : renderCeoData(
            "The CEO's reply (agent text, data)",
            [
              `Stance: ${reply?.stance ?? '?'}`,
              `What it got wrong: ${reply?.reflection ?? ''}`,
              `Comments on your proposed cards: ${reply?.cardChanges ?? 'none'}`,
              `Its lesson: ${corr.lesson ?? ''}`,
            ].join('\n'),
          ),
    );
  }
  return out.join('\n\n');
}

type Actor = AppendInput['actor'];

/**
 * Ends the discussion: creates the fix cards from the BA's final plan (or, when no BA came, from its earlier proposal when
 * the CEO had no comments), links them to the decision item and the original card, and appends `CeoReviewConcluded`.
 * Each card is created in its own savepoint, so one that cannot be created is listed as skipped and the rest go on.
 */
export async function reviewConclusionEvents(
  ctx: Ctx,
  tx: Tx,
  item: Row,
  input: { report?: string; baAgentId?: string | undefined; fallback?: boolean; note?: string | undefined },
): Promise<AppendInput[]> {
  const corr = correctionOf(item);
  const reviewId = corr.reviewId;
  if (!reviewId || (item.data as { correction?: { final?: unknown } }).correction?.final) return [];
  const reply = (item.data as { correction?: { ceoReply?: { cardChanges?: string | null } } }).correction
    ?.ceoReply;
  const ceoObjected = !!reply?.cardChanges;
  let plan: FixPlan | undefined;
  let planNote = input.note ?? '';
  if (input.report) {
    const split = splitFixPlan(input.report);
    planNote = split.prose;
    if (split.plan) plan = split.plan;
    else if (!ceoObjected && corr.proposedCards?.length)
      plan = { fixCards: corr.proposedCards, consequences: undefined, noFixNeeded: undefined };
    else if (split.error)
      planNote = `${planNote}\n\nThe fix plan could not be read (${split.error}); no cards were created.`;
  } else if (!ceoObjected && corr.proposedCards?.length) {
    plan = { fixCards: corr.proposedCards, consequences: undefined, noFixNeeded: undefined };
    planNote ||=
      'The BA did not take its final turn; the cards it proposed earlier were created as they were.';
  } else if (corr.proposedCards?.length) {
    planNote ||=
      'The BA did not take its final turn and the CEO commented on the proposal, so no cards were created.';
  }
  const baName =
    (input.baAgentId ?? corr.baAgentId)
      ? ((await one(tx, 'SELECT name FROM agents WHERE id=$1', [input.baAgentId ?? corr.baAgentId]))?.name as
          | string
          | undefined)
      : undefined;
  const baId = input.baAgentId ?? corr.baAgentId;
  const actor: Actor = baId ? agentActor(baId) : SYSTEM_ACTOR;
  const made: { cardId: string; ref: string; title: string; projectKey: string }[] = [];
  const skipped: string[] = [];
  const events: AppendInput[] = [];
  const origin = item.card_id ? await one(tx, 'SELECT * FROM cards WHERE id=$1', [item.card_id]) : undefined;
  const users = await ownerCandidates(tx, item, corr);
  for (const fc of plan?.fixCards ?? []) {
    const sp = `fix_${made.length + skipped.length}`;
    await tx.query(`SAVEPOINT ${sp}`);
    try {
      const created = await createFixCard(ctx, tx, item, fc, users, actor, made);
      await tx.query(`RELEASE SAVEPOINT ${sp}`);
      made.push({
        cardId: created.cardId,
        ref: created.ref,
        title: fc.title,
        projectKey: created.projectKey,
      });
      const fresh = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [created.cardId])) as Row;
      events.push(
        cardMessage(
          fresh,
          baId ? { kind: 'agent', agentId: baId } : { kind: 'system' },
          'comment',
          `Drafted by ${baName ?? 'the server'} (BA) to fix CEO decision "${clip(decisionOf(item)?.decision ?? '', 120)}" (desk item ${String(item.id).slice(0, 8)}${origin ? `, card ${origin.ref}` : ''}): ${clip(fc.change, 160)}${created.missing?.length ? `\nStill missing before it can be specified: ${created.missing.join(', ')}.` : ''}`,
          { deskItemId: item.id, ceoReviewFix: true, ...(origin ? { originCardId: origin.id } : {}) },
        ),
      );
    } catch (err) {
      await tx.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      skipped.push(
        `${fc.project}: ${fc.title} (${err instanceof Error ? err.message : String(err)})`.slice(0, 480),
      );
    }
  }
  const noFix = plan?.noFixNeeded ?? (corr.proposedCards?.length ? undefined : corr.noFixReason);
  const summary = (
    made.length
      ? `Created ${made.length} fix card${made.length === 1 ? '' : 's'}: ${made.map((c) => c.ref).join(', ')}.`
      : noFix
        ? `No fix work needed: ${noFix}`
        : 'No fix cards were created.'
  ).concat(planNote ? `\n\n${clip(planNote, 1800)}` : '');
  if (origin)
    events.push(
      cardMessage(
        origin,
        baId ? { kind: 'agent', agentId: baId } : { kind: 'system' },
        'comment',
        made.length
          ? `Fix cards for the corrected CEO decision: ${made.map((c) => `${c.ref} ${c.title}`).join('; ')}.`
          : `The review of the corrected CEO decision ended: ${clip(summary, 400)}`,
        { deskItemId: item.id, ceoReview: true, fixCardIds: made.map((c) => c.cardId) },
      ),
    );
  events.push({
    streamId: streamId.ceo(item.org_id),
    event: {
      type: 'CeoReviewConcluded',
      payload: {
        orgId: item.org_id,
        deskItemId: item.id,
        reviewId,
        summary: summary.slice(0, 4000),
        cards: made,
        skipped,
        ...(baId ? { baAgentId: baId } : {}),
        ...(input.fallback ? { fallback: true } : {}),
      },
    },
    actor,
    scope: orgScope(item.org_id),
  });
  return events;
}

/** Who may own the fix cards: the person who corrected the decision, else the organization's owner. */
async function ownerCandidates(tx: Queryable, item: Row, corr: Correction): Promise<string[]> {
  const org = await one(tx, 'SELECT owner_user_id FROM organizations WHERE id=$1', [item.org_id]);
  return [...new Set([corr.by, org?.owner_user_id].filter((x): x is string => !!x))];
}

/** Creates one fix card (specified when complete) in its project; throws when it cannot. */
async function createFixCard(
  ctx: Ctx,
  tx: Tx,
  item: Row,
  fc: FixCard,
  users: string[],
  actor: Actor,
  made: { cardId: string; ref: string; title: string; projectKey: string }[],
): Promise<{ cardId: string; ref: string; projectKey: string; missing?: string[] | undefined }> {
  const { createCardIn } = await import('../commands/cards.ts');
  const project = await one(
    tx,
    `SELECT id, key FROM projects WHERE org_id=$1 AND key=upper($2) AND status='active' AND kind='project'`,
    [item.org_id, fc.project],
  );
  if (!project) throw new Error(`unknown project ${fc.project}`);
  const refs: string[] = [];
  const ids: string[] = [];
  for (const dep of fc.dependsOn) {
    const sibling = made.find((m) => m.title.toLowerCase() === dep.toLowerCase());
    // A card can only wait on a card of its own project; a dependency across projects is left out.
    if (sibling) {
      if (sibling.projectKey === project.key) ids.push(sibling.cardId);
    } else refs.push(dep.toUpperCase());
  }
  if (refs.length) {
    const found = await rows(tx, 'SELECT id FROM cards WHERE project_id=$1 AND ref = ANY($2::text[])', [
      project.id,
      refs,
    ]);
    ids.push(...found.map((f) => f.id as string));
  }
  const d = decisionOf(item);
  let lastErr: unknown;
  for (const userId of users) {
    try {
      const r = await createCardIn(
        ctx,
        tx,
        { id: userId } as never,
        {
          projectId: project.id,
          title: fc.title,
          cardType: fc.cardType,
          fields: {
            context: `Fixes the consequences of a CEO decision the owner corrected.\nDecision: ${clip(d?.decision ?? '', 400)}\nOwner's correction: ${clip(correctionOf(item).text ?? '', 600)}`,
            requirements: fc.change,
            acceptanceCriteria: fc.acceptanceCriteria,
            // A card is only specified when it is complete: what the BA left out is filled in plainly.
            affectedAreas:
              fc.affectedAreas ?? 'Not named by the review: the architect locates it from the requirements.',
            constraints:
              fc.constraints ??
              'Stay within the change described; the owner has already corrected the decision.',
            testPlan:
              fc.testPlan ??
              (fc.acceptanceCriteria.length
                ? `Check each acceptance criterion: ${fc.acceptanceCriteria.join('; ')}`
                : 'Check that the change described in the requirements is in place.'),
          },
          ...(fc.priority ? { priority: fc.priority } : {}),
          ...(ids.length ? { dependencies: [...new Set(ids)] } : {}),
          specify: true,
        } as never,
        { origin: 'intake', actor },
      );
      return { cardId: r.cardId, ref: r.ref, projectKey: project.key as string, missing: r.missing };
    } catch (err) {
      lastErr = err;
      // The next candidate owner may see the project; a SQL error would have aborted the savepoint.
      if (!(err instanceof Error) || /current transaction is aborted/.test(err.message)) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('no one may create cards in that project');
}

// --------------------------------------------------------------------------------------------- the timeout

/**
 * Reviews whose CEO turn nobody took within `CEO_REVIEW_REPLY_TIMEOUT_MS` (the CEO is paused, offline, over budget or
 * ended its shift without replying): the server records the lesson on its behalf and the BA's final turn goes on. Called
 * from the dispatcher pass; returns how many were continued.
 */
export async function sweepCeoReviews(
  ctx: Ctx,
  timeoutMs: number = CEO_REVIEW_REPLY_TIMEOUT_MS,
): Promise<number> {
  const cutoff = new Date(ctx.clock.now().getTime() - timeoutMs).toISOString();
  const stale = await rows(
    ctx.pool,
    `SELECT id, data->'correction'->>'reviewId' AS review_id FROM desk_items
      WHERE subkind=$1 AND data->'correction'->>'review' = 'analysed' AND data->'correction'->>'analysedAt' < $2`,
    [CEO_DECISION_SUBKIND, cutoff],
  );
  let n = 0;
  for (const s of stale) {
    try {
      if (await recordLesson(ctx, s.id, s.review_id, { by: 'server' })) {
        await exec(
          ctx.pool,
          `UPDATE ceo_wakes SET status='dropped' WHERE reason=$1 AND subject_id=$2 AND status='pending'`,
          [CEO_DECISION_REVIEW_REASON, s.id],
        );
        n++;
      }
    } catch (err) {
      ctx.log.error({ err }, 'continuing a CEO decision review without the CEO failed');
    }
  }
  return n;
}
