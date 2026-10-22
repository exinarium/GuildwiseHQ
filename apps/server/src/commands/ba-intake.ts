import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict } from '../errors.ts';
import { loadManageable } from './cards.ts';
import { userActor } from './common.ts';
import {
  cardMissing,
  hasActiveBa,
  missingText,
  queueSpecCardTask,
  scopingAgentRole,
  splitMissing,
} from './spec-card.ts';

/**
 * What became of a draft that `specify:true` could not specify: the BA completes it when it can (a `spec_card` task), and
 * the caller is told plainly when it cannot (no BA means "hire one"; a missing completion action needs a person). A missing
 * repository in a project with several is the BA's too: it finds the repository (or splits the card) through the code graph,
 * and an architect does it when there is no BA or the graph cannot serve. Nobody is ever asked to pick a repository.
 */
export async function completeDraft(
  ctx: Ctx,
  tx: Tx,
  orgId: string,
  owner: AuthSession['user'],
  cardId: string,
  missing: string[],
): Promise<{ queued: boolean; text: string }> {
  const card = (await one(tx, 'SELECT * FROM cards WHERE id=$1', [cardId])) as Row;
  const { other, scoping } = await splitMissing(tx, card, missing);
  if (other.length)
    return {
      queued: false,
      text: `it stays a draft: it needs ${missingText(other)}, which only a person can add (the BA cannot)`,
    };
  if (scoping) {
    const by = await scopingAgentRole(ctx, tx, card);
    if (!by)
      return {
        queued: false,
        text: `it stays a draft: it has no repository, the project has several, and there is no BA or architect to find it. Recommend hiring a BA`,
      };
    await queueSpecCardTask(ctx, tx, card, userActor(owner.id));
    return {
      queued: true,
      text: `sent to the ${by === 'ba' ? 'BA' : 'architect'} to find the repository and complete: ${missingText(missing)}`,
    };
  }
  if (!(await hasActiveBa(tx, orgId)))
    return {
      queued: false,
      text: `it stays a draft: missing ${missingText(missing)} and there is no BA to write it. Recommend hiring a BA`,
    };
  await queueSpecCardTask(ctx, tx, card, userActor(owner.id));
  return { queued: true, text: `sent to the BA to complete: ${missingText(missing)}` };
}

/**
 * The CEO's intake and Send to BA: a draft card with the given context, which the BA completes and specifies (a
 * `spec_card` task). The card ref exists when this returns, inside the caller's transaction.
 */
export async function baIntakeIn(
  ctx: Ctx,
  tx: Tx,
  orgId: string,
  owner: AuthSession['user'],
  req: {
    projectId: string;
    title: string;
    text: string;
    cardType?: string;
    priority?: number;
    ticket?: string;
    investigation?: boolean;
  },
): Promise<{
  cardId: string;
  ref: string | undefined;
  next: { queued: boolean; text: string } | undefined;
}> {
  const { createCardIn } = await import('./cards.ts');
  const r = await createCardIn(ctx, tx, owner, {
    projectId: req.projectId,
    title: req.title,
    cardType: req.cardType ?? 'feature',
    fields: { context: req.text, ...(req.ticket ? { externalRef: req.ticket } : {}) },
    specify: true,
    ...(req.priority ? { priority: req.priority } : {}),
    ...(req.investigation ? { investigationOnly: true } : {}),
  } as never);
  const next = r.missing?.length
    ? await completeDraft(ctx, tx, orgId, owner, r.cardId, r.missing)
    : undefined;
  const card = await one(tx, 'SELECT ref FROM cards WHERE id=$1', [r.cardId]);
  return { cardId: r.cardId, ref: card?.ref as string | undefined, next };
}

/**
 * "Send to BA" on a draft card page: the BA completes what the card lacks, a missing repository in a project with several
 * included (it finds the repository or splits the card). The text says what became of it.
 */
export async function sendCardToBa(
  ctx: Ctx,
  owner: AuthSession['user'],
  idOrRef: string,
): Promise<{ cardId: string; next: { queued: boolean; text: string } }> {
  return withAppendTx(ctx.pool, async (tx) => {
    const card = await loadManageable(tx, owner, idOrRef);
    if (card.status !== 'draft') throw conflict('not_draft', 'only a draft card can be sent to the BA');
    const missing = await cardMissing(tx, card);
    if (missing.length === 0)
      throw conflict('nothing_missing', `${card.ref} has everything it needs: specify it instead`);
    return {
      cardId: card.id as string,
      next: await completeDraft(ctx, tx, card.org_id, owner, card.id, missing),
    };
  });
}
