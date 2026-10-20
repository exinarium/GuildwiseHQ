import { createHash, randomUUID } from 'node:crypto';
import {
  type RunEnvironmentDto,
  type RunPlan,
  type RunPlanOverview,
  RunPlanSchema,
  type RunPlanVersionDto,
  type SaveRunPlanRequest,
  SETUP_SCAN_CAPABILITY,
  streamId,
  type TestRunPlanRequest,
  validateRunPlan,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { projectScope, userActor } from './common.ts';
import { capsOf, startRun } from './runs.ts';
import { listProposalDtos, openScan, scanProblemFor } from './setup-proposals.ts';

/**
 * The project's run plan as the guided editor sees it (docs/design/deploy-run-ux-design.md sections 3.1 and 7.2): one
 * project-wide plan (saved by the owner or from a confirmed scan) plus the plans of single workstations (DevOps repairs).
 */

const toDto = (r: Row): RunPlanVersionDto => ({
  id: r.id,
  workstationId: r.workstation_id,
  workstationName: r.workstation_name ?? null,
  version: r.version,
  status: r.status,
  source: r.source ?? 'devops',
  plan: RunPlanSchema.parse(r.plan),
  savedAt: iso(r.created_at) as string,
  savedByName: r.saved_by_name ?? null,
  lastFailure: r.last_failure ? { reason: r.last_failure.reason, at: r.last_failure.at } : null,
});

const PLAN_SQL = `SELECT rp.*, w.name AS workstation_name, u.display_name AS saved_by_name
    FROM run_plans rp LEFT JOIN workstations w ON w.id = rp.workstation_id LEFT JOIN users u ON u.id = rp.saved_by`;

export async function getRunPlanOverview(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
): Promise<RunPlanOverview> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  const repos = await rows(
    ctx.pool,
    'SELECT id, name FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name, id',
    [projectId],
  );
  const plans = await rows(
    ctx.pool,
    `${PLAN_SQL} WHERE rp.project_id=$1 AND rp.status <> 'superseded' AND (rp.workstation_id IS NULL OR w.status='active')
      ORDER BY w.name NULLS FIRST`,
    [projectId],
  );
  const dtos = plans.map(toDto);
  const projectPlan = dtos.find((d) => d.workstationId === null) ?? null;

  // The viewer's own workstations: where a scan or a test can run.
  const stations = await rows(
    ctx.pool,
    `SELECT w.id, w.name, w.connected,
            EXISTS (SELECT 1 FROM agents a WHERE a.workstation_id = w.id AND a.is_devops AND a.status='active') AS has_devops,
            (SELECT count(*)::int FROM workstation_repos wr JOIN project_repos pr ON pr.id = wr.project_repo_id
              WHERE wr.workstation_id = w.id AND pr.project_id = $1 AND pr.removed_at IS NULL) AS clones
       FROM workstations w WHERE w.user_id=$2 AND w.status='active' ORDER BY w.connected DESC, w.name, w.id`,
    [projectId, user.id],
  );
  const workstations = [];
  for (const w of stations) {
    const caps = await capsOf(ctx.pool, w.id);
    const capList = (
      await one<{ capabilities: string[] }>(
        ctx.pool,
        'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
        [w.id],
      )
    )?.capabilities;
    const hasScan = (capList ?? []).includes(SETUP_SCAN_CAPABILITY);
    const scanBlocked = !w.connected
      ? `${w.name} is offline. Scans run on a computer that has the project's code.`
      : !hasScan
        ? `Guildwise on ${w.name} is too old for scans: update it.`
        : !w.has_devops
          ? `${w.name} has no DevOps engineer.`
          : w.clones === 0
            ? `${w.name} has no copy of the project's code.`
            : null;
    workstations.push({
      id: w.id as string,
      name: w.name as string,
      connected: !!w.connected,
      mine: true,
      canRun: caps.runs && caps.replay && w.clones > 0,
      canScan: scanBlocked === null,
      scanBlocked,
    });
  }

  const last = await one(
    ctx.pool,
    `SELECT e.state, e.created_at, e.healthy_at, e.stopped_at, e.last_error, w.name AS workstation_name
       FROM run_environments e JOIN workstations w ON w.id = e.workstation_id
      WHERE e.project_id=$1 AND e.purpose IN ('manual','test') ORDER BY e.created_at DESC LIMIT 1`,
    [projectId],
  );
  const scan = await openScan(ctx.pool, projectId, 'run', ctx.clock.now());
  const proposals = await listProposalDtos(ctx.pool, projectId, 'run', true);
  return {
    canEdit: p.my_role === 'owner',
    repos: repos.map((r) => ({ repoId: r.id, name: r.name })),
    workstations,
    projectPlan,
    workstationPlans: dtos.filter((d) => d.workstationId !== null),
    scan,
    scanProblem: scan || proposals[0] ? null : await scanProblemFor(ctx.pool, projectId, 'run'),
    proposal: proposals[0] ?? null,
    lastStart: last
      ? {
          state: last.state === 'failed' ? 'failed' : last.healthy_at ? 'ok' : 'running',
          at: iso(last.healthy_at ?? last.stopped_at ?? last.created_at) as string,
          workstationName: last.workstation_name,
          failure: last.state === 'failed' ? (last.last_error ?? null) : null,
        }
      : null,
  };
}

