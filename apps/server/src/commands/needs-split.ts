import { randomUUID } from 'node:crypto';
import {
  getStage,
  NEEDS_SPLIT_DESK_SUBKIND,
  NEEDS_SPLIT_OPTIONS,
  NEEDS_SPLIT_REASON_TEXT,
  type NeedsSplitProposal,
  type NeedsSplitReason,
  NeedsSplitRecordSchema,
  needsSplitProposalLines,
  needsSplitRoute,
  type StoredNeedsSplitProposal,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadWorkflowById } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { cancelCardIn, loadManageable, moveCardIn } from './cards.ts';
import { cardMessage, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { hasActiveBa, queueSpecCardTask } from './spec-card.ts';

/**
 * Needs split: an over-budget card goes back to the BA once, with the architect's folder scope and split seams. The BA
 * splits it with the `spec_card` split (one splitting route); the children are linked to the parent. A card that already
 * took the route, or was split out of a card that did, goes to the owner's desk (`needs_split_decision`) instead.
 */

type Actor = AppendInput['actor'];

/** Who confirms the needs split: the events' actor and the user the move and the cancel run as. */
export interface NeedsSplitBy {
  actor: Actor;
  user: AuthSession['user'];
  /** Shown in the thread notes. */
  name: string;
}

/** The card's needs-split record, or null when it has none (or it does not parse). */
export function needsSplitRecord(card: Row) {
  if (!card.needs_split) return null;
  const parsed = NeedsSplitRecordSchema.safeParse(card.needs_split);
  return parsed.success ? parsed.data : null;
}

/** The card, or the card it was split out of by a needs split, already went to the BA once. */
export async function needsSplitTaken(
  db: Queryable,
  card: Row,
): Promise<{ taken: boolean; inheritedFrom?: { id: string; ref: string } }> {
  if (Number(card.needs_split_count ?? 0) > 0) return { taken: true };
  if (!card.parent_card_id) return { taken: false };
  const p = await one(
    db,
    `SELECT id, ref FROM cards WHERE id=$1 AND COALESCE(needs_split->'childCardIds', '[]'::jsonb) ? $2`,
    [card.parent_card_id, card.id],
  );
  return p ? { taken: true, inheritedFrom: { id: p.id as string, ref: p.ref as string } } : { taken: false };
}

/** Why needs split cannot start on this card now (null: it can). `answering`: the owner item being answered. */
export async function needsSplitRefusal(
  db: Queryable,
  card: Row,
  answering?: string,
): Promise<{ code: string; message: string } | null> {
  if (['done', 'cancelled'].includes(card.status))
    return { code: 'needs_split_closed', message: `${card.ref} is ${card.status}` };
  const wf = await loadWorkflowById(db, card.workflow_version_id);
  const initial = wf ? getStage(wf.definition, wf.definition.initialStage) : undefined;
  if (!wf || !initial || initial.kind !== 'manual')
    return {
      code: 'needs_split_no_spec',
      message: `${card.ref}'s workflow has no specification stage to send it back to`,
    };
  const built = await one(db, `SELECT 1 AS x FROM card_handoffs WHERE card_id=$1 AND stage='build' LIMIT 1`, [
    card.id,
  ]);
  if (built || (card.stage === 'build' && card.status === 'claimed'))
    return {
      code: 'needs_split_too_late',
      message: `${card.ref} is already being built: an over-budget pull request goes back to its author, not to the BA`,
    };
  const rec = needsSplitRecord(card);
  if (rec && rec.state === 'with_ba')
    return { code: 'needs_split_open', message: `${card.ref} is already with the BA to be split` };
  const openTask = await one(
    db,
    `SELECT 1 AS x FROM ba_tasks WHERE card_id=$1 AND kind='spec_card' AND status IN ('queued','running') LIMIT 1`,
    [card.id],
  );
  if (openTask) return { code: 'needs_split_open', message: `${card.ref} is already with the BA` };
  const openItem = await one(
    db,
    `SELECT id FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open' AND id IS DISTINCT FROM $3::uuid LIMIT 1`,
    [card.id, NEEDS_SPLIT_DESK_SUBKIND, answering ?? null],
  );
  if (openItem)
    return { code: 'needs_split_open', message: `${card.ref} already waits for the owner's decision on its size` };
  if (card.stage === wf.definition.initialStage)
    return {
      code: 'needs_split_too_late',
      message: `${card.ref} is already at ${initial.label}: nothing to send back`,
    };
  return null;
}

/** The owner's decision on an over-budget card that may not go to the BA (again): a pinned question on the desk. */
function needsSplitDecisionEvents(
  card: Row,
  proposal: StoredNeedsSplitProposal,
  reason: NeedsSplitReason,
  fromStage: string,
  hasBa: boolean,
): { deskItemId: string; events: AppendInput[] } {
  const deskItemId = randomUUID();
  const question = [
    `${card.ref} is ${NEEDS_SPLIT_REASON_TEXT[reason]}.`,
    '',
    `Why: ${proposal.reason}`,
    ...needsSplitProposalLines(proposal),
    '',
    'One return to the BA is allowed; you decide how it goes on.',
  ].join('\n');
  const options = [
    {
      id: NEEDS_SPLIT_OPTIONS.continue,
      label: 'Keep it as one card',
      description: 'The size is accepted: the design goes on as it is.',
    },
    ...(hasBa
      ? [
          {
            id: NEEDS_SPLIT_OPTIONS.baAgain,
            label: 'Send it to the BA to split anyway',
            description: "The BA splits it along the architect's seams.",
          },
        ]
      : []),
    { id: NEEDS_SPLIT_OPTIONS.cancel, label: 'Cancel the card', description: 'Give up on the card.' },
  ];
  return {
    deskItemId,
    events: [
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'QuestionRaised',
          payload: {
            deskItemId,
            cardId: card.id,
            projectId: card.project_id,
            askedBy: { kind: 'system' },
            doing: `${card.ref} (${card.title}) is over its size budget`.slice(0, 500),
            question,
            options,
            blocking: card.status !== 'draft',
            routedTo: 'manager',
            chainLevel: 'desk',
            topic: 'code',
            subkind: NEEDS_SPLIT_DESK_SUBKIND,
            dedupLedgerIds: [],
            affectedCardIds: [card.id],
            pinned: true,
            data: { reason, proposal, fromStage },
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(card.org_id, card.project_id),
      },
    ],
  };
}

export interface NeedsSplitResult {
  cardId: string;
  route: 'ba' | 'owner';
  reason: NeedsSplitReason;
  taskId?: string;
  deskItemId?: string;
  notice: string;
}

/**
 * Confirms needs split on `card` in the caller's transaction. First time: `CardNeedsSplitRequested{route:'ba'}`, then
 * the card moves to the workflow's first (manual) stage as a draft and a `spec_card` task in needs-split mode is queued.
 * Taken (or no BA): an owner desk item and no move. `force`: the owner's "send it to the BA again".
 */
export async function requestNeedsSplitIn(
  ctx: Ctx,
  tx: Tx,
  cardIn: Row,
  proposal: NeedsSplitProposal | StoredNeedsSplitProposal,
  by: NeedsSplitBy,
  opts: { force?: boolean; answering?: string; fromStage?: string } = {},
): Promise<NeedsSplitResult> {
  const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [cardIn.id])) as Row;
  const refusal = await needsSplitRefusal(tx, card, opts.answering);
  if (refusal) throw conflict(refusal.code, refusal.message);
  const taken = await needsSplitTaken(tx, card);
  const hasBa = await hasActiveBa(tx, card.org_id);
  const { route, reason } = needsSplitRoute({
    taken: taken.taken,
    inherited: !!taken.inheritedFrom,
    force: opts.force === true,
    hasBa,
  });
  const scope = projectScope(card.org_id, card.project_id);
  const fromStage = opts.fromStage ?? (card.stage as string);
  const stored: StoredNeedsSplitProposal = {
    reason: proposal.reason,
    folderScope: [...proposal.folderScope],
    seams: proposal.seams.map((s) => ({
      title: s.title,
      folders: [...s.folders],
      ...(s.repo ? { repo: s.repo } : {}),
      ...(s.note ? { note: s.note } : {}),
    })),
    ...(proposal.estimate ? { estimate: { ...proposal.estimate } } : {}),
  };
  const requested = (extra: { taskId?: string; deskItemId?: string }): AppendInput => ({
    streamId: streamId.card(card.id),
    event: {
      type: 'CardNeedsSplitRequested',
      payload: {
        cardId: card.id,
        route,
        reason,
        fromStage,
        proposal: stored,
        ...extra,
        ...(taken.inheritedFrom ? { inheritedFromCardId: taken.inheritedFrom.id } : {}),
      },
    },
    actor: by.actor,
    scope,
  });
  if (route === 'owner') {
    const q = needsSplitDecisionEvents(card, stored, reason, fromStage, hasBa);
    await ctx.store.append(
      [
        ...q.events,
        requested({ deskItemId: q.deskItemId }),
        cardMessage(
          card,
          { kind: 'system' },
          'system',
          `${card.ref} is ${NEEDS_SPLIT_REASON_TEXT[reason]}${taken.inheritedFrom ? ` (${taken.inheritedFrom.ref})` : ''}. It does not go to the BA: the owner decides on the desk.`,
          { deskItemId: q.deskItemId },
        ),
      ],
      { tx },
    );
    return {
      cardId: card.id,
      route,
      reason,
      deskItemId: q.deskItemId,
      notice:
        reason === 'no_ba'
          ? `No BA is hired to split ${card.ref}: the owner decides on the desk.`
          : `${card.ref} already went back to the BA once: the owner decides on the desk.`,
    };
  }
  // The event comes first, so the record exists ('with_ba') when the move runs and the task is built.
  const wf = await loadWorkflowById(tx, card.workflow_version_id);
  const initial = wf?.definition.initialStage as string;
  const taskId = randomUUID();
  await ctx.store.append([requested({ taskId })], { tx });
  await moveCardIn(
    ctx,
    tx,
    by.user,
    card,
    initial,
    "Over budget: back to the BA to split along the architect's seams",
    { actor: by.actor, by: by.name },
  );
  const fresh = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [card.id])) as Row;
  const queued = await queueSpecCardTask(ctx, tx, fresh, by.actor, taskId);
  await ctx.store.append(
    [
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        [
          `${card.ref} is over its size budget: back to the BA to split it (the one return this card gets).`,
          `Why: ${stored.reason}`,
          ...needsSplitProposalLines(stored),
        ].join('\n'),
        { taskId: queued.taskId },
      ),
    ],
    { tx },
  );
  return {
    cardId: card.id,
    route,
    reason,
    taskId: queued.taskId,
    notice: `${card.ref} went back to the BA to be split along the architect's seams.`,
  };
}

