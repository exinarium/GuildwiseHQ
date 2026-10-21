import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { userActor } from './common.ts';
import { hasActiveBa, missingText, queueSpecCardTask, splitMissing } from './spec-card.ts';

/**
 * What became of a draft that `specify:true` could not specify: the BA completes it when it can (a `spec_card` task), and
 * the caller is told plainly when it cannot (a missing repository needs a person; no BA means "hire one").
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
  const { other } = await splitMissing(tx, card, missing);
  if (other.length)
    return {
      queued: false,
      text: `it stays a draft: it needs ${missingText(other)}, which only a person can add (the BA cannot)`,
    };
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
  const next = r.missing?.length ? await completeDraft(ctx, tx, orgId, owner, r.cardId, r.missing) : undefined;
  const card = await one(tx, 'SELECT ref FROM cards WHERE id=$1', [r.cardId]);
  return { cardId: r.cardId, ref: card?.ref as string | undefined, next };
}
