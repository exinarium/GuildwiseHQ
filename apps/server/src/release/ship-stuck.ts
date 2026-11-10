import type { Ctx } from '../context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { appendReleaseFailure, cancelLiveShipCommands } from './ship.ts';

/** A ship has to sit in 'committing' this long, and a just-answered command this long ago, before it counts as stuck. */
export const RELEASE_SHIP_STUCK_GRACE_SECONDS = 120;
/** A pending or sent command on a workstation that has not been seen for this long will not be answered. */
export const RELEASE_SHIP_OFFLINE_SECONDS = 1800;

export const RELEASE_SHIP_LOST_TEXT =
  'The workstation stopped answering while it prepared the release commit (it went offline, was removed or lost the request) and never reported a result. If the commit was already pushed, Retry recognises it and makes nothing twice.';

/**
 * No `release.ship` of the ship (alias `s`) can still produce a result: none is pending or sent on an active workstation
 * that is connected or was seen recently, and none was answered within the grace period (its result may still be
 * being applied). $1 = now, $2 = grace seconds, $3 = offline seconds.
 */
const NO_LIVE_COMMAND = `NOT EXISTS (
  SELECT 1 FROM runner_commands rc JOIN workstations w ON w.id = rc.workstation_id
   WHERE rc.type = 'release.ship' AND rc.payload->>'shipId' = s.id::text
     AND ((rc.status IN ('pending','sent') AND w.status = 'active'
           AND (w.connected OR w.last_seen_at > $1::timestamptz - make_interval(secs => $3)))
          OR GREATEST(rc.done_at, rc.answering_at) > $1::timestamptz - make_interval(secs => $2)))`;

const STUCK_WHERE = `s.status = 'committing' AND p.state = 'approved'
  AND s.updated_at < $1::timestamptz - make_interval(secs => $2) AND ${NO_LIVE_COMMAND}`;

async function stuckShips(db: Queryable, now: Date, shipId?: string): Promise<{ id: string }[]> {
  return rows<{ id: string }>(
    db,
    `SELECT s.id FROM release_ships s JOIN release_proposals p ON p.id = s.id
      WHERE ${STUCK_WHERE} ${shipId ? 'AND s.id = $4' : ''}`,
    [now, RELEASE_SHIP_STUCK_GRACE_SECONDS, RELEASE_SHIP_OFFLINE_SECONDS, ...(shipId ? [shipId] : [])],
  );
}

/**
 * A ship left in 'committing' whose runner was lost mid-step (its command will never produce a result) becomes a
 * normal stopped release: `ReleaseFailed` at step 'prepare' and the "Release stopped" alert with Retry and Dismiss.
 * While the command is live, nothing happens, so Retry is not offered while the runner is still working.
 */
export async function releaseShipStuckChecks(ctx: Ctx): Promise<void> {
  const candidates = await stuckShips(ctx.pool, ctx.clock.now());
  for (const c of candidates) {
    await withAppendTx(ctx.pool, async (tx) => {
      const ship = await one(tx, 'SELECT * FROM release_ships WHERE id=$1 FOR UPDATE', [c.id]);
      if (ship?.status !== 'committing') return;
      const now = ctx.clock.now();
      // re-checked under the lock: a result applied meanwhile moved the ship on
      if (!(await stuckShips(tx, now, c.id)).length) return;
      await cancelLiveShipCommands(tx, ship.id, 'the release was marked stopped; Retry sends it again', now);
      await appendReleaseFailure(ctx, tx, ship, 'prepare', RELEASE_SHIP_LOST_TEXT, false);
    }).catch((err) => ctx.log.error({ err, shipId: c.id }, 'stuck release check failed'));
  }
}