/** What a plan may name: repositories of the project. */
async function assertPlanRepos(db: Queryable, projectId: string, plan: RunPlan): Promise<void> {
  const ids = new Set(
    (
      await rows<{ id: string }>(
        db,
        'SELECT id FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
        [projectId],
      )
    ).map((r) => r.id),
  );
  for (const x of [...plan.setup, ...plan.services])
    if (!ids.has(x.repoId))
      throw badRequest('unknown_repo', `"${x.name}" names a repository that is not in the project`);
}

/** `PUT /api/projects/:id/run-plan`: the owner's plan (or a confirmed scan) becomes the next version for the project or a workstation. */
export async function saveRunPlan(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: SaveRunPlanRequest,
): Promise<RunPlanVersionDto> {
  const plan = RunPlanSchema.parse(req.plan);
  const problems = validateRunPlan(plan);
  if (problems.length) throw badRequest('invalid_run_plan', problems.join('; '));
  if (plan.services.length === 0)
    throw badRequest('invalid_run_plan', 'a plan needs at least one part that keeps running');
  const planId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    await assertPlanRepos(tx, projectId, plan);
    const workstationId = req.scope === 'project' ? null : req.scope.workstationId;
    if (workstationId) {
      const ws = await one(tx, `SELECT 1 AS x FROM workstations WHERE id=$1 AND status='active'`, [
        workstationId,
      ]);
      if (!ws) throw notFound('workstation not found');
    }
    let proposalId: string | undefined;
    if (req.proposalId) {
      const prop = await one(
        tx,
        `SELECT id, status, area FROM setup_proposals WHERE id=$1 AND project_id=$2 FOR UPDATE`,
        [req.proposalId, projectId],
      );
      if (!prop || prop.area !== 'run') throw notFound('proposal not found');
      if (prop.status !== 'open')
        throw conflict('proposal_resolved', 'this proposal was already used or dismissed');
      proposalId = prop.id;
    }
    const last = await one(
      tx,
      'SELECT COALESCE(max(version), 0) AS v FROM run_plans WHERE project_id=$1 AND workstation_id IS NOT DISTINCT FROM $2::uuid',
      [projectId, workstationId],
    );
    const fingerprint = createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'RunPlanSaved',
            payload: {
              planId,
              projectId,
              workstationId,
              version: Number(last?.v ?? 0) + 1,
              plan,
              fingerprint,
              requestId: null,
              source: proposalId ? 'scan' : req.source,
              savedBy: user.id,
              ...(proposalId ? { proposalId } : {}),
            },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
        ...(proposalId
          ? [
              {
                streamId: streamId.project(projectId),
                event: {
                  type: 'SetupProposalResolved' as const,
                  payload: { proposalId, outcome: 'accepted' as const, by: user.id },
                },
                actor: userActor(user.id),
                scope: projectScope(p.org_id, projectId),
              },
            ]
          : []),
      ],
      { tx },
    );
  });
  const saved = await one(ctx.pool, `${PLAN_SQL} WHERE rp.id=$1`, [planId]);
  if (!saved) throw notFound('plan not found');
  return toDto(saved);
}

/** "Use the project version here": drops a workstation's own plan so the project plan applies there again. */
export async function discardWorkstationPlan(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  planId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const plan = await one(
      tx,
      `SELECT id FROM run_plans WHERE id=$1 AND project_id=$2 AND workstation_id IS NOT NULL AND status <> 'superseded'`,
      [planId, projectId],
    );
    if (!plan) throw notFound('plan not found');
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'RunPlanDiscarded', payload: { planId, projectId, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

/** "Test these steps": starts the app once on a workstation from the given (maybe unsaved) plan, or from the saved one. */
export async function testRunPlan(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: TestRunPlanRequest,
): Promise<RunEnvironmentDto> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
  let plan: RunPlan | undefined;
  if (req.plan) {
    plan = RunPlanSchema.parse(req.plan);
    const problems = validateRunPlan(plan);
    if (problems.length) throw badRequest('invalid_run_plan', problems.join('; '));
    await assertPlanRepos(ctx.pool, projectId, plan);
  } else {
    const saved = await one(
      ctx.pool,
      `SELECT plan FROM run_plans WHERE project_id=$1 AND status='active' AND (workstation_id=$2 OR workstation_id IS NULL)
        ORDER BY (workstation_id IS NULL) LIMIT 1`,
      [projectId, req.workstationId],
    );
    if (!saved) throw conflict('no_plan', 'there are no run steps to test yet');
    plan = RunPlanSchema.parse(saved.plan);
  }
  return startRun(
    ctx,
    user,
    {
      projectId,
      workstationId: req.workstationId,
      note: 'Test of the run steps from Project settings.',
    },
    { testPlan: plan },
  );
}