/** `POST /api/cards/:id/needs-split`: the project owner or a manager confirms needs split on an over-budget card. */
export async function confirmNeedsSplit(
  ctx: Ctx,
  user: AuthSession['user'],
  idOrRef: string,
  proposal: NeedsSplitProposal,
): Promise<NeedsSplitResult> {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, user, idOrRef);
    return requestNeedsSplitIn(ctx, tx, card, proposal, {
      actor: userActor(user.id),
      user,
      name: user.displayName,
    });
  });
}

/**
 * The owner item for a card that was with the BA and could not be split (the BA failed, or no BA took the task): the
 * record goes to `owner` and the card stays a draft in the first stage until the owner decides. Appends in `tx`.
 */
export async function needsSplitBaFailedIn(
  ctx: Ctx,
  tx: Tx,
  card: Row,
  why: string,
  reason: 'ba_failed' | 'no_ba' = 'ba_failed',
): Promise<void> {
  const rec = needsSplitRecord(card);
  if (!rec) return;
  const hasBa = await hasActiveBa(tx, card.org_id);
  const q = needsSplitDecisionEvents(card, rec.proposal, reason, rec.fromStage, hasBa);
  await ctx.store.append(
    [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardNeedsSplitResolved',
          payload: { cardId: card.id, outcome: 'ba_failed', note: why.slice(0, 4000) },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(card.org_id, card.project_id),
      },
      ...q.events,
      cardMessage(
        card,
        { kind: 'system' },
        'system',
        `${card.ref} was not split: ${why}. The owner decides on the desk.`,
        { deskItemId: q.deskItemId },
      ),
    ],
    { tx },
  );
}

