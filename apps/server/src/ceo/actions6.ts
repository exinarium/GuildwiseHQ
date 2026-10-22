import { type CeoActionName, canonicalWorkflowKey, isKnownChoice, streamId } from '@aom/shared';
import { z } from 'zod';
import { loadWorkflowById } from '../catalogue/loader.ts';
import { moveCard } from '../commands/cards.ts';
import { agentActor, cardMessage, userActor } from '../commands/common.ts';
import type { Queryable, Row } from '../db/sql.ts';
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

export const ACTIONS6: Partial<Record<CeoActionName, ActionDef>> = {
  move,
  'raise-model': raiseModel,
};
