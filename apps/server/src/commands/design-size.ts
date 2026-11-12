import { randomUUID } from 'node:crypto';
import {
  allowedOutcomes,
  type DesignSizing,
  designSizing,
  type InvestigationData,
  MIN_RUNNER_FOR_DESIGN_SIZE,
  NEEDS_SPLIT_QUESTION_OPTIONS,
  NEEDS_SPLIT_QUESTION_SUBKIND,
  NeedsSplitProposalSchema,
  needsSplitProposalFrom,
  needsSplitProposalLines,
  pathsInText,
  type RiskClass,
  resolveOutcome,
  runnerAtLeast,
  SIZE_UNIT_WORDS,
  type SizingSeam,
  type StoredNeedsSplitProposal,
  storedDesignSizing,
  streamId,
  type WorkflowCardView,
  type WorkflowDefinition,
} from '@aom/shared';
import { loadWorkflowById } from '../catalogue/loader.ts';
import { ceoActive, ceoReachable } from '../ceo/state.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { reviewSettingsOf } from '../queries/misc.ts';
import { workflowView } from './cards.ts';
import { agentActor, cardMessage, projectScope } from './common.ts';
import {
  currentNeedsSplitRecord,
  type NeedsSplitBy,
  needsSplitRefusal,
  needsSplitTaken,
  requestNeedsSplitIn,
} from './needs-split.ts';
import { splitOwner } from './spec-card.ts';
import { CEO_STOP_LOSS_HOLD_MINUTES } from './stop-loss.ts';

/**
 * The size estimate at design time: the architect's estimate in the project's unit and the derived risk class are
 * recorded with the design report (`DesignSized`), and the server gives the verdict against the project's budget. Only an
 * over-budget verdict raises the needs-split question, in the architect's name; a high risk class alone never does.
 */

export type DesignMode = 'design' | 'revise' | 'confirm';

const unitWords = (unit: string | null): string =>
  unit && unit in SIZE_UNIT_WORDS ? SIZE_UNIT_WORDS[unit as keyof typeof SIZE_UNIT_WORDS] : (unit ?? '');

/** The design handoff's mode from its outcome data. */
export function designModeOf(inv: Pick<InvestigationData, 'review'>): DesignMode {
  return inv.review?.decision ?? 'design';
}

/**
 * Computes the sizing of a design handoff, or the reason it is refused. `confirm` recomputes the stored estimate against
 * the current settings. The estimate is required whenever the project has a size unit and the runner sends it.
 */
export function designSizeStep(i: {
  card: Row;
  project: Row;
  inv: InvestigationData;
  mode: DesignMode;
  runnerVersion: string | null | undefined;
}): { error: string } | { sizing: DesignSizing } {
  const settings = reviewSettingsOf(i.project);
  const unit = settings.sizeUnit;
  const required = unit != null && runnerAtLeast(i.runnerVersion ?? null, MIN_RUNNER_FOR_DESIGN_SIZE);
  const words = unitWords(unit);
  const affectedAreaPaths = pathsInText(String(i.card.fields?.affectedAreas ?? ''));
  let estimate: number | null = null;
  let paths: string[] = [];
  let declaredRisk: RiskClass | null = null;
  let seams: SizingSeam[] = [];
  const stored = storedDesignSizing(i.card.investigation?.sizing);
  if (i.mode === 'confirm' && !i.inv.size) {
    if (stored?.estimate != null) {
      estimate = stored.estimate;
      paths = stored.paths;
      declaredRisk = (stored.risk.declared as RiskClass | null) ?? null;
      seams = stored.seams;
    } else if (required)
      return {
        error: `this project measures size in ${words}: the design has no size estimate yet, so re-run as \`aom design revise --revised <numbers> --size <n> --path "<folder or file>"\``,
      };
  } else if (i.inv.size) {
    estimate = i.inv.size.estimate;
    paths = i.inv.size.paths;
    declaredRisk = i.inv.size.risk ?? null;
    seams = i.inv.size.seams;
  }
  if (required && i.mode !== 'confirm' && (!i.inv.size || paths.length === 0))
    return {
      error: `this project measures size in ${words} with a budget of ${settings.sizeBudget ?? 'no budget (no size budget set)'}: add --size <n> (your estimate in ${words}) and at least one --path "<folder or file>" the change touches`,
    };
  const sizing = designSizing({ settings, estimate, paths, affectedAreaPaths, declaredRisk, seams });
  return { sizing };
}

