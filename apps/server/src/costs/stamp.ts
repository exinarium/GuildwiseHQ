import { costUsdMicros, isCostUnknown, isOwnerPriced, type OwnerModelPrice } from '@aom/shared';
import { one, rows } from '../db/sql.ts';
import type { Interceptor } from '../eventstore/pg-event-store.ts';

/**
 * Stamps the price on cost-bearing events as they are appended (`ShiftEnded`, `ShiftUsageRecorded`), computed with the
 * default table as it is now. The costs projection uses a stamped `costMicros` as is, so a later change to the price
 * table never reprices these shifts on a projection rebuild. Events appended before stamping existed carry no price and
 * are still priced from the table on replay. Events that already carry one (a super admin's price, a test) are kept.
 */
export function createCostStampInterceptor(): Interceptor {
  return async (tx, inputs) => {
    const out = [];
    // The organization's own prices for models the tables do not know (read once per append, only if one is needed).
    const owned = new Map<string, OwnerModelPrice[]>();
    const ownerPrices = async (orgId: string | null | undefined): Promise<OwnerModelPrice[]> => {
      if (!orgId) return [];
      let list = owned.get(orgId);
      if (!list) {
        list = (
          await rows<{
            provider: string;
            model: string;
            input_per_mtok: string;
            output_per_mtok: string;
            cache_read_per_mtok: string | null;
          }>(
            tx,
            'SELECT provider, model, input_per_mtok, output_per_mtok, cache_read_per_mtok FROM org_model_prices WHERE org_id=$1',
            [orgId],
          )
        ).map((r) => ({
          provider: r.provider,
          model: r.model,
          inputPerMtok: Number(r.input_per_mtok),
          outputPerMtok: Number(r.output_per_mtok),
          cacheReadPerMtok: r.cache_read_per_mtok === null ? null : Number(r.cache_read_per_mtok),
        }));
        owned.set(orgId, list);
      }
      return list;
    };
    for (const input of inputs) {
      const ev = input.event;
      if (
        (ev.type === 'ShiftEnded' || ev.type === 'ShiftUsageRecorded') &&
        ev.payload.costMicros === undefined
      ) {
        const s = await one<{ model: string | null }>(tx, 'SELECT model FROM shifts WHERE id=$1', [
          ev.payload.shiftId,
        ]);
        const model = ev.payload.usage.model ?? s?.model;
        if (model) {
          const owner = await ownerPrices(input.scope.orgId);
          const ownerPriced = isOwnerPriced(model, owner);
          out.push({
            ...input,
            event: {
              ...ev,
              payload: {
                ...ev.payload,
                ...(ownerPriced ? { usage: { ...ev.payload.usage, ownerPriced: true } } : {}),
                costMicros: costUsdMicros(model, { ...ev.payload.usage }, undefined, owner),
              },
            },
          } as typeof input);
          continue;
        }
      }
      if (ev.type === 'SessionTurnCompleted' && ev.payload.costMicros === undefined) {
        // A discovery or boardroom turn: priced by the model the turn was queued with (it is not a shift).
        const t = await one<{ model: { model?: string } | null }>(
          tx,
          'SELECT model FROM session_turns WHERE id=$1',
          [ev.payload.turnId],
        );
        const model = ev.payload.usage.model ?? t?.model?.model;
        if (model) {
          const owner = await ownerPrices(input.scope.orgId);
          const ownerPriced = isOwnerPriced(model, owner);
          out.push({
            ...input,
            event: {
              ...ev,
              payload: {
                ...ev.payload,
                ...(ownerPriced ? { usage: { ...ev.payload.usage, ownerPriced: true } } : {}),
                costMicros: costUsdMicros(model, { ...ev.payload.usage }, undefined, owner),
                // A direct-model provider's model without a price: 0 here means "unknown", and the pages say so.
                ...(isCostUnknown(model, undefined, owner) ? { costUnknown: true } : {}),
              },
            },
          } as typeof input);
          continue;
        }
      }
      if (ev.type === 'DelegateCompleted' && ev.payload.costMicros === undefined) {
        const model = ev.payload.usage.model;
        if (model) {
          const owner = await ownerPrices(input.scope.orgId);
          const ownerPriced = isOwnerPriced(model, owner);
          out.push({
            ...input,
            event: {
              ...ev,
              payload: {
                ...ev.payload,
                ...(ownerPriced ? { usage: { ...ev.payload.usage, ownerPriced: true } } : {}),
                costMicros: costUsdMicros(model, { ...ev.payload.usage }, undefined, owner),
                ...(isCostUnknown(model, undefined, owner) ? { costUnknown: true } : {}),
              },
            },
          } as typeof input);
          continue;
        }
      }
      out.push(input);
    }
    return out;
  };
}
