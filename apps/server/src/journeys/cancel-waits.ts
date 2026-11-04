import { streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { revokeClientLinkIn } from '../commands/public-forms.ts';
import { projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { resolveDeskEvent } from './desk.ts';

/**
 * Ends the open wait and the pending webhook call of an instance (the journey was cancelled): one `JourneyWaitCancelled`
 * (so no wait ends without an event), the open client link revoked, a call that is not finished marked failed.
 */
export async function cancelWaitsIn(tx: Tx, ctx: Ctx, inst: Row, reason: string): Promise<void> {
  const events: AppendInput[] = [];
  const stream = streamId.journeyInstance(inst.id);
  const scope = projectScope(inst.org_id, inst.project_id);
  const waits = await rows(tx, `SELECT * FROM journey_waits WHERE instance_id=$1 AND status IN ('open','escalated') FOR UPDATE`, [
    inst.id,
  ]);
  for (const w of waits) {
    events.push({
      streamId: stream,
      event: { type: 'JourneyWaitCancelled', payload: { waitId: w.id, reason } },
      actor: SYSTEM_ACTOR,
      scope,
    });
    const formId = (w.config as { waitFor?: { formId?: string } })?.waitFor?.formId;
    if (w.link_id && formId)
      await revokeClientLinkIn(tx, ctx, { orgId: inst.org_id, formId, linkId: w.link_id, by: inst.started_by });
    const openItems = await rows(tx, `SELECT id FROM desk_items WHERE status='open' AND data->>'waitId'=$1`, [w.id]);
    for (const d of openItems) events.push(resolveDeskEvent(inst, d.id as string, 'dismissed', 'The journey was cancelled.'));
  }
  const call = await one(tx, `SELECT * FROM journey_webhook_calls WHERE instance_id=$1 AND status IN ('pending','dispatched')`, [inst.id]);
  if (call)
    events.push({
      streamId: stream,
      event: { type: 'JourneyWebhookCallFinished', payload: { callId: call.id, ok: false, attempts: call.attempts } },
      actor: SYSTEM_ACTOR,
      scope,
    });
  if (events.length) await ctx.store.append(events, { tx });
}
