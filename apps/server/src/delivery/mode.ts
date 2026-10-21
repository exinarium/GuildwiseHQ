import { iso, type Queryable, rows } from '../db/sql.ts';

/** The reasons written on `DeliveryModeSet` when the owner flips the Releases switch. Everything else (reset, stop guided) has none. */
export const RELEASES_PAUSED_REASON = 'releases paused by the owner';
export const RELEASES_RESUMED_REASON = 'releases turned on by the owner';

export interface ModeChange {
  at: string;
  mode: 'instructions' | 'recipe';
  by: string | null;
  reason: string | null;
}

/** The newest mode changes of a project, with who made them. Replay-safe: it reads the log, nothing is stored apart from it. */
export async function modeHistory(db: Queryable, projectId: string, limit = 10): Promise<ModeChange[]> {
  const r = await rows(
    db,
    `SELECT e.created_at, e.payload, u.display_name FROM events e
       LEFT JOIN users u ON u.id = e.actor_id AND e.actor_kind = 'user'
      WHERE e.type='DeliveryModeSet' AND e.project_id=$1 ORDER BY e.seq DESC LIMIT $2`,
    [projectId, limit],
  );
  return r.map((x) => ({
    at: iso(x.created_at) as string,
    mode: x.payload.mode === 'recipe' ? 'recipe' : 'instructions',
    by: x.display_name ?? null,
    reason: typeof x.payload.reason === 'string' ? x.payload.reason : null,
  }));
}

/** Releases are paused when the owner's own switch put the project in instructions mode, and nothing has changed it since. */
export async function releasesPaused(db: Queryable, projectId: string): Promise<boolean> {
  const [last] = await modeHistory(db, projectId, 1);
  return last?.mode === 'instructions' && last.reason === RELEASES_PAUSED_REASON;
}
