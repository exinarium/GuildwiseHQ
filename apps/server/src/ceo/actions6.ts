import { type CeoActionName, canonicalWorkflowKey, DESK_SUBKIND, isKnownChoice, streamId } from '@aom/shared';
import { z } from 'zod';
import { loadWorkflowById } from '../catalogue/loader.ts';
import { cancelCardIn, moveCard } from '../commands/cards.ts';
import { agentActor, cardMessage, userActor } from '../commands/common.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { HttpError } from '../errors.ts';
import { appendLocked, cardOf, refuse, truncate } from './actions.ts';
import type { ActionDef, ActionEnv } from './types.ts';

/**
 * Card steering the CEO needs to replace the owner: moving a card to the right stage (the Owner's Move button, through
 * the same `moveCard` command and its validation) and running one card on a stronger model.
 */

const subjectOf = (card: Row) => ({
  subjectKind: 'card',
  subjectId: card.id as string,
  subjectLabel: `${card.ref} ${truncate(card.title, 80)}`,
});

/**
 * The stages `moveCard` accepts as a target in the card's workflow: agent and manual stages. A step for a person (manual
 * QA, an approval), a server step and the closing stages open by themselves, so they are never a target.
 */
export async function moveTargets(db: Queryable, card: Row): Promise<{ id: string }[]> {
  const wf = await loadWorkflowById(db, card.workflow_version_id);
  if (!wf) return [];
  const code = canonicalWorkflowKey(wf.definition.key ?? '') === 'code';
  return wf.definition.stages
    .filter((s) => (s.kind === 'agent' || s.kind === 'manual') && !(code && s.id === 'qa_steps'))
    .map((s) => ({ id: s.id }));
}

const listOf = (targets: { id: string }[]): string =>
  targets.length ? targets.map((t) => t.id).join(', ') : 'none (the workflow has no stage to move to)';

// ------------------------------------------------------------------------------------------------- move

const MoveP = z.object({
  card: z.string().min(1).max(40),
  to: z.string().min(1).max(60),
  note: z.string().trim().max(1000).optional(),
});

const move: ActionDef<z.infer<typeof MoveP>> = {
  cls: 'card.move',
  schema: MoveP,
  describe: (p, pr) => `Move ${pr.subjectLabel} to ${p.to}`,
  async prepare(env, p) {
    const card = await cardOf(env.ctx.pool, env, p.card);
    if (!card || card.org_id !== env.orgId) return refuse(`card ${p.card} not found`);
    const base = subjectOf(card);
    if (['done', 'cancelled'].includes(card.status))
      return { ...base, refuse: `the card is ${card.status}; it cannot be moved` };
    const targets = await moveTargets(env.ctx.pool, card);
    if (!targets.some((t) => t.id === p.to))
      return {
        ...base,
        refuse: `'${p.to}' is not a stage ${card.ref} can be moved to (it is at '${card.stage}'). Valid target stages in its workflow: ${listOf(targets)}.`,
      };
    return { ...base, data: { card, targets } };
  },
  async execute(env, p, pr) {
    const card = pr.data?.card as Row;
    const targets = pr.data?.targets as { id: string }[];
    const reason = p.note?.trim() || 'moved by the CEO';
    try {
      await moveCard(env.ctx, env.owner, card.id, p.to, `${reason} (CEO)`, {
        actor: agentActor(env.agentId),
        by: `${env.agentName} (CEO)`,
      });
    } catch (err) {
      // moveCard is the authority (required fields, a person's step, a closed card): its message plus where one may go.
      if (err instanceof HttpError)
        throw new HttpError(
          err.status,
          err.code,
          `${err.message}. Valid target stages for ${card.ref}: ${listOf(targets)}.`,
        );
      throw err;
    }
    env.ctx.services.dispatcher.trigger();
    return {
      message: `${card.ref} moved from ${card.stage} to ${p.to}; it is queued there.`,
      result: { cardId: card.id, from: card.stage, to: p.to },
    };
  },
};

// ------------------------------------------------------------------------------------------- raise model

