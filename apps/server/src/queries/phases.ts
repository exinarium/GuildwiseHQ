import {
  followupLabel,
  memberOutcome,
  PHASE_ASSIGNABLE_STATUSES,
  PHASE_FOLLOWUP_EDITABLE_STATUSES,
  type PhaseDeskBlock,
  type PhaseDetailDto,
  type PhaseFollowupDto,
  type PhaseMemberDto,
  type PhaseSummaryDto,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import { loadVisibleProject, requireProjectMember } from '../authz/scope.ts';
import { followupRows, memberRows, memberState, targetNames } from '../commands/phase-events.ts';
import type { Ctx } from '../context.ts';
import { orgCostCtx, spendBriefs } from '../costs/index.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';

const SUMMARY_SELECT = `SELECT p.*, u.display_name AS created_by_user_name, a.name AS created_by_agent_name, pr.key AS project_key
  FROM phases p JOIN projects pr ON pr.id = p.project_id
  LEFT JOIN users u ON u.id = p.created_by_user_id LEFT JOIN agents a ON a.id = p.created_by_agent_id`;

async function summaries(
  db: Queryable,
  list: Row[],
  clock: Date,
  userId: string,
): Promise<PhaseSummaryDto[]> {
  if (list.length === 0) return [];
  const ids = list.map((p) => p.id);
  const orgId = list[0]?.org_id as string;
  // Spend is for the organization's own members; a guest on a shared project sees the phase without it.
  const spend = (await orgRoleOf(db, userId, orgId))
    ? await spendBriefs(db, await orgCostCtx(db, orgId), clock, 'phase', ids)
    : new Map();
  const members = await rows(
    db,
    `SELECT phase_id, id, status, phase_assignment, finalize_result, finalize_action, merged_into_working_at
       FROM cards WHERE phase_id = ANY($1::uuid[])`,
    [ids],
  );
  const followups = await rows(
    db,
    'SELECT * FROM phase_followups WHERE phase_id = ANY($1::uuid[]) ORDER BY position',
    [ids],
  );
  const names = await targetNames(
    db,
    followups.flatMap((f) => (f.target_id ? [f.target_id as string] : [])),
  );
  return list.map((p) => {
    const mine = members.filter((m) => m.phase_id === p.id);
    const confirmed = mine.filter((m) => m.phase_assignment === 'confirmed');
    return {
      id: p.id,
      projectId: p.project_id,
      number: p.number,
      ref: p.ref,
      name: p.name,
      description: p.description,
      status: p.status,
      workingBranch: p.working_branch,
      createdBy: {
        kind: p.created_by_kind,
        name:
          p.created_by_kind === 'agent'
            ? (p.created_by_agent_name ?? null)
            : (p.created_by_user_name ?? null),
      },
      memberCount: confirmed.length,
      resolvedCount: confirmed.filter((m) => {
        const o = memberOutcome(memberState(m));
        return o !== null && o !== 'waiting_merge';
      }).length,
      proposedCount: mine.length - confirmed.length,
      followups: followups
        .filter((f) => f.phase_id === p.id)
        .map((f) => ({
          id: f.id,
          position: f.position,
          kind: f.kind,
          label: followupLabel(
            { kind: f.kind, platform: f.platform, instruction: f.instruction },
            f.target_id ? names.get(f.target_id) : null,
          ),
          status: f.status,
        })),
      createdAt: iso(p.created_at) as string,
      completedAt: iso(p.completed_at),
      ...(spend.has(p.id) ? { spend: spend.get(p.id) } : {}),
    };
  });
}

export async function listPhases(ctx: Ctx, userId: string, projectId: string): Promise<PhaseSummaryDto[]> {
  await requireProjectMember(ctx.pool, userId, projectId);
  return summaries(
    ctx.pool,
    await rows(ctx.pool, `${SUMMARY_SELECT} WHERE p.project_id=$1 ORDER BY p.number DESC`, [projectId]),
    ctx.clock.now(),
    userId,
  );
}

function memberDto(c: Row): PhaseMemberDto {
  const state = memberState(c);
  const outcome = memberOutcome(state);
  return {
    cardId: c.id,
    ref: c.ref,
    title: c.title,
    stage: c.stage,
    status: c.status,
    assignment: c.phase_assignment,
    outcome,
    action: c.finalize_action === 'none' ? null : (c.finalize_action ?? null),
    resultRef: c.finalize_result ?? null,
    merged: !!c.merged_into_working_at,
    branchName: c.branch_name ?? null,
    canConfirmMerge: outcome === 'waiting_merge',
  };
}

async function followupDtos(db: Queryable, phaseId: string): Promise<PhaseFollowupDto[]> {
  const list = await followupRows(db, phaseId);
  const names = await targetNames(
    db,
    list.flatMap((f) => (f.target_id ? [f.target_id as string] : [])),
  );
  const out: PhaseFollowupDto[] = [];
  for (const f of list) {
    const requests = f.devops_request_ids?.length
      ? await rows(
          db,
          `SELECT r.id, r.status, r.thread_id, r.result_summary, w.name AS workstation_name
             FROM devops_requests r JOIN workstations w ON w.id = r.workstation_id WHERE r.id = ANY($1::uuid[])
            ORDER BY r.created_at, r.id`,
          [f.devops_request_ids],
        )
      : [];
    const cards = f.regression_card_ids?.length
      ? await rows(db, 'SELECT id, ref, status FROM cards WHERE id = ANY($1::uuid[]) ORDER BY number', [
          f.regression_card_ids,
        ])
      : [];
    const targetName = f.target_id ? (names.get(f.target_id) ?? null) : null;
    out.push({
      id: f.id,
      position: f.position,
      kind: f.kind,
      label: followupLabel(
        { kind: f.kind, platform: f.platform, instruction: f.instruction },
        f.environment ?? targetName,
      ),
      targetId: f.target_id,
      targetName,
      environment: f.environment ?? null,
      platform: f.platform,
      instruction: f.instruction,
      note: f.note,
      status: f.status,
      delegate: f.delegate,
      brief: f.brief,
      devopsRequests: requests.map((r) => ({
        id: r.id,
        workstationName: r.workstation_name,
        status: r.status,
        threadId: r.thread_id,
        summary: r.result_summary,
      })),
      regressionCards: cards.map((c) => ({ id: c.id, ref: c.ref, status: c.status })),
      resultSummary: f.result_summary,
      evidence: f.evidence ?? {},
      mock: f.mock ?? null,
      startedAt: iso(f.started_at),
      finishedAt: iso(f.finished_at),
    });
  }
  return out;
}

async function detail(
  db: Queryable,
  p: Row,
  projectActive: boolean,
  clock: Date,
  userId: string,
): Promise<PhaseDetailDto> {
  const [summary] = await summaries(db, [p], clock, userId);
  const members = (await memberRows(db, p.id)).map(memberDto);
  const tasks = await rows(
    db,
    'SELECT id, kind, status, note, created_at FROM ba_tasks WHERE phase_id=$1 ORDER BY created_at, id',
    [p.id],
  );
  return {
    ...(summary as PhaseSummaryDto),
    members,
    followupDetails: await followupDtos(db, p.id),
    cardOutcomes: p.card_outcomes ?? [],
    report: p.report,
    outstanding: p.outstanding ?? [],
    resultsReport: p.results_report,
    proposalDeskItemId: p.proposal_desk_item_id,
    reportDeskItemId: p.report_desk_item_id,
    resultsDeskItemId: p.results_desk_item_id,
    threadId: p.id,
    approvedAt: iso(p.approved_at),
    finishedAt: iso(p.finished_at),
    canEditFollowups: projectActive && PHASE_FOLLOWUP_EDITABLE_STATUSES.includes(p.status),
    canAssign: projectActive && PHASE_ASSIGNABLE_STATUSES.includes(p.status),
    canReopen: projectActive && ['reporting', 'awaiting_approval'].includes(p.status),
    tasks: tasks.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      note: t.note,
      createdAt: iso(t.created_at) as string,
    })),
    projectKey: p.project_key,
  };
}

