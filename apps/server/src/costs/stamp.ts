import { costUsdMicros } from '@aom/shared';
import { one } from '../db/sql.ts';
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
          out.push({
            ...input,
            event: {
              ...ev,
              payload: { ...ev.payload, costMicros: costUsdMicros(model, { ...ev.payload.usage }) },
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