/** What an over-budget verdict does, before the async "already split once" check. */
export function splitDecision(
  sizing: Pick<DesignSizing, 'verdict'>,
  needsSplitState: string | null | undefined,
): 'none' | 'continued' | 'split' {
  if (sizing.verdict !== 'over_budget') return 'none';
  if (needsSplitState === 'continued') return 'continued';
  return 'split';
}

/** The proposal for GWP-208's transition, or why it is refused (fewer than 2 seams, no folder, ...). */
export function checkedProposal(
  sizing: DesignSizing,
  summary: string,
): { proposal: StoredNeedsSplitProposal } | { error: string } {
  const proposal = needsSplitProposalFrom(sizing, summary);
  const parsed = NeedsSplitProposalSchema.safeParse(proposal);
  if (parsed.success) return { proposal: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  return {
    error: `${where}${issue?.message ?? 'invalid proposal'}. The estimate ${sizing.estimate} ${unitWords(sizing.unit)} is over the budget ${sizing.budget}: name at least 2 split seams with --seam "<title>: <folder>, <folder>" and the folders with --path, so the card can be split`,
  };
}

/** The card's needs-split state as it stands now (`continued`: the owner kept it as one card). */
export async function needsSplitStateOf(db: Queryable, card: Row): Promise<string | null> {
  return (await currentNeedsSplitRecord(db, card))?.state ?? null;
}

/** Who holds the architect's question: the CEO (held, hidden from the desk for a while) when it can look, else the desk. */
export async function needsSplitQuestionRoute(
  ctx: Ctx,
  tx: Tx,
  card: Row,
): Promise<{ ceoHold?: { deadline: string }; note: string }> {
  const ceo = await ceoActive(tx, card.org_id);
  if (!ceo) return { note: "the owner's desk (no CEO is active)" };
  const reachable = (await ceoReachable(tx, card.org_id, ctx.clock.now())).ok;
  const paused = !!(await one(tx, 'SELECT 1 FROM projects WHERE id=$1 AND paused_at IS NOT NULL', [
    card.project_id,
  ]));
  if (!reachable || paused)
    return {
      note: `the owner's desk (the CEO ${paused ? 'cannot look at it now: the project is paused' : 'is not reachable'})`,
    };
  return {
    ceoHold: {
      deadline: new Date(ctx.clock.now().getTime() + CEO_STOP_LOSS_HOLD_MINUTES * 60_000).toISOString(),
    },
    note: 'the CEO first; the owner sees it if the CEO does not decide',
  };
}

/** The architect's needs-split question (blocking, pinned). Empty when one is already open on the card. */
export async function needsSplitQuestionEvents(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  agent: Row,
  shiftId: string | undefined,
  sizing: DesignSizing,
  proposal: StoredNeedsSplitProposal,
  outcomeId?: string,
): Promise<AppendInput[]> {
  const open = await one(
    tx,
    `SELECT 1 AS x FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`,
    [card.id, NEEDS_SPLIT_QUESTION_SUBKIND],
  );
  if (open) return [];
  const { ceoHold, note } = await needsSplitQuestionRoute(ctx, tx, card);
  const deskItemId = randomUUID();
  const words = unitWords(sizing.unit);
  const question = [
    `${card.ref} is estimated at ${sizing.estimate} ${words}, over the project's size budget of ${sizing.budget}. Split it (back to the BA once, along the seams below) or build it as designed?`,
    '',
    ...needsSplitProposalLines(proposal),
  ].join('\n');
  return [
    {
      streamId: streamId.desk(deskItemId),
      event: {
        type: 'QuestionRaised',
        payload: {
          deskItemId,
          cardId: card.id,
          projectId: card.project_id,
          ...(shiftId ? { shiftId } : {}),
          askedBy: { kind: 'agent', agentId: agent.id },
          doing: `${card.ref} design: size estimate over the project budget`.slice(0, 500),
          question,
          options: [
            {
              id: NEEDS_SPLIT_QUESTION_OPTIONS.split,
              label: 'Split: send the card back to the BA with the folder scope and split seams',
            },
            { id: NEEDS_SPLIT_QUESTION_OPTIONS.build, label: 'Build it as designed (over budget)' },
          ],
          recommendation: NEEDS_SPLIT_QUESTION_OPTIONS.split,
          blocking: true,
          routedTo: 'manager',
          chainLevel: 'desk',
          ...(ceoHold ? { triage: ceoHold } : {}),
          topic: 'design',
          subkind: NEEDS_SPLIT_QUESTION_SUBKIND,
          dedupLedgerIds: [],
          affectedCardIds: [card.id],
          pinned: true,
          data: { sizing, proposal, fromStage: card.stage, ...(outcomeId ? { outcomeId } : {}) },
        },
      },
      actor: agentActor(agent.id),
      scope: projectScope(card.org_id, card.project_id),
    },
    cardMessage(
      card,
      { kind: 'agent', agentId: agent.id },
      'system',
      `Needs-split question raised by ${agent.name ?? 'the architect'}: ${note}.`,
      { deskItemId },
    ),
  ];
}

/**
 * A card that already went to the BA once (or was split out of one that did): no architect question, GWP-208's
 * transition raises the owner's decision. Runs after the handoff is appended, in its transaction; a refusal (an owner
 * item already open, ...) is noted on the thread instead of rolling the handoff back.
 */
export async function needsSplitTakenIn(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  agent: Row,
  proposal: StoredNeedsSplitProposal,
  outcomeId?: string,
): Promise<void> {
  const fresh = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [card.id])) as Row;
  const refusal = await needsSplitRefusal(tx, fresh);
  if (refusal) {
    // Already with the BA or waiting for the owner: someone holds the card. Otherwise nobody would pick it up and the
    // architect would be sent again, so the design is handed on as it stands.
    const completion =
      refusal.code === 'needs_split_open'
        ? []
        : await designCompletionEvents(tx, fresh, agentActor(agent.id), outcomeId);
    await ctx.store.append(
      [
        ...completion,
        cardMessage(
          fresh,
          { kind: 'agent', agentId: agent.id },
          'system',
          `Over budget, but the needs split was not started: ${refusal.message}.${completion.length ? ' The design goes on as it stands.' : ''}`,
        ),
      ],
      { tx },
    );
    return;
  }
  await requestNeedsSplitIn(
    ctx,
    tx,
    fresh,
    proposal,
    { actor: agentActor(agent.id), user: await splitOwner(tx, fresh), name: agent.name ?? 'the architect' },
    { fromStage: card.stage },
  );
}

