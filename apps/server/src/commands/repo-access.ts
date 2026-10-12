import { type GitAccessMethod, type GitSshPayload, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { forbidden, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, userActor } from './common.ts';

/**
 * SSH as an alternative to API tokens. The owner chooses per repository how the workstation reaches it (`ssh`, `https`,
 * or the workstation default of the git host), and per workstation which key to use. Nothing here carries a secret:
 * keys stay on the workstation, the server learns the public key and the result of a check through `git.report`.
 */

/**
 * The owner chooses how the workstation reaches a repository: `ssh` (a key on the workstation), `https` (API token or
 * CLI login), or `null` (the workstation default of the git host). Every workstation holding a clone is told, so its
 * `origin` remote follows (`repo.access`).
 */
export async function setRepoAccessMethod(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  repoId: string,
  accessMethod: GitAccessMethod | null,
): Promise<void> {
  const workstations: string[] = [];
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const r = await one(
      tx,
      'SELECT id, remote_url, forge_kind, access_method FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
      [repoId, projectId],
    );
    if (!r) throw notFound('repository not found');
    if ((r.access_method ?? null) === accessMethod) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectRepoAccessSet', payload: { projectId, repoId, accessMethod } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
    const ws = await rows(
      tx,
      `SELECT w.id FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
        WHERE wr.project_repo_id=$1 AND w.status='active'`,
      [repoId],
    );
    for (const w of ws) {
      await enqueueRunnerCommand(tx, w.id as string, 'repo.access', {
        repoId,
        remoteUrl: r.remote_url,
        ...(accessMethod ? { accessMethod } : {}),
        ...(r.forge_kind ? { forge: r.forge_kind } : {}),
      });
      workstations.push(w.id as string);
    }
  });
  for (const id of workstations)
    void Promise.resolve(ctx.services.gateway.deliverPending(id)).catch(() => undefined);
}

/**
 * The Git hosts section asks the workstation to prepare an SSH key, record the access default or check that SSH
 * works (`git.ssh`). The answer is the next `git.report` (public key, last check).
 */
export async function requestGitSsh(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  body: GitSshPayload,
): Promise<void> {
  const w = await one(
    ctx.pool,
    `SELECT id FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
    [workstationId, user.id],
  );
  if (!w) throw notFound('workstation not found');
  await enqueueRunnerCommand(ctx.pool, workstationId, 'git.ssh', body as unknown as Record<string, unknown>);
  void Promise.resolve(ctx.services.gateway.deliverPending(workstationId)).catch(() => undefined);
}
