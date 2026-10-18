import { budgetPausedSql } from '../costs/index.ts';
import { one, type Queryable } from '../db/sql.ts';

/**
 * Manual project pause (an organization Owner or Admin benched the project: commands/project-pause.ts). The one rule
 * everything that starts work for a project asks, so a gap cannot hide in one query. Stateful on purpose (the column is
 * projected from `ProjectPaused` / `ProjectResumed`), unlike the stateless budget pause it sits next to.
 *
 * What a pause does: nothing NEW starts for the project (claims, question / DevOps / BA shifts, cron schedules, interest
 * scans, CEO wakes and actions, test environments, phase follow-ups, chats). What it never does: kill a running shift,
 * count as a failure (stop-loss, retry and loop-park counters are only touched by shifts and claims, and a refused claim
 * returns before any of them), or drop queued cards (they stay queued and go on at resume).
 */

/** SQL boolean over the projects alias `p`: the project is paused by hand. */
export const projectPausedSql = (p: string): string => `(${p}.paused_at IS NOT NULL)`;

/**
 * SQL boolean over the projects alias `p`: dispatching is held, by the manual pause or by the budget (`now` is a SQL
 * parameter holding the server clock). Used where both rules apply (the dispatcher's candidate query, BA tasks).
 */
export const projectHeldSql = (p: string, now: string): string =>
  `(${projectPausedSql(p)} OR ${budgetPausedSql(p, now)})`;

/** Is the project paused by hand right now? */
export async function isProjectPaused(db: Queryable, projectId: string | null | undefined): Promise<boolean> {
  if (!projectId) return false;
  const r = await one(db, 'SELECT paused_at IS NOT NULL AS paused FROM projects WHERE id = $1', [projectId]);
  return r?.paused === true;
}

/**
 * The project a CEO wake / action subject belongs to is paused. Subjects are `card`, `desk` (item), `project`, and
 * anything else (agents, workstations, tasks, reviews) belongs to no single project and is never held.
 */
export async function subjectProjectPaused(
  db: Queryable,
  subjectKind: string,
  subjectId: string,
): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(subjectId)) return false;
  const sql =
    subjectKind === 'card'
      ? 'SELECT p.paused_at IS NOT NULL AS paused FROM cards c JOIN projects p ON p.id = c.project_id WHERE c.id = $1'
      : subjectKind === 'desk'
        ? 'SELECT p.paused_at IS NOT NULL AS paused FROM desk_items d JOIN projects p ON p.id = d.project_id WHERE d.id = $1'
        : subjectKind === 'project'
          ? 'SELECT paused_at IS NOT NULL AS paused FROM projects WHERE id = $1'
          : null;
  if (!sql) return false;
  return (await one(db, sql, [subjectId]))?.paused === true;
}
