import { type RepoSyncStatus, RepoSyncStatusSchema } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { exec, one, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { requestReleaseFacts } from '../release/facts.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';

/**
 * The local working branch against origin (backlog #57). The runner fetches, fast-forwards when that is safe and
 * reports the facts; the server stores the latest per workstation and repository and relays "Sync now".
 */

/** How old a stored check may be before the hello-time pass asks the runner again. */
const FRESH_MS = 10 * 60_000;

/** `repo.sync_status` (periodic check) or the result of `repo.sync`: stores the latest state. Invalid input is dropped. */
export async function applyRepoSyncStatus(ctx: Ctx, workstationId: string, raw: unknown): Promise<void> {
  const p = RepoSyncStatusSchema.safeParse(raw);
  if (!p.success) return;
  const s: RepoSyncStatus = p.data;
  const repo = await one(ctx.pool, 'SELECT 1 FROM project_repos WHERE id=$1', [s.repoId]);
  if (!repo) return;
  await exec(
    ctx.pool,
    `INSERT INTO repo_sync_status (workstation_id, project_repo_id, working_branch, state, ahead, behind, dirty,
                                   on_branch, checked_out_branch, detail, checked_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (workstation_id, project_repo_id) DO UPDATE SET working_branch=EXCLUDED.working_branch,
       state=EXCLUDED.state, ahead=EXCLUDED.ahead, behind=EXCLUDED.behind, dirty=EXCLUDED.dirty,
       on_branch=EXCLUDED.on_branch, checked_out_branch=EXCLUDED.checked_out_branch, detail=EXCLUDED.detail,
       checked_at=EXCLUDED.checked_at`,
    [
      workstationId,
      s.repoId,
      s.workingBranch,
      s.state,
      s.ahead,
      s.behind,
      s.dirty,
      s.onBranch,
      s.checkedOutBranch,
      s.detail ?? null,
      s.checkedAt,
    ],
  );
  // The heartbeat doubles as the "working branch ahead of main" trigger (throttled to 30 minutes per repository).
  await requestReleaseFacts(ctx, s.repoId, 'sync', { workstationId }).catch((err) =>
    ctx.log.error({ err }, 'release facts request failed'),
  );
}

/** Queues `repo.sync` for one clone (the runner knows its path from the remote). */
async function queueSync(ctx: Ctx, workstationId: string, repoId: string): Promise<boolean> {
  const r = await one(
    ctx.pool,
    `SELECT remote_url_normalized, working_branch FROM project_repos
      WHERE id=$1 AND removed_at IS NULL AND working_branch IS NOT NULL`,
    [repoId],
  );
  if (!r) return false;
  const pending = await one(
    ctx.pool,
    `SELECT 1 FROM runner_commands WHERE workstation_id=$1 AND type='repo.sync' AND status IN ('pending','sent')
        AND payload->>'repoId' = $2`,
    [workstationId, repoId],
  );
  if (pending) return true;
  await enqueueRunnerCommand(ctx.pool, workstationId, 'repo.sync', {
    repoId,
    remoteUrlNormalized: r.remote_url_normalized,
    workingBranch: r.working_branch,
  });
  return true;
}

/** "Sync now" (the workstation's owner). */
export async function requestRepoSync(
  ctx: Ctx,
  user: AuthSession['user'],
  input: { repoId: string; workstationId: string },
): Promise<void> {
  const w = await one(
    ctx.pool,
    `SELECT w.id FROM workstations w JOIN workstation_repos wr ON wr.workstation_id = w.id AND wr.project_repo_id = $3
      WHERE w.id=$1 AND w.user_id=$2 AND w.status='active'`,
    [input.workstationId, user.id, input.repoId],
  );
  if (!w) throw notFound('this workstation holds no clone of the repository');
  if (!(await queueSync(ctx, input.workstationId, input.repoId)))
    throw notFound('the repository has no confirmed working branch');
  void Promise.resolve(ctx.services.gateway.deliverPending(input.workstationId)).catch(() => undefined);
}

/**
 * After a workstation's repositories were matched (hello, rescan): asks the runner for a first check of every clone
 * whose working branch is confirmed and not checked within the last 10 minutes. This also tells the runner which
 * branch to keep in step; it then repeats the check on its own.
 */
export async function seedRepoSync(ctx: Ctx, workstationId: string): Promise<void> {
  const stale = await rows(
    ctx.pool,
    `SELECT wr.project_repo_id FROM workstation_repos wr
       JOIN project_repos pr ON pr.id = wr.project_repo_id AND pr.removed_at IS NULL AND pr.working_branch IS NOT NULL
       LEFT JOIN repo_sync_status s ON s.workstation_id = wr.workstation_id AND s.project_repo_id = wr.project_repo_id
      WHERE wr.workstation_id=$1 AND (s.checked_at IS NULL OR s.checked_at < $2 OR s.working_branch <> pr.working_branch)`,
    [workstationId, new Date(ctx.clock.now().getTime() - FRESH_MS)],
  );
  for (const r of stale) await queueSync(ctx, workstationId, r.project_repo_id as string);
}
