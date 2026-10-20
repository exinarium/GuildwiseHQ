import { randomUUID } from 'node:crypto';
import {
  type DevopsScan,
  type ProposalDto,
  RunPlanSchema,
  SCAN_REQUEST_KIND,
  type ScanStateDto,
  SETUP_SCAN_CAPABILITY,
  type SetupArea,
  type SetupProposal,
  SetupProposalSchema,
  type SetupScanRequest,
  streamId,
  validateRunPlan,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, forbidden, notFound } from '../errors.ts';
import { agentActor, projectScope, userActor } from './common.ts';
import { createDevOpsRequestIn } from './devops.ts';

/**
 * "Scan with DevOps" (docs/design/deploy-run-ux-design.md section 5): a read-only DevOps request of kind `run_scan` (v1b:
 * `deploy_scan`) that ends with a schema-checked proposal. The proposal is stored as an event and reviewed by a person;
 * nothing it names is saved until they confirm. The machinery is shared by both areas: only the proposal body differs.
 */

/** A scan that never reported is not "open" any more after this long, so the user can start another one. */
export const SCAN_OPEN_MS = 45 * 60_000;

const KINDS = Object.values(SCAN_REQUEST_KIND);

/** The scan that is queued or running for this project and area, else null. */
export async function openScan(
  db: Queryable,
  projectId: string,
  area: SetupArea,
  now: Date,
): Promise<ScanStateDto | null> {
  const r = await one(
    db,
    `SELECT q.id, q.status, q.workstation_id, q.created_at, w.name AS workstation_name
       FROM devops_requests q JOIN workstations w ON w.id = q.workstation_id
      WHERE q.context->>'projectId' = $1 AND q.context->>'requestKind' = $2
        AND q.status IN ('queued','running','needs_approval') AND q.created_at > $3
      ORDER BY q.created_at DESC LIMIT 1`,
    [projectId, SCAN_REQUEST_KIND[area], new Date(now.getTime() - SCAN_OPEN_MS)],
  );
  return r
    ? {
        requestId: r.id,
        area,
        status: r.status,
        workstationId: r.workstation_id,
        workstationName: r.workstation_name,
        startedAt: iso(r.created_at) as string,
      }
    : null;
}

/** Why the last scan ended with no proposal (its DevOps request failed, or finished without submitting one). */
export async function scanProblemFor(
  db: Queryable,
  projectId: string,
  area: SetupArea,
): Promise<string | null> {
  const r = await one(
    db,
    `SELECT q.id, q.status, q.result_summary, q.created_at,
            EXISTS (SELECT 1 FROM setup_proposals sp WHERE sp.request_id = q.id) AS has_proposal
       FROM devops_requests q
      WHERE q.context->>'projectId' = $1 AND q.context->>'requestKind' = $2
      ORDER BY q.created_at DESC LIMIT 1`,
    [projectId, SCAN_REQUEST_KIND[area]],
  );
  if (!r || r.has_proposal) return null;
  if (r.status === 'failed')
    return `The scan did not finish${r.result_summary ? `: ${String(r.result_summary).slice(0, 300)}` : '.'}`;
  if (r.status === 'done')
    return `DevOps looked at the project but could not suggest steps${r.result_summary ? `: ${String(r.result_summary).slice(0, 300)}` : '.'}`;
  return null;
}

const toDto = (r: Row): ProposalDto => ({
  id: r.id,
  area: r.area,
  status: r.status,
  requestId: r.request_id,
  workstationId: r.workstation_id,
  workstationName: r.workstation_name ?? 'a computer',
  proposal: SetupProposalSchema.parse(r.proposal),
  submittedAt: iso(r.submitted_at) as string,
});

export async function listProposalDtos(
  db: Queryable,
  projectId: string,
  area: SetupArea | undefined,
  openOnly: boolean,
): Promise<ProposalDto[]> {
  const list = await rows(
    db,
    `SELECT sp.*, w.name AS workstation_name FROM setup_proposals sp LEFT JOIN workstations w ON w.id = sp.workstation_id
      WHERE sp.project_id=$1 AND ($2::text IS NULL OR sp.area=$2) AND (NOT $3::boolean OR sp.status='open')
      ORDER BY sp.submitted_at DESC LIMIT 20`,
    [projectId, area ?? null, openOnly],
  );
  return list.map(toDto);
}

export async function listProposals(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  area: SetupArea | undefined,
): Promise<ProposalDto[]> {
  await loadVisibleProject(ctx.pool, user.id, projectId);
  return listProposalDtos(ctx.pool, projectId, area, false);
}

// --------------------------------------------------------------------------------------------------- starting

