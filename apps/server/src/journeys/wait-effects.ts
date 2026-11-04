import { streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { revokeClientLinkIn } from '../commands/public-forms.ts';
import { resolveDeskEvent } from './desk.ts';
import { rows } from '../db/sql.ts';

/** Closes every open desk item that belongs to a wait (the original question, a reminder, an escalation, a link task). */
export async function closeWaitDeskItems(
  ctx: Ctx,
  tx: Tx,
  inst: Row,
  waitId: string,
  resolution: 'acknowledged' | 'dismissed',
  note: string,
  exceptId?: string | null,
): Promise<void> {
  const open = await rows(tx, `SELECT id FROM desk_items WHERE status='open' AND data->>'waitId'=$1 AND id::text<>$2`, [waitId, exceptId ?? '']);
  if (open.length)
    await ctx.store.append(open.map((d) => resolveDeskEvent(inst, d.id as string, resolution, note)), { tx });
}

/**
 * After a wait ended in any way: revoke an unused client link and close the desk task or question that belonged to it.
 * Runs in the same transaction as the resolving event.
 */
export async function endWaitSideEffects(ctx: Ctx, tx: Tx, inst: Row, waitId: string): Promise<void> {
  const w = await one(tx, 'SELECT * FROM journey_waits WHERE id=$1', [waitId]);
  if (!w) return;
  const formId = (w.config as { waitFor?: { formId?: string } })?.waitFor?.formId;
  if (w.link_id && formId)
    await revokeClientLinkIn(tx, ctx, { orgId: inst.org_id, formId, linkId: w.link_id, by: inst.started_by });
  await closeWaitDeskItems(ctx, tx, inst, waitId, 'acknowledged', 'The wait ended.');
  void streamId;
}
