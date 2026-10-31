import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { requestReleaseFacts } from './facts.ts';

/** `POST .../release-proposal`: the owner asks for the proposal to be prepared or refreshed now. */
export async function requestReleaseProposal(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  repoId: string,
): Promise<{ requestId: string }> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
  const repo = await one(ctx.pool, 'SELECT id FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL', [
    repoId,
    projectId,
  ]);
  if (!repo) throw notFound('repository not found');
  const out = await requestReleaseFacts(ctx, repoId, 'manual', { userId: user.id });
  if (out.queued) return { requestId: out.requestId };
  const msg: Record<string, [string, string]> = {
    skipped: [
      'nothing_to_prepare',
      'This repository has no separate working branch and main branch, so there is nothing to release between them.',
    ],
    throttled: ['already_reading', 'The repository is being read right now. Try again in a few minutes.'],
    no_clone: ['no_clone', 'No workstation has this repository yet. Wait for the clone to finish, then try again.'],
    old_runner: ['old_runner', 'The workstation that has this repository needs a newer runner. Update the runner and try again.'],
  };
  const [code, text] = msg[out.reason] as [string, string];
  throw conflict(code, text);
}