/** Whether the over-budget card already took the needs-split route (it goes to the owner, not to the architect's question). */
export async function needsSplitTakenFor(db: Queryable, card: Row): Promise<boolean> {
  return (await needsSplitTaken(db, card)).taken;
}

/**
 * The outcome that hands the design on: the one the architect's handoff used when it still applies, else the stage's
 * first applicable success outcome that completes the stage (the design stage of a custom workflow may call it `done`
 * or anything else). Null when the stage has none.
 */
export function designCompletionOutcome(
  def: Pick<WorkflowDefinition, 'stages'>,
  card: WorkflowCardView,
  stageId: string,
  preferred: string | null | undefined,
): string | null {
  const completes = allowedOutcomes(def, card, stageId).filter(
    (o) => o.kind === 'success' && o.event === 'StageCompleted',
  );
  return (completes.find((o) => o.id === preferred) ?? completes[0])?.id ?? null;
}

/** The design stage completes now: the card goes on to the stage the handoff's outcome (`outcomeId`) leads to. */
export async function designCompletionEvents(
  tx: Tx,
  card: Row,
  by: AppendInput['actor'],
  outcomeId?: string | null,
): Promise<AppendInput[]> {
  const wf = await loadWorkflowById(tx, card.workflow_version_id);
  if (!wf) return [];
  const view = workflowView(card);
  const outcome = designCompletionOutcome(wf.definition, view, card.stage, outcomeId);
  if (!outcome) return [];
  const resolved = resolveOutcome(wf.definition, view, card.stage, outcome);
  return [
    {
      streamId: streamId.card(card.id),
      event: {
        type: 'StageCompleted',
        payload: { cardId: card.id, fromStage: card.stage, toStage: resolved.toStage, outcome },
      },
      actor: by,
      scope: projectScope(card.org_id, card.project_id),
    },
  ];
}

