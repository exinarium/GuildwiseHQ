import type { StopLossBudget } from '@aom/shared';
import { stopLossBudget } from '../commands/stop-loss.ts';
import type { Queryable, Row } from '../db/sql.ts';

/**
 * Fix stop-loss of platform bug cards (owner decision: small 2 rework rounds / 2 reviews / 10 shifts, medium 3/2/15,
 * large 4/2/25; then architect arbitration, then the owner on the platform organisation's desk).
 *
 * The mechanism is S1a's (`commands/stop-loss.ts`): at the cap the card is parked with a blocking `stop_loss` question to
 * the card's architect, and an unresolved one escalates to the desk, which for the platform project is the platform
 * organisation's desk. The only platform-specific part is the SIZE: the architect sets the fix size in triage
 * (`platform_bugs.fix_size`, default medium) and `stopLossBudget` reads it for platform bug cards. This one function is
 * where the platform asks for a fix card's budget.
 */
export function platformFixBudget(db: Queryable, card: Row): Promise<StopLossBudget> {
  return stopLossBudget(db, card);
}
