import type { Queryable } from '../db/sql.ts';
import { one } from '../db/sql.ts';
import { type CeoFailures, startBackoffMs } from './shift.ts';

/** Why a reachable CEO is not starting a shift right now (backlog #82): shown on the Overview and in the desk notice. */
export interface CeoGate {
  code: 'backoff' | 'running' | 'cap';
  text: string;
  /** When the dispatcher may try again (null: when the running shift ends). */
  until: Date | null;
}

/**
 * Batches that count against `maxWakesPerHour`: those that actually ran. A shift the runner never started (rejected,
 * lost), one that was stopped or released, and a failed batch with no recorded outcome (written by a server before #79)
 * proved nothing and must not use the hour up. In production 12 such batches blocked the CEO for an hour, silently.
 */
export const COUNTED_BATCH_SQL = `NOT (status = 'failed' AND (outcome IS NULL OR outcome IN ('rejected','lost','stopped','released')))`;

const hhmm = (d: Date): string => `${d.toISOString().slice(11, 16)} UTC`;

/** The first thing that keeps the dispatcher from starting a CEO shift now, or null. Shared by `ceoPass` and the Overview. */
export async function ceoGate(
  db: Queryable,
  orgId: string,
  maxWakesPerHour: number,
  failures: CeoFailures,
  now: Date,
): Promise<CeoGate | null> {
  if (failures.startFailures > 0 && failures.lastAt) {
    const until = new Date(new Date(failures.lastAt).getTime() + startBackoffMs(failures.startFailures));
    if (until.getTime() > now.getTime())
      return {
        code: 'backoff',
        text: `waiting: backoff until ${hhmm(until)} after ${failures.startFailures} shift${failures.startFailures === 1 ? '' : 's'} the runner did not start (${failures.lastError ?? 'unknown reason'})`,
        until,
      };
  }
  const running = await one(
    db,
    `SELECT 1 FROM shifts WHERE org_id=$1 AND kind='ceo' AND status <> 'ended' LIMIT 1`,
    [orgId],
  );
  if (running)
    return { code: 'running', text: 'a CEO shift is running; the next one starts after it', until: null };
  const cap = await one<{ n: string; oldest: Date | null }>(
    db,
    `SELECT count(*)::text AS n, min(created_at) AS oldest FROM ceo_batches WHERE org_id=$1 AND created_at > $2 AND ${COUNTED_BATCH_SQL}`,
    [orgId, new Date(now.getTime() - 3_600_000)],
  );
  if (Number(cap?.n ?? 0) >= maxWakesPerHour) {
    const until = new Date(new Date(cap?.oldest ?? now).getTime() + 3_600_000);
    return {
      code: 'cap',
      text: `waiting: hourly limit reached (${cap?.n} of ${maxWakesPerHour} shifts in the last hour), next shift at ${hhmm(until)}`,
      until,
    };
  }
  return null;
}