/**
 * The answer to the architect's needs-split question, in the answer's transaction: `split` sends the card back to the
 * BA (GWP-208 decides the route), `build` (or a text answer) completes the design stage. A dismissed item runs nothing.
 */
export async function needsSplitQuestionAnswered(
  ctx: Ctx,
  tx: Tx,
  item: Row,
  optionId: string | undefined,
  _answer: string,
  by: NeedsSplitBy,
): Promise<void> {
  if (item.subkind !== NEEDS_SPLIT_QUESTION_SUBKIND || !item.card_id) return;
  const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [item.card_id]);
  if (!card) return;
  const author =
    by.actor.kind === 'user' ? { kind: 'user' as const, userId: by.user.id } : { kind: 'system' as const };
  const choice =
    optionId === NEEDS_SPLIT_QUESTION_OPTIONS.split
      ? NEEDS_SPLIT_QUESTION_OPTIONS.split
      : NEEDS_SPLIT_QUESTION_OPTIONS.build;
  const data = (item.data ?? {}) as {
    proposal?: StoredNeedsSplitProposal;
    fromStage?: string;
    outcomeId?: string;
  };
  const note = (body: string) => ctx.store.append([cardMessage(card, author, 'comment', body)], { tx });
  if (['done', 'cancelled'].includes(card.status)) {
    await note(`The needs-split answer ("${choice}") was not carried out: ${card.ref} is ${card.status}.`);
    return;
  }
  if (!String(card.stage).startsWith('investigate')) {
    await note(
      `The needs-split answer ("${choice}") was not carried out: ${card.ref} is no longer in the design stage.`,
    );
    return;
  }
  if (choice === NEEDS_SPLIT_QUESTION_OPTIONS.split && data.proposal) {
    const refusal = await needsSplitRefusal(tx, card);
    if (refusal) {
      await note(
        `The needs split was not started: ${refusal.message}. The architect looks at the design again.`,
      );
      return;
    }
    await requestNeedsSplitIn(ctx, tx, card, data.proposal, by, {
      ...(data.fromStage ? { fromStage: data.fromStage } : {}),
    });
    return;
  }
  const fresh = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [card.id])) as Row;
  const completion = await designCompletionEvents(tx, fresh, by.actor, data.outcomeId);
  if (!completion.length) {
    await note(
      `The needs-split answer ("${choice}") was not carried out: ${card.ref}'s design step has no outcome that hands the design on.`,
    );
    return;
  }
  await ctx.store.append(
    [
      ...completion,
      cardMessage(
        fresh,
        author,
        'comment',
        `${by.name} keeps ${card.ref} as one card over budget: on to Build.`,
      ),
    ],
    { tx },
  );
}
