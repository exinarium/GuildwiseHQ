import { type E2eAreaMap, isOrgManager, type OrgRole, type OwnerApprovalPolicy, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import { resolveWorkflow } from '../catalogue/loader.ts';
import { enabledWorkflows } from '../catalogue/project-workflows.ts';
import type { Ctx } from '../context.ts';
import { type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden } from '../errors.ts';
import { projectScope, userActor } from './common.ts';
import { spawnCardEvent } from './spawn.ts';

/** The project's Owner or an organization Owner/Admin (same rule as the other project policy settings). */
async function loadManaged(
  db: Queryable,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  projectId: string,
): Promise<Row> {
  const p = await loadVisibleProject(db, user.id, projectId);
  const orgAdmin = isOrgManager({ orgRole: org.role }) && org.id === p.org_id;
  if (p.my_role !== 'owner' && !orgAdmin)
    throw forbidden('only the project Owner or an organization Owner or Admin can do this');
  return p;
}

/** When the owner approves a card after the review (lean team). A high-risk change always needs it. */
export async function setOwnerApprovalPolicy(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  projectId: string,
  policy: OwnerApprovalPolicy,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadManaged(tx, user, org, projectId);
    if ((p.owner_approval_policy ?? 'large_or_high_risk') === policy) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectOwnerApprovalSet', payload: { projectId, policy, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

/** The mapping of changed paths to E2E specs; `null` returns to the default derived from the E2E folders. */
export async function setE2eAreas(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  projectId: string,
  mapping: E2eAreaMap | null,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadManaged(tx, user, org, projectId);
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectE2eAreasSet', payload: { projectId, mapping, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

/**
 * The manual full E2E regression run on the project's working branch (the lean team flow turns the automatic run after every merge
 * off): one suite card queued at Test for a tester. Same card the automatic run makes.
 */
export async function requestFullSuite(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<{ cardId: string; ref: string }> {
  return withAppendTx(ctx.pool, async (tx) => {
    const project = await loadVisibleProject(tx, user.id, projectId);
    if (project.status !== 'active') throw conflict('project_archived', 'project is archived');
    const wf = await resolveWorkflow(tx, project.org_id, project.workflow_key, project.id);
    const hasTest = wf?.definition.stages.some((s) => s.id === 'test');
    if (!wf || !hasTest) throw conflict('no_test_stage', 'this project workflow has no test stage');
    const repo = (
      await rows(
        tx,
        `SELECT * FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY id LIMIT 1`,
        [project.id],
      )
    )[0] as Row | undefined;
    if (!repo) throw conflict('no_repo', 'the project has no repository to run the suite on');
    const branch = (repo.working_branch ?? project.working_branch) as string;
    const suite = await spawnCardEvent(tx, {
      from: {
        project_id: project.id,
        org_id: project.org_id,
        owner_user_id: user.id,
        repo_id: repo.id,
        priority: 5,
        workflow_version_id: wf.id,
      } as Row,
      title: `Full E2E suite on ${branch}`,
      cardType: 'regression',
      origin: 'full_suite',
      stage: 'test',
      status: 'queued',
      scheduled: false,
      fields: {
        context: `Manual run of the full E2E suite on ${branch}, started by ${user.displayName}.`,
        platform: 'web',
        suiteBranch: branch,
      },
      actor: userActor(user.id),
      ownerUserId: user.id,
    });
    await ctx.store.append([suite.event], { tx });
    return { cardId: suite.cardId, ref: suite.ref };
  });
}