/**
 * The answer to a `needs_split_decision` item, in the answer's transaction: `continue` keeps the card as one (back to
 * the stage it came from when it waits in the first stage), `ba_again` sends it to the BA anyway, `cancel` cancels it.
 */
export async function needsSplitAnswered(
  ctx: Ctx,
  tx: Tx,
  item: Row,
  optionId: string | undefined,
  answer: string,
  by: NeedsSplitBy,
): Promise<void> {
  if (item.subkind !== NEEDS_SPLIT_DESK_SUBKIND || !item.card_id) return;
  const card = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [item.card_id]);
  if (!card) return;
  const choice = optionId ?? NEEDS_SPLIT_OPTIONS.continue;
  const author =
    by.actor.kind === 'user' ? { kind: 'user' as const, userId: by.user.id } : { kind: 'system' as const };
  if (['done', 'cancelled'].includes(card.status)) {
    await ctx.store.append(
      [
        cardMessage(
          card,
          author,
          'comment',
          `The size decision ("${choice}") was not carried out: ${card.ref} is ${card.status}.`,
        ),
      ],
      { tx },
    );
    return;
  }
  const data = (item.data ?? {}) as { proposal?: StoredNeedsSplitProposal; fromStage?: string };
  const scope = projectScope(card.org_id, card.project_id);
  const resolved = (outcome: 'owner_continue' | 'owner_cancel'): AppendInput => ({
    streamId: streamId.card(card.id),
    event: {
      type: 'CardNeedsSplitResolved',
      payload: { cardId: card.id, outcome, ...(answer ? { note: answer.slice(0, 4000) } : {}) },
    },
    actor: by.actor,
    scope,
  });
  if (choice === NEEDS_SPLIT_OPTIONS.cancel) {
    await ctx.store.append([resolved('owner_cancel')], { tx });
    await cancelCardIn(ctx, tx, by.user, card, `cancelled over its size budget: ${answer}`, {
      actor: by.actor,
    });
    return;
  }
  if (choice === NEEDS_SPLIT_OPTIONS.baAgain && data.proposal) {
    await requestNeedsSplitIn(ctx, tx, card, data.proposal, by, {
      force: true,
      answering: item.id as string,
      ...(data.fromStage ? { fromStage: data.fromStage } : {}),
    });
    return;
  }
  await ctx.store.append(
    [
      resolved('owner_continue'),
      cardMessage(card, author, 'comment', `The owner keeps ${card.ref} as one card: finish the design.`),
    ],
    { tx },
  );
  const wf = await loadWorkflowById(tx, card.workflow_version_id);
  const back = data.fromStage;
  if (wf && back && card.stage === wf.definition.initialStage && back !== card.stage) {
    const fresh = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [card.id])) as Row;
    await moveCardIn(ctx, tx, by.user, fresh, back, 'The owner keeps it as one card', {
      actor: by.actor,
      by: by.name,
    });
  }
}
