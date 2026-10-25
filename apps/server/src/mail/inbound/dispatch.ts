import type { Ctx } from '../../context.ts';
import { type IngestOutcome, ingestInbound } from './ingest.ts';
import type { NormalizedInbound } from './types.ts';

/**
 * Where an inbound mail goes. The core delivers it to the organizations' inboxes; an extension may take some of it first
 * (a hosted support desk answers `support@`) and hand the rest on through `next`.
 */
export function dispatchInbound(ctx: Ctx, m: NormalizedInbound): Promise<IngestOutcome[]> {
  const next = (mail: NormalizedInbound) => ingestInbound(ctx, mail);
  const ext = ctx.ext.list.find((e) => e.dispatchInbound);
  return ext?.dispatchInbound ? ext.dispatchInbound(ctx, m, next) : next(m);
}