export async function getPhase(ctx: Ctx, userId: string, phaseId: string): Promise<PhaseDetailDto> {
  const p = await one(ctx.pool, `${SUMMARY_SELECT} WHERE p.id=$1`, [phaseId]);
  if (!p) throw notFound('phase not found');
  const project = await loadVisibleProject(ctx.pool, userId, p.project_id);
  return detail(ctx.pool, p, project.status === 'active', ctx.clock.now(), userId);
}

/** `/p/:projectKey/phases/:number`: the key is resolved among the projects the user is a member of. */
export async function getPhaseByNumber(
  ctx: Ctx,
  userId: string,
  projectKey: string,
  number: number,
): Promise<PhaseDetailDto> {
  const p = await one(
    ctx.pool,
    `${SUMMARY_SELECT} JOIN project_members m ON m.project_id = p.project_id AND m.user_id=$1 AND m.status='active'
      WHERE pr.key=$2 AND p.number=$3 ORDER BY (pr.org_id = $1) DESC LIMIT 1`,
    [userId, projectKey, number],
  );
  if (!p) throw notFound('phase not found');
  const project = await loadVisibleProject(ctx.pool, userId, p.project_id);
  return detail(ctx.pool, p, project.status === 'active', ctx.clock.now(), userId);
}

/** The live data a phase desk item renders from. */
export async function phaseDeskBlock(db: Queryable, item: Row): Promise<PhaseDeskBlock | null> {
  const p = await one(
    db,
    `${SUMMARY_SELECT} WHERE p.proposal_desk_item_id=$1 OR p.report_desk_item_id=$1 OR p.results_desk_item_id=$1`,
    [item.id],
  );
  if (!p) return null;
  const project = await one(db, 'SELECT status FROM projects WHERE id=$1', [p.project_id]);
  return {
    phaseId: p.id,
    ref: p.ref,
    name: p.name,
    status: p.status,
    projectKey: p.project_key,
    members: (await memberRows(db, p.id)).map(memberDto),
    followups: await followupDtos(db, p.id),
    cardOutcomes: p.card_outcomes ?? [],
    outstanding: p.outstanding ?? [],
    report: p.report,
    resultsReport: p.results_report,
    canEditFollowups: project?.status === 'active' && PHASE_FOLLOWUP_EDITABLE_STATUSES.includes(p.status),
  };
}

/** The phase chip of a card (board and card page). */
export async function cardPhaseRef(db: Queryable, card: Row) {
  if (!card.phase_id) return null;
  const p = await one(db, 'SELECT id, ref, name, status FROM phases WHERE id=$1', [card.phase_id]);
  return p
    ? { id: p.id, ref: p.ref, name: p.name, status: p.status, assignment: card.phase_assignment }
    : null;
}
