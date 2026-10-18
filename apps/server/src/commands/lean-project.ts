import {
  type E2eAreaMap,
  isOrgManager,
  type OrgRole,
  type OwnerApprovalPolicy,
  streamId,
  type UpgradeWorkflowResponse,
} from '@aom/shared';
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

/** When the owner approves a card after the review (code-v6). A high-risk change always needs it. */
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
 * Opt-in upgrade of an existing project to code-v6 (organization Owner and Admins). The project keeps its own workflow as the
 * primary one and enables code-v6 as the default for all its card types, so new cards run the lean team flow while the cards
 * in flight finish on the version they are pinned to (their stages and approvals are untouched: nothing is migrated).
 */
export async function upgradeProjectWorkflow(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  projectId: string,
): Promise<UpgradeWorkflowResponse> {
  return withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (!isOrgManager({ orgRole: org.role }) || org.id !== p.org_id)
      throw forbidden('only the organization Owner and Admins can upgrade the workflow of a project');
    if (p.status !== 'active') throw conflict('project_archived', 'project is archived');
    const target = await resolveWorkflow(tx, p.org_id, 'code-v6', projectId);
    if (!target) throw badRequest('unknown_workflow', 'the code-v6 workflow is not available');
    if (['research', 'feed', 'code-bugfix'].includes(p.workflow_key))
      throw badRequest('not_a_code_project', `a ${p.workflow_key} project has no code workflow to upgrade`);
    const current = await enabledWorkflows(tx, p);
    const types = target.definition.cardTypes as string[];
    const entries = current
      .filter((e) => e.workflowKey !== 'code-v6')
      .map((e) => ({
        workflowKey: e.workflowKey,
        defaultCardTypes: e.defaultCardTypes.filter((t) => !types.includes(t)),
      }));
    entries.push({ workflowKey: 'code-v6', defaultCardTypes: [...types] });
    if (!current.some((e) => e.workflowKey === 'code-v6'))
      await ctx.store.append(
        [
          {
            streamId: streamId.project(projectId),
            event: { type: 'ProjectWorkflowsSet', payload: { projectId, enabled: entries, by: user.id } },
            actor: userActor(user.id),
            scope: projectScope(p.org_id, projectId),
          },
        ],
        { tx },
      );
    // code-v6 makes the full E2E suite a manual trigger: switch the automatic run after each merge off.
    if (p.full_suite_after_finalize !== false)
      await ctx.store.append(
        [
          {
            streamId: streamId.project(projectId),
            event: { type: 'ProjectFullSuiteSet', payload: { projectId, enabled: false, by: user.id } },
            actor: userActor(user.id),
            scope: projectScope(p.org_id, projectId),
          },
        ],
        { tx },
      );
    const open = await rows<{ n: number }>(
      tx,
      `SELECT count(*)::int AS n FROM cards c JOIN workflow_versions w ON w.id = c.workflow_version_id
        WHERE c.project_id=$1 AND c.status NOT IN ('done','cancelled') AND w.key <> 'code-v6'`,
      [projectId],
    );
    // Every agent role the code-v6 stages hand work to, checked for this project the way the dispatcher does: an active
    // agent of the role whose project list is unrestricted or holds this project (eligibility `role` clause); a stage's
    // `fallbackRole` covers the role only when such an agent of the fallback exists.
    const hired = await rows<{ role_key: string }>(
      tx,
      `SELECT DISTINCT role_key FROM agents
        WHERE org_id=$1 AND status='active' AND (allowed_project_ids IS NULL OR $2 = ANY (allowed_project_ids))`,
      [p.org_id, projectId],
    );
    const have = new Set(hired.map((h) => h.role_key));
    const needs = new Map<string, string | null>();
    for (const st of target.definition.stages) {
      if (st.kind !== 'agent' || !st.claimRole) continue;
      if (!needs.has(st.claimRole) || !st.fallbackRole) needs.set(st.claimRole, st.fallbackRole ?? null);
    }
    const missingRoles: string[] = [];
    const coveredByFallback: { role: string; fallbackRole: string }[] = [];
    const uncoveredRoles: string[] = [];
    for (const [role, fallback] of needs) {
      if (have.has(role)) continue;
      missingRoles.push(role);
      if (fallback && have.has(fallback)) coveredByFallback.push({ role, fallbackRole: fallback });
      else uncoveredRoles.push(role);
    }
    return {
      workflowKey: 'code-v6',
      openCardsOnOlderVersion: Number(open[0]?.n ?? 0),
      missingRoles,
      coveredByFallback,
      uncoveredRoles,
    };
  });
}

/**
 * The manual full E2E regression run on the project's working branch (code-v6 turns the automatic run after every merge
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