/** `POST /api/projects/:id/scan`: files the read-only DevOps request on a workstation that has the project's code. */
export async function startScan(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: SetupScanRequest,
): Promise<{ requestId: string }> {
  if (req.area !== 'run')
    throw badRequest('scan_not_available', 'scanning the deploy setup is not available yet');
  const now = ctx.clock.now();
  const out = await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    if (p.status !== 'active') throw conflict('project_archived', 'this project is archived');
    // One open scan per project and area: a second press shows the running one.
    const open = await openScan(tx, projectId, req.area, now);
    if (open) return { requestId: open.requestId, workstationId: open.workstationId, created: false };

    const candidates = await rows(
      tx,
      `SELECT w.id, w.name, w.connected, c.capabilities
         FROM workstations w LEFT JOIN workstation_capabilities c ON c.workstation_id = w.id
        WHERE w.user_id=$1 AND w.status='active' AND ($2::uuid IS NULL OR w.id=$2)
          AND EXISTS (SELECT 1 FROM workstation_repos wr JOIN project_repos pr ON pr.id = wr.project_repo_id
                       WHERE wr.workstation_id = w.id AND pr.project_id=$3 AND pr.removed_at IS NULL)
        ORDER BY w.connected DESC, w.paired_at, w.id`,
      [user.id, req.workstationId ?? null, projectId],
    );
    if (candidates.length === 0)
      throw conflict(
        'no_workstation',
        req.workstationId
          ? 'that computer has no copy of the project code'
          : 'none of your computers has a copy of the project code',
      );
    const ws =
      candidates.find((c) => c.connected && (c.capabilities ?? []).includes(SETUP_SCAN_CAPABILITY)) ??
      candidates[0];
    if (!ws) throw conflict('no_workstation', 'none of your computers has a copy of the project code');
    if (!ws.connected) throw conflict('workstation_offline', `${ws.name} is offline`);
    if (!(ws.capabilities ?? []).includes(SETUP_SCAN_CAPABILITY))
      throw conflict(
        'scan_not_supported',
        `Guildwise on ${ws.name} is too old for scans: update the runner on that computer`,
      );
    const { requestId } = await createDevOpsRequestIn(ctx, tx, {
      workstationId: ws.id,
      orgId: p.org_id,
      summary: `Scan ${p.name} to find out how to run it (read-only). Suggest the steps for the user to review.${req.note ? `\n\nThe user says: ${req.note}` : ''}`,
      requestedBy: { kind: 'user', id: user.id, name: user.displayName },
      origin: 'app',
      context: {
        projectId,
        workstationId: ws.id,
        requestKind: SCAN_REQUEST_KIND[req.area],
        scanArea: req.area,
        projectKey: p.key,
        ...(req.note ? { scanNote: req.note } : {}),
      },
    });
    return { requestId, workstationId: ws.id as string, created: true };
  });
  if (out.created) ctx.services.dispatcher.trigger();
  return { requestId: out.requestId };
}

// --------------------------------------------------------------------------------------------------- brief

/** The `scan` part of a DevOps shift for a scan request (undefined: not a scan request). */
export async function scanBriefFor(ctx: Ctx, req: Row): Promise<DevopsScan | undefined> {
  const c = (req.context ?? {}) as { requestKind?: string; projectId?: string; scanNote?: string };
  if (!c.requestKind || !(KINDS as string[]).includes(c.requestKind) || !c.projectId) return undefined;
  const area: SetupArea = c.requestKind === SCAN_REQUEST_KIND.deploy ? 'deploy' : 'run';
  const project = await one(
    ctx.pool,
    'SELECT key, name, run_instructions, working_branch FROM projects WHERE id=$1',
    [c.projectId],
  );
  if (!project) return undefined;
  const repos = await rows(
    ctx.pool,
    `SELECT id, name, remote_url_normalized, project_path, working_branch, run_instructions
       FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name, id`,
    [c.projectId],
  );
  const plan = await one(
    ctx.pool,
    `SELECT plan FROM run_plans WHERE project_id=$1 AND workstation_id IS NULL AND status <> 'superseded'`,
    [c.projectId],
  );
  return {
    area,
    projectKey: project.key,
    projectName: project.name,
    repos: repos.map((r) => ({
      repoId: r.id,
      name: r.name,
      remoteUrlNormalized: r.remote_url_normalized,
      ...(r.project_path ? { projectPath: r.project_path } : {}),
      workingBranch: r.working_branch ?? project.working_branch,
    })),
    runInstructions: project.run_instructions ?? '',
    repoInstructions: repos
      .filter((r) => (r.run_instructions ?? '').trim())
      .map((r) => ({ repoId: r.id, name: r.name, text: r.run_instructions })),
    currentPlan: plan ? RunPlanSchema.parse(plan.plan) : null,
    ...(c.scanNote ? { note: c.scanNote } : {}),
  };
}

