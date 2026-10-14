import { RUN_WORKTREE_KEEP_HOURS, SWEEP_QUERY_MAX_PATHS } from '@aom/shared';
import { one, type Queryable, rows } from '../db/sql.ts';

/** `<worktrees>/<KEY>-<project>/run-<first 8 hex of the environment id>` */
const RUN_DIR = /[\\/]run-([0-9a-f]{8})$/;

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
  now: Date = new Date(),
): Promise<string[]> {
  if (paths.length === 0) return [];
  const cardPaths = paths.filter((p) => !RUN_DIR.test(p));
  const live: string[] = [];
  // Run environment folders (`<project>/run-<first 8 of the env id>`, backlog #58): live while the environment runs or
  // while a manual one keeps its worktrees for a restart. Unknown to the server: not live.
  for (const p of paths.filter((x) => RUN_DIR.test(x)).slice(0, SWEEP_QUERY_MAX_PATHS)) {
    const prefix = RUN_DIR.exec(p)?.[1] as string;
    const env = await one(
      db,
      `SELECT 1 AS x FROM run_environments
        WHERE workstation_id=$1 AND id::text LIKE $2
          AND (state NOT IN ('stopped','failed')
               OR (purpose='manual' AND state='stopped' AND stop_reason IN ('stopped','ttl') AND plan_version IS NOT NULL
                   AND stopped_at > $3))`,
      [workstationId, `${prefix}%`, new Date(now.getTime() - RUN_WORKTREE_KEEP_HOURS * 3600_000)],
    );
    if (env) live.push(p);
  }
  if (cardPaths.length === 0) return live;
  const r = await rows<{ worktree_path: string }>(
    db,
    `SELECT DISTINCT c.worktree_path FROM cards c
      WHERE c.worktree_path = ANY($1::text[]) AND c.home_workstation_id = $2
        AND (${LIVE_CARD} OR EXISTS (
              SELECT 1 FROM cards d WHERE d.worktree_card_id = c.id AND d.status NOT IN ('done','cancelled')))`,
    [cardPaths.slice(0, SWEEP_QUERY_MAX_PATHS), workstationId],
  );
  return [...live, ...r.map((x) => x.worktree_path)];
}
