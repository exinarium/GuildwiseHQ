import { createHash, randomUUID } from 'node:crypto';
import {
  formatCommandLine,
  itemLabel,
  normalizePlanDocker,
  type PlanConsentDto,
  planSafetyProblems,
  type RunEnvironmentDto,
  type RunPlan,
  type RunPlanOverview,
  RunPlanSchema,
  type RunPlanVersionDto,
  type SaveRunPlanRequest,
  streamId,
  type TestRan,
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
import { listProposalDtos, openScan, scanBlockedReason, scanProblemFor } from './setup-proposals.ts';

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
    const blocked = scanBlockedReason({
      name: w.name,
      connected: !!w.connected,
      capabilities: capList ?? null,
      has_devops: !!w.has_devops,
      clones: w.clones,
    });
    const scanBlocked = blocked?.message ?? null;
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
  const consents = await consentsFor(ctx.pool, user.id, projectId, projectPlan);
  const scan = await openScan(ctx.pool, projectId, 'run', ctx.clock.now());
  const proposals = await listProposalDtos(ctx.pool, projectId, 'run', true);
  return {
    canEdit: p.my_role === 'owner',
    repos: repos.map((r) => ({ repoId: r.id, name: r.name })),
    workstations,
    projectPlan,
    workstationPlans: dtos.filter((d) => d.workstationId !== null),
    consents,
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

/** The commands of a plan, in plain words, for the owner of a computer who is asked to allow it. */
function consentSteps(plan: RunPlan): PlanConsentDto['steps'] {
  return [
    ...plan.setup.map((st) => ({
      kind: 'step' as const,
      label: itemLabel(st),
      command: formatCommandLine(st.cmd),
      folder: st.cwd,
      docker: false,
      envFile: null,
    })),
    ...plan.services.map((sv) => ({
      kind: 'part' as const,
      label: itemLabel(sv),
      command: formatCommandLine(sv.cmd),
      folder: sv.cwd,
      docker: sv.docker,
      envFile: sv.envFile ?? null,
    })),
  ];
}

/** Project plan versions waiting for the viewer's OK on one of the viewer's own computers. */
async function consentsFor(
  db: Queryable,
  userId: string,
  projectId: string,
  projectPlan: RunPlanVersionDto | null,
): Promise<PlanConsentDto[]> {
  if (!projectPlan || projectPlan.source === 'devops') return [];
  const mine = await rows(
    db,
    `SELECT w.id, w.name FROM workstations w
      WHERE w.user_id=$1 AND w.status='active'
        AND EXISTS (SELECT 1 FROM workstation_repos wr JOIN project_repos pr ON pr.id = wr.project_repo_id
                     WHERE wr.workstation_id = w.id AND pr.project_id=$2 AND pr.removed_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM run_plan_consents c WHERE c.plan_id=$3 AND c.workstation_id = w.id)
        AND NOT EXISTS (SELECT 1 FROM run_plans rp WHERE rp.id=$3 AND rp.saved_by = w.user_id)
      ORDER BY w.name, w.id`,
    [userId, projectId, projectPlan.id],
  );
  return mine.map((w) => ({
    planId: projectPlan.id,
    version: projectPlan.version,
    workstationId: w.id as string,
    workstationName: w.name as string,
    savedByName: projectPlan.savedByName,
    steps: consentSteps(projectPlan.plan),
  }));
}

/** "Allow on my computer": the owner of a workstation allows this version of the project plan to run there. */
export async function allowPlanOnWorkstation(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  planId: string,
  workstationId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    const ws = await one(tx, `SELECT user_id FROM workstations WHERE id=$1 AND status='active'`, [
      workstationId,
    ]);
    if (!ws) throw notFound('workstation not found');
    if (ws.user_id !== user.id) throw forbidden('only the owner of a computer can allow steps to run on it');
    const plan = await one(
      tx,
      `SELECT id FROM run_plans WHERE id=$1 AND project_id=$2 AND workstation_id IS NULL AND status='active'`,
      [planId, projectId],
    );
    if (!plan)
      throw conflict('plan_changed', 'these steps were replaced by a newer version: reload the page');
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'RunPlanConsentGiven', payload: { planId, projectId, workstationId, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
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
  // Docker is decided by the template, never by what the page sent
  const plan = normalizePlanDocker(RunPlanSchema.parse(req.plan));
  const problems = [...validateRunPlan(plan), ...planSafetyProblems(plan)];
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
      // a workstation of an active member of the project (the same rule as a deploy target's)
      const ws = await one(
        tx,
        `SELECT w.user_id FROM workstations w JOIN project_members pm ON pm.user_id = w.user_id AND pm.project_id = $2 AND pm.status = 'active'
          WHERE w.id=$1 AND w.status='active'`,
        [workstationId, projectId],
      );
      if (!ws) throw notFound('workstation not found');
      // steps for one computer are that computer's owner's call
      if (ws.user_id !== user.id) throw forbidden('only the owner of a computer can save steps for it');
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
              // decided here, never taken from the page
              source: proposalId ? 'scan' : 'owner',
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
      `SELECT rp.id, w.user_id FROM run_plans rp JOIN workstations w ON w.id = rp.workstation_id
        WHERE rp.id=$1 AND rp.project_id=$2 AND rp.workstation_id IS NOT NULL AND rp.status <> 'superseded'`,
      [planId, projectId],
    );
    if (!plan) throw notFound('plan not found');
    if (plan.user_id !== user.id) throw forbidden('only the owner of that computer can drop its steps');
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
): Promise<{ environment: RunEnvironmentDto; ran: TestRan }> {
  const p = await loadVisibleProject(ctx.pool, user.id, projectId);
  if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
  // A test starts processes: only on a computer of the person who presses the button.
  const mine = await one(
    ctx.pool,
    `SELECT 1 AS x FROM workstations WHERE id=$1 AND user_id=$2 AND status='active'`,
    [req.workstationId, user.id],
  );
  if (!mine) throw forbidden('you can test steps only on your own computers');
  let plan: RunPlan | undefined;
  let ran: TestRan = { source: 'unsaved', version: null };
  if (req.plan) {
    plan = normalizePlanDocker(RunPlanSchema.parse(req.plan));
    const problems = [...validateRunPlan(plan), ...planSafetyProblems(plan)];
    if (problems.length) throw badRequest('invalid_run_plan', problems.join('; '));
    await assertPlanRepos(ctx.pool, projectId, plan);
  } else {
    const saved = await one(
      ctx.pool,
      `SELECT plan, version, workstation_id FROM run_plans WHERE project_id=$1 AND status='active' AND (workstation_id=$2 OR workstation_id IS NULL)
        ORDER BY (workstation_id IS NULL) LIMIT 1`,
      [projectId, req.workstationId],
    );
    if (!saved) throw conflict('no_plan', 'there are no run steps to test yet');
    plan = normalizePlanDocker(RunPlanSchema.parse(saved.plan));
    ran = { source: saved.workstation_id ? 'workstation' : 'project', version: saved.version };
  }
  const environment = await startRun(
    ctx,
    user,
    {
      projectId,
      workstationId: req.workstationId,
      note: 'Test of the run steps from Project settings.',
    },
    { testPlan: plan },
  );
  return { environment, ran };
}