const RaiseP = z.object({
  card: z.string().min(1).max(40),
  model: z.string().min(1).max(120),
  effort: z.string().min(1).max(20).optional(),
  runtime: z.string().min(1).max(60).optional(),
  note: z.string().trim().max(1000).optional(),
});

const raiseModel: ActionDef<z.infer<typeof RaiseP>> = {
  cls: 'card.raise_model',
  schema: RaiseP,
  describe: (p, pr) => `Run ${pr.subjectLabel} on ${p.model}${p.effort ? ` (${p.effort})` : ''}`,
  async prepare(env, p) {
    const card = await cardOf(env.ctx.pool, env, p.card);
    if (!card || card.org_id !== env.orgId) return refuse(`card ${p.card} not found`);
    const base = subjectOf(card);
    if (['done', 'cancelled'].includes(card.status)) return { ...base, refuse: `the card is ${card.status}` };
    const choice = {
      runtime: p.runtime ?? 'claude-code',
      model: p.model,
      ...(p.effort ? { effort: p.effort } : {}),
    };
    if (!isKnownChoice(choice))
      return {
        ...base,
        refuse: `${p.model}${p.effort ? ` with effort ${p.effort}` : ''} is not a model choice of ${choice.runtime}`,
      };
    return { ...base, data: { card, choice } };
  },
  async execute(env: ActionEnv, p, pr) {
    const card = pr.data?.card as Row;
    const choice = pr.data?.choice as { runtime: string; model: string; effort?: string };
    await appendLocked(env, [
      {
        streamId: streamId.card(card.id),
        event: {
          type: 'CardModelRaised',
          payload: {
            cardId: card.id,
            model: choice.model,
            ...(choice.effort ? { effort: choice.effort } : {}),
            runtime: choice.runtime,
            by: env.owner.id,
            ...(p.note ? { reason: p.note } : {}),
          },
        },
        actor: userActor(env.owner.id),
        scope: { orgId: env.orgId, projectId: card.project_id, audience: 'project' },
      },
      cardMessage(
        card,
        { kind: 'agent', agentId: env.agentId },
        'comment',
        `The CEO raised this card to ${choice.model}${choice.effort ? ` (${choice.effort})` : ''} for its next shifts${p.note ? `: ${p.note}` : '.'}`,
        { viaCeo: true },
      ),
    ]);
    return {
      message: `${card.ref} runs on ${choice.model}${choice.effort ? ` (${choice.effort})` : ''} from its next shift.`,
      result: { cardId: card.id, ...choice },
    };
  },
};

// ---------------------------------------------------------------------------------------- send to tester

const SendToTesterP = z.object({
  card: z.string().min(1).max(40),
  note: z.string().trim().min(3).max(4000),
});

/** The card whose test failed and its open bug cards for a builder: `ref` is the bug card or its parent. */
async function testerTarget(db: Queryable, card: Row): Promise<{ parent: Row | undefined; open: Row[] }> {
  const parent =
    card.origin === 'test_failure' && card.parent_card_id
      ? await one(db, 'SELECT * FROM cards WHERE id=$1', [card.parent_card_id])
      : card;
  if (!parent) return { parent: undefined, open: [] };
  const open = await rows(
    db,
    `SELECT * FROM cards WHERE parent_card_id=$1 AND card_type='bug' AND origin='test_failure'
        AND status NOT IN ('done','cancelled') ORDER BY created_at`,
    [parent.id],
  );
  return { parent, open };
}

