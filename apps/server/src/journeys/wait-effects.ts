import { streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { revokeClientLinkIn } from '../commands/public-forms.ts';
import { resolveDeskEvent } from './desk.ts';

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
  if (w.desk_item_id) {
    const d = await one(tx, 'SELECT status FROM desk_items WHERE id=$1', [w.desk_item_id]);
    if (d?.status === 'open')
      await ctx.store.append([resolveDeskEvent(inst, w.desk_item_id, 'acknowledged', 'The wait ended.')], { tx });
  }
  void streamId;
}
