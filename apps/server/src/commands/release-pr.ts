import { randomUUID } from 'node:crypto';
import { type ReleasePrRequested, RepoOpenPrResultSchema } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';

/**
 * "Open a pull request from the working branch to the main branch" (project settings, owner only). The pull request
 * goes from the repository's working branch (where card work is integrated) to its main branch (default: the
 * repository's default branch). A workstation that has the repository opens it through the repository's git host
 * (`repo.open_pr`); the settings page polls the stored answer (`releasePr` on the repository).
 */
export async function requestReleasePr(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  repoId: string,
): Promise<ReleasePrRequested> {
  const now = ctx.clock.now();
  const out = await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const repo = await one(
      tx,
      'SELECT * FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
      [repoId, projectId],
    );
    if (!repo) throw notFound('repository not found');
    const head: string = repo.working_branch ?? p.working_branch;
    if (repo.main_branch && repo.main_branch === head)
      throw conflict(
        'same_branch',
        `The working branch and the main branch are both ${head}: there is nothing to open a pull request between.`,
      );
    // The owner's own workstation first; otherwise any active workstation that has a clone of the repository.
    const ws = await one(
      tx,
      `SELECT w.id FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
        WHERE wr.project_repo_id=$1 AND w.status='active'
        ORDER BY (w.user_id = $2) DESC, w.last_seen_at DESC NULLS LAST LIMIT 1`,
      [repoId, user.id],
    );
    if (!ws)
      throw conflict(
        'no_clone',
        'No workstation has this repository yet. Wait for the clone to finish (see the repository status above), then try again.',
      );
    const requestId = randomUUID();
    await exec(
      tx,
      `INSERT INTO repo_pr_requests (request_id, project_id, repo_id, workstation_id, requested_by, head, base, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
      [requestId, projectId, repoId, ws.id, user.id, head, repo.main_branch ?? null, now],
    );
    await enqueueRunnerCommand(tx, ws.id, 'repo.open_pr', {
      requestId,
      projectId,
      repoId,
      remoteUrlNormalized: repo.remote_url_normalized,
      head,
      ...(repo.main_branch ? { base: repo.main_branch } : {}),
      title: `Merge ${head} into ${repo.main_branch ?? 'the main branch'}`,
      body: `Brings the work integrated on ${head} into ${repo.main_branch ?? 'the main branch'}.`,
      ...(repo.forge_kind ? { forge: repo.forge_kind } : {}),
    });
    return { requestId, workstationId: ws.id as string };
  });
  void Promise.resolve(ctx.services.gateway.deliverPending(out.workstationId)).catch(() => undefined);
  return { requestId: out.requestId };
}

/** `command.result` of `repo.open_pr`: stored for the settings page. */
export async function applyReleasePrResult(
  ctx: Ctx,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const parsed = RepoOpenPrResultSchema.safeParse(result);
  const r = ok && parsed.success ? parsed.data : undefined;
  const state = !r || !r.ok ? 'failed' : r.url ? 'opened' : r.nothingToDo ? 'nothing' : 'opened';
  const message = r
    ? (r.error ?? r.notice ?? null)
    : (error ?? 'the workstation could not open the pull request');
  await exec(
    ctx.pool,
    `UPDATE repo_pr_requests SET state=$2, url=$3, message=$4, base=COALESCE($5, base), updated_at=$6 WHERE request_id=$1`,
    [String(payload.requestId ?? ''), state, r?.url ?? null, message, r?.base ?? null, ctx.clock.now()],
  );
}
