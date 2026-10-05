import { SWEEP_QUERY_MAX_PATHS } from '@aom/shared';
import { type Queryable, rows } from '../db/sql.ts';

/** A card still needs its worktree: not done or cancelled, or done but its finalize (merge, PR) is not finished. */
const LIVE_CARD = `(c.status NOT IN ('done','cancelled')
    OR (c.status = 'done' AND c.finalized_at IS NULL AND c.finalize_state IS NOT NULL))`;

/**
 * `worktrees.query` of a runner (start-up sweep and the hygiene job): which of its card worktrees still belong to a live
 * card of this workstation. Everything else (finalized, cancelled or unknown to the server) is stale. A worktree shared
 * with a live card (`worktree_card_id`) is live.
 */
export async function liveWorktreePaths(
  db: Queryable,
  workstationId: string,
  paths: string[],
): Promise<string[]> {
  if (paths.length === 0) return [];
  const r = await rows<{ worktree_path: string }>(
    db,
    `SELECT DISTINCT c.worktree_path FROM cards c
      WHERE c.worktree_path = ANY($1::text[]) AND c.home_workstation_id = $2
        AND (${LIVE_CARD} OR EXISTS (
              SELECT 1 FROM cards d WHERE d.worktree_card_id = c.id AND d.status NOT IN ('done','cancelled')))`,
    [paths.slice(0, SWEEP_QUERY_MAX_PATHS), workstationId],
  );
  return r.map((x) => x.worktree_path);
}
