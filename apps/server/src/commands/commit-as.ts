import {
  type CommitAs,
  type CommitAsResponse,
  CommitAsSchema,
  isOrgManager,
  RepoIdentityFactSchema,
  streamId,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { forbidden } from '../errors.ts';
import { projectScope, userActor } from './common.ts';

/**
 * "Commit as" (backlog #65): the name and e-mail every commit of a project carries. The runner resolves the identity
 * (this setting, else the clone's git config, else the workstation's global config, else it refuses) and the setting
 * travels in `shift.start`, `finalize.execute` and `repo.create`.
 */

/** The project's setting, `null` when none (or the stored value is not valid). */
export async function loadCommitAs(
  db: Queryable,
  projectId: string | null | undefined,
): Promise<CommitAs | null> {
  if (!projectId) return null;
  const r = await one<{ commit_as: unknown }>(db, 'SELECT commit_as FROM projects WHERE id=$1', [projectId]);
  const parsed = CommitAsSchema.safeParse(r?.commit_as ?? null);
  return parsed.success ? parsed.data : null;
}

/** Adds the project's `commitAs` to a `shift.start` payload (additive; absent when the project sets none). */
export async function withCommitAs<T extends { brief: { project: { id: string } } }>(
  ctx: Ctx,
  payload: T,
): Promise<T & { commitAs?: CommitAs }> {
  const commitAs = await loadCommitAs(ctx.pool, payload.brief.project.id);
  return commitAs ? { ...payload, commitAs } : payload;
}

export async function getCommitAs(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<CommitAsResponse> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const clones = await rows(
    ctx.pool,
    `SELECT pr.id AS repo_id, pr.name AS repo_name, w.id AS workstation_id, w.name AS workstation_name, wr.git_identity
       FROM workstation_repos wr
       JOIN project_repos pr ON pr.id = wr.project_repo_id AND pr.project_id = $1 AND pr.removed_at IS NULL
       JOIN workstations w ON w.id = wr.workstation_id AND w.status = 'active'
      ORDER BY pr.name, w.name`,
    [projectId],
  );
  const parsed = CommitAsSchema.safeParse(p.commit_as ?? null);
  return {
    commitAs: parsed.success ? parsed.data : null,
    clones: clones.map((c) => {
      const id = RepoIdentityFactSchema.safeParse(c.git_identity ?? null);
      return {
        repoId: c.repo_id,
        repoName: c.repo_name,
        workstationId: c.workstation_id,
        workstationName: c.workstation_name,
        identity: id.success ? id.data : null,
      };
    }),
  };
}

/** The project Owner, or an organization Owner or Admin, sets (or clears, `null`) the setting. */
export async function setCommitAs(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  commitAs: CommitAs | null,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    const orgAdmin = p.org_id ? isOrgManager({ orgRole: await orgRoleOf(tx, user.id, p.org_id) }) : false;
    if (p.my_role !== 'owner' && !orgAdmin)
      throw forbidden('only the project Owner or an organization Owner or Admin can do this');
    const before = CommitAsSchema.safeParse(p.commit_as ?? null);
    const same =
      (before.success
        ? before.data.name === commitAs?.name && before.data.email === commitAs?.email
        : false) ||
      (!before.success && commitAs === null);
    if (same) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectCommitAsSet', payload: { projectId, commitAs, setBy: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}