const sendToTester: ActionDef<z.infer<typeof SendToTesterP>> = {
  cls: 'card.send_to_tester',
  schema: SendToTesterP,
  describe: (p, pr) => `Send ${pr.subjectLabel} back to the tester: ${truncate(p.note, 100)}`,
  async prepare(env, p) {
    const card = await cardOf(env.ctx.pool, env, p.card);
    if (!card || card.org_id !== env.orgId) return refuse(`card ${p.card} not found`);
    const { parent, open } = await testerTarget(env.ctx.pool, card);
    if (!parent) return { ...subjectOf(card), refuse: 'the card the bug belongs to does not exist' };
    const base = subjectOf(parent);
    if (['done', 'cancelled'].includes(parent.status))
      return { ...base, refuse: `${parent.ref} is ${parent.status}` };
    if (parent.stage !== 'test')
      return {
        ...base,
        refuse: `${parent.ref} is at '${parent.stage}', not in Test: only a card whose test failed goes back to the tester`,
      };
    const question = await one(
      env.ctx.pool,
      `SELECT id FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`,
      [parent.id, DESK_SUBKIND.testerLoop],
    );
    if (question)
      return {
        ...base,
        refuse: `${parent.ref} waits on the tester-loop question ${question.id}: answer it with option 'tester' (and the note as text) instead`,
      };
    return { ...base, data: { parent, open } };
  },
  async execute(env, p, pr) {
    const parent = pr.data?.parent as Row;
    const cancelledRefs: string[] = [];
    const workstations = new Set<string>();
    await withAppendTx(env.ctx.pool, async (tx) => {
      const cur = await one(tx, 'SELECT * FROM cards WHERE id=$1 FOR UPDATE', [parent.id]);
      if (!cur || cur.stage !== 'test' || ['done', 'cancelled'].includes(cur.status))
        throw new HttpError(409, 'not_in_test', `${parent.ref} is no longer in Test`);
      const open = await rows(
        tx,
        `SELECT * FROM cards WHERE parent_card_id=$1 AND card_type='bug' AND origin='test_failure'
            AND status NOT IN ('done','cancelled') ORDER BY created_at FOR UPDATE`,
        [parent.id],
      );
      // The cancellation must not put the parent back in Test on its own (the tester would fail it again before the
      // note arrives): the rework below is the next step.
      for (const child of open) {
        const ws = await cancelCardIn(
          env.ctx,
          tx,
          env.owner,
          child,
          `cancelled by the CEO: the work is in the E2E spec, which only the tester may change. ${p.note}`,
          { keepParentWaiting: true },
        );
        if (ws) workstations.add(ws);
        cancelledRefs.push(child.ref as string);
      }
      const tester = await one<{ agent_id: string }>(
        tx,
        `SELECT agent_id FROM card_handoffs WHERE card_id=$1 AND stage='test' AND agent_id IS NOT NULL
          ORDER BY created_at DESC, event_seq DESC LIMIT 1`,
        [parent.id],
      );
      await env.ctx.store.append(
        [
          {
            streamId: streamId.card(parent.id),
            event: {
              type: 'TestReworkRequested',
              payload: {
                cardId: parent.id,
                testerAgentId: tester?.agent_id ?? env.agentId,
                evidence: { commands: [], summary: p.note, outputExcerpt: '', failureScope: 'e2e_spec' },
                summary: truncate(p.note, 200),
                headSha: null,
                instruction: p.note,
              },
            },
            actor: userActor(env.owner.id),
            scope: { orgId: env.orgId, projectId: parent.project_id, audience: 'project' },
          },
          cardMessage(
            parent,
            { kind: 'agent', agentId: env.agentId },
            'comment',
            `The CEO sent ${parent.ref} back to the tester${cancelledRefs.length ? ` (cancelled ${cancelledRefs.join(', ')})` : ''}. Do the work yourself in this shift: edit the E2E spec or fixtures and run the capture or the suites; report \`--scope e2e-spec\` only when you cannot finish it.\n\n${p.note}`,
            { viaCeo: true, failureScope: 'e2e_spec' },
          ),
        ],
        { tx },
      );
    });
    for (const w of workstations) await env.ctx.services.gateway.deliverPending(w);
    env.ctx.services.dispatcher.trigger();
    return {
      message: `${parent.ref} is back in the Test queue with your note${cancelledRefs.length ? `; ${cancelledRefs.join(', ')} cancelled` : ''}.`,
      result: { cardId: parent.id, cancelled: cancelledRefs },
    };
  },
};

export const ACTIONS6: Partial<Record<CeoActionName, ActionDef>> = {
  move,
  'raise-model': raiseModel,
  'send-to-tester': sendToTester,
};