// --------------------------------------------------------------------------------------------------- DevOps submits

type Reply = [boolean, unknown?, string?];

const issuesText = (e: { issues: Array<{ path: PropertyKey[]; message: string }> }) =>
  e.issues
    .slice(0, 8)
    .map((i) => `${i.path.map(String).join('.') || 'proposal'}: ${i.message}`)
    .join('; ');

/**
 * IPC `setup.propose` (`aom setup propose --area run --file <json>`): the DevOps engineer of a scan request submits what it
 * found. Refused with the schema's message so it can fix the file and send again within the shift.
 */
export async function setupProposeRpc(ctx: Ctx, shift: Row, params: Record<string, unknown>): Promise<Reply> {
  if (shift.kind !== 'devops') return [false, undefined, 'only the DevOps engineer submits a setup proposal'];
  const req = await one(
    ctx.pool,
    `SELECT id, org_id, workstation_id, context FROM devops_requests WHERE shift_id=$1 AND status IN ('running','needs_approval')`,
    [shift.id],
  );
  const c = (req?.context ?? {}) as { requestKind?: string; projectId?: string };
  if (!req || !c.projectId || !c.requestKind || !(KINDS as string[]).includes(c.requestKind))
    return [false, undefined, 'a setup proposal belongs to a "Scan with DevOps" request'];
  const area: SetupArea = c.requestKind === SCAN_REQUEST_KIND.deploy ? 'deploy' : 'run';
  const parsed = SetupProposalSchema.safeParse(params.proposal);
  if (!parsed.success) return [false, undefined, `invalid proposal: ${issuesText(parsed.error)}`];
  const proposal: SetupProposal = parsed.data;
  if (proposal.area !== area)
    return [false, undefined, `this is a ${area} scan: the proposal must have "area": "${area}"`];
  if (area === 'run' && proposal.run) {
    const problems = validateRunPlan(proposal.run);
    if (problems.length) return [false, undefined, `invalid run plan: ${problems.slice(0, 8).join('; ')}`];
    const repoIds = new Set(
      (
        await rows<{ id: string }>(
          ctx.pool,
          'SELECT id FROM project_repos WHERE project_id=$1 AND removed_at IS NULL',
          [c.projectId],
        )
      ).map((r) => r.id),
    );
    for (const x of [...proposal.run.setup, ...proposal.run.services])
      if (!repoIds.has(x.repoId))
        return [
          false,
          undefined,
          `"${x.name}" has repoId ${x.repoId}, which is not a repository of this project (use the repo ids listed in the request)`,
        ];
  }
  const project = await one(ctx.pool, 'SELECT org_id FROM projects WHERE id=$1', [c.projectId]);
  if (!project) return [false, undefined, 'project not found'];
  const proposalId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    await ctx.store.append(
      [
        {
          streamId: streamId.project(c.projectId as string),
          event: {
            type: 'SetupProposalSubmitted',
            payload: {
              proposalId,
              projectId: c.projectId as string,
              area,
              requestId: req.id,
              workstationId: req.workstation_id,
              proposal,
            },
          },
          actor: agentActor(shift.agent_id),
          scope: projectScope(project.org_id, c.projectId as string),
        },
      ],
      { tx },
    );
  });
  return [
    true,
    {
      proposalId,
      message: `Proposal saved (${proposal.items.length} items, ${proposal.questions.length} questions). The user reviews it in Project settings. Now end the request with aom devops-done.`,
    },
  ];
}

// --------------------------------------------------------------------------------------------------- resolve

/** Dismiss (the owner puts the proposal away). Accepting goes through saving the plan, which resolves it. */
export async function resolveProposal(
  ctx: Ctx,
  user: AuthSession['user'],
  proposalId: string,
  outcome: 'dismissed' | 'accepted',
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const sp = await one(tx, 'SELECT * FROM setup_proposals WHERE id=$1 FOR UPDATE', [proposalId]);
    if (!sp) throw notFound('proposal not found');
    const p = await loadVisibleProject(tx, user.id, sp.project_id);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    if (outcome === 'accepted')
      throw badRequest(
        'use_save',
        'a proposal is accepted by saving its steps (PUT run-plan with the proposalId)',
      );
    if (sp.status !== 'open') return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(sp.project_id),
          event: { type: 'SetupProposalResolved', payload: { proposalId, outcome, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, sp.project_id),
        },
      ],
      { tx },
    );
  });
}
