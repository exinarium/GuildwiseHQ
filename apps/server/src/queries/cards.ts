import {
  type ArchiveQuery,
  type ArchiveResponse,
  type BlockedReason,
  type BoardResponse,
  boardColumnsWith,
  CARD_ARCHIVE_AFTER_HOURS,
  type CardBudget,
  type CardDetailResponse,
  type CardDto,
  type CardHygiene,
  type CardSearchResponse,
  canCommentOnCard,
  canManageCard,
  columnFor,
  getStage,
  movableStages,
  repoFileUrl,
  type ShiftDto,
  scrubRemoteUrl,
  streamId,
  type WorkflowDefinition,
} from '@aom/shared';
import { orgRoleOf } from '../auth/org-context.ts';
import { loadVisibleCard, loadVisibleProject } from '../authz/scope.ts';
import { loadWorkflowById, resolveWorkflow } from '../catalogue/loader.ts';
import { enabledWorkflows } from '../catalogue/project-workflows.ts';
import { cardApprovalDto } from '../commands/approval.ts';
import { attachmentsOf } from '../commands/card-attachments.ts';
import { effectiveCompletion } from '../commands/completion.ts';
import { memberRefusal } from '../commands/phases.ts';
import { cardQaDto } from '../commands/qa.ts';
import { humanPurposeOf } from '../commands/qa-flow.ts';
import { leanCardDto, reviewRiskDto } from '../commands/review-risk.ts';
import type { Ctx } from '../context.ts';
import {
  budgetDto,
  canEditBudget,
  monthSpendByProject,
  orgCostCtx,
  seesAmounts,
  spendBriefs,
} from '../costs/index.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { dependencyStates, landedSql } from '../dispatcher/dependencies.ts';
import { notFound } from '../errors.ts';
import { cardPhaseRef } from './phases.ts';
import { publicationOfCard } from './research.ts';
import { startedByMap, subworkflowsPanel, waitingChildren } from './subworkflows.ts';
import { cardTesting } from './testing.ts';
import { cardWorkability } from './workability.ts';

const COLUMN_FALLBACK = 'Other';

async function cardColumn(ctx: Ctx, c: Row): Promise<{ column: string; key: string; version: number }> {
  const wf = await loadWorkflowById(ctx.pool, c.workflow_version_id);
  const stage = wf ? getStage(wf.definition, c.stage) : undefined;
  const column = stage
    ? columnFor(
        {
          status: c.status,
          stage: c.stage,
          reworkRound: c.rework_round,
          cardType: c.card_type,
          finalizeState: c.finalize_state,
        },
        stage,
      )
    : COLUMN_FALLBACK;
  return { column, key: wf?.key ?? '', version: wf?.version ?? 0 };
}

/** The loop breaker's back-off while it is in force; an expired one is not shown. */
function backoffOf(c: Row, now: Date): { until: string; failures: number } | null {
  if (!c.retry_after || new Date(c.retry_after) <= now) return null;
  return { until: iso(c.retry_after) as string, failures: Number(c.retry_failures) };
}

/** The architect's recorded report as the card shows it; a repository report links to its file on the card branch. */
async function investigationDto(ctx: Ctx, c: Row): Promise<CardDto['investigation']> {
  const inv = c.investigation as {
    reportPath: string;
    location: 'repo' | 'vault';
    summary: string;
    commit: string | null;
    at: string;
  } | null;
  if (!inv) return null;
  let url: string | null = null;
  if (inv.location === 'repo' && c.repo_id && c.branch_name) {
    const repo = await one(ctx.pool, 'SELECT remote_url, forge_kind FROM project_repos WHERE id=$1', [
      c.repo_id,
    ]);
    if (repo)
      url = repoFileUrl(scrubRemoteUrl(repo.remote_url), c.branch_name, inv.reportPath, repo.forge_kind);
  }
  return {
    reportPath: inv.reportPath,
    location: inv.location,
    summary: inv.summary,
    commit: inv.commit ?? null,
    url,
    at: iso(inv.at) as string,
  };
}

/** A design made before its dependencies landed: waiting for them, due for the assumption review, or reviewed. */
function designReviewOf(c: Row, deps: Array<{ landed: boolean }>): CardDto['designReview'] {
  const r = c.design_review as {
    state: 'waiting' | 'reviewed';
    dependencies?: string[];
    result?: { confirmed: number; revised: number; note: string };
  } | null;
  if (!r) return null;
  return {
    state: r.state === 'reviewed' ? 'reviewed' : deps.every((d) => d.landed) ? 'review_due' : 'waiting',
    dependencies: r.dependencies ?? [],
    assumptions: (c.investigation?.assumptions ?? []) as Array<{
      assumption: string;
      dependency: string;
      ifWrong: string;
    }>,
    result: r.result ?? null,
  };
}

export async function toCardDto(ctx: Ctx, c: Row): Promise<CardDto> {
  const { column, key, version } = await cardColumn(ctx, c);
  const deps = await dependencyStates(ctx.pool, c.id);
  const completion = await effectiveCompletion(ctx.pool, c);
  const agent = c.claimed_by_agent_id
    ? await one(ctx.pool, 'SELECT name FROM agents WHERE id=$1', [c.claimed_by_agent_id])
    : undefined;
  return {
    id: c.id,
    projectId: c.project_id,
    number: c.number,
    ref: c.ref,
    title: c.title,
    cardType: c.card_type,
    workflowKey: key,
    workflowVersion: version,
    stage: c.stage,
    status: c.status,
    column,
    fields: c.fields,
    ownerUserId: c.owner_user_id,
    decisionPolicy: c.decision_policy,
    riskTier: c.risk_tier,
    riskTierOverridden: c.risk_tier_overridden,
    reviewRisk: reviewRiskDto(c),
    ...(c.head_sha || c.group_id || c.card_brief ? { lean: leanCardDto(c) } : {}),
    docsNeeded: c.docs_needed,
    designNeeded: c.design_needed ?? false,
    investigationOnly: c.investigation_only ?? false,
    mergeMainFirst: c.merge_main_first ?? null,
    investigation: await investigationDto(ctx, c),
    mainSync: c.main_sync
      ? {
          result: c.main_sync.result,
          mainBranch: c.main_sync.mainBranch ?? null,
          workingBranch: c.main_sync.workingBranch ?? null,
          files: c.main_sync.files ?? [],
          at: iso(c.main_sync.at) as string,
        }
      : null,
    completionAction: c.completion_action,
    effectiveCompletionAction: completion.action,
    completionActionSource: completion.source,
    repoId: c.repo_id,
    baseBranch: c.base_branch,
    branchName: c.branch_name,
    homeWorkstationId: c.home_workstation_id,
    parentCardId: c.parent_card_id,
    origin: c.origin,
    scheduled: c.scheduled,
    priority: c.priority,
    reworkRound: c.rework_round,
    claimedByAgentId: c.claimed_by_agent_id,
    claimedByAgentName: agent?.name ?? null,
    claimedAt: iso(c.claimed_at),
    queuedAt: iso(c.queued_at),
    blockedSince: iso(c.blocked_since),
    dependencies: deps.map((d) => ({
      cardId: d.id,
      ref: d.ref,
      title: d.title,
      status: d.status as CardDto['dependencies'][number]['status'],
      stage: d.stage,
      landed: d.landed,
    })),
    designReview: designReviewOf(c, deps),
    createdAt: iso(c.created_at) as string,
    updatedAt: iso(c.updated_at) as string,
    finalizedAt: iso(c.finalized_at),
    backoff: backoffOf(c, ctx.clock.now()),
  };
}

export function toShiftDto(s: Row): ShiftDto {
  return {
    id: s.id,
    agentId: s.agent_id,
    agentName: s.agent_name ?? undefined,
    workstationId: s.workstation_id,
    cardId: s.card_id,
    cardRef: s.card_ref ?? null,
    kind: s.kind,
    stage: s.stage,
    status: s.status,
    outcome: s.outcome,
    reportOutcome: s.report_outcome,
    runtime: s.runtime,
    model: s.model,
    overflow: s.overflow,
    startedAt: iso(s.started_at) as string,
    endedAt: iso(s.ended_at),
    durationMs: s.duration_ms,
    tokensInput: s.tokens_input === null ? null : Number(s.tokens_input),
    tokensOutput: s.tokens_output === null ? null : Number(s.tokens_output),
    tokensCacheRead: s.tokens_cache_read === null ? null : Number(s.tokens_cache_read),
    tokensCacheWrite: s.tokens_cache_write === null ? null : Number(s.tokens_cache_write),
    progressTail: s.progress_tail,
    mcpCalls: s.mcp_calls ?? [],
  };
}

export const SHIFT_SELECT = `SELECT s.*, a.name AS agent_name, c.ref AS card_ref FROM shifts s
  JOIN agents a ON a.id = s.agent_id LEFT JOIN cards c ON c.id = s.card_id`;

export async function getCardDetail(ctx: Ctx, userId: string, idOrRef: string): Promise<CardDetailResponse> {
  const { card, role } = await loadVisibleCard(ctx.pool, userId, idOrRef);
  const handoffs = await rows(
    ctx.pool,
    `SELECT h.*, a.name AS agent_name FROM card_handoffs h LEFT JOIN agents a ON a.id = h.agent_id
      WHERE h.card_id=$1 ORDER BY h.created_at, h.event_seq`,
    [card.id],
  );
  const transitions = await rows(ctx.pool, 'SELECT * FROM card_transitions WHERE card_id=$1 ORDER BY id', [
    card.id,
  ]);
  const activity = await rows(
    ctx.pool,
    `SELECT a.*, u.display_name AS user_name, ag.name AS agent_name FROM card_activity a
       LEFT JOIN users u ON u.id = a.user_id LEFT JOIN agents ag ON ag.id = a.agent_id
      WHERE a.card_id=$1 ORDER BY a.id`,
    [card.id],
  );
  const thread = await rows(
    ctx.pool,
    `SELECT m.*, u.display_name AS user_name, a.name AS agent_name FROM thread_messages m
       LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN agents a ON a.id = m.author_agent_id
      WHERE m.thread_id=$1 ORDER BY m.created_at, m.event_seq`,
    [card.id],
  );
  const shiftRow =
    (card.claim_shift_id && (await one(ctx.pool, `${SHIFT_SELECT} WHERE s.id=$1`, [card.claim_shift_id]))) ||
    (await one(
      ctx.pool,
      `${SHIFT_SELECT} WHERE s.card_id=$1 AND s.status <> 'ended' ORDER BY s.started_at DESC LIMIT 1`,
      [card.id],
    ));
  const mcpShifts = await rows(
    ctx.pool,
    `SELECT s.id, s.stage, s.started_at, s.mcp_calls, a.name AS agent_name FROM shifts s
       JOIN agents a ON a.id = s.agent_id
      WHERE s.card_id=$1 AND jsonb_array_length(s.mcp_calls) > 0 ORDER BY s.started_at`,
    [card.id],
  );
  const ctxAuth = { userId, projectRole: role, cardOwnerUserId: card.owner_user_id };
  const manage = canManageCard(ctxAuth);
  const open = !['done', 'cancelled'].includes(card.status);
  const wf = manage && open ? await loadWorkflowById(ctx.pool, card.workflow_version_id) : undefined;
  const lastDiff = [...handoffs].reverse().find((h) => h.data?.diffStats);
  const workability = (await cardWorkability(ctx, [card])).get(card.id);
  return {
    card: await toCardDto(ctx, card),
    ...(workability ? { workability } : {}),
    handoffs: handoffs.map((h) => ({
      id: h.id,
      cardId: h.card_id,
      shiftId: h.shift_id,
      agentId: h.agent_id,
      agentName: h.agent_name,
      stage: h.stage,
      outcome: h.outcome,
      note: h.note,
      data: h.data,
      createdAt: iso(h.created_at) as string,
    })),
    transitions: transitions.map((t) => ({
      id: Number(t.id),
      fromStage: t.from_stage,
      toStage: t.to_stage,
      fromStatus: t.from_status,
      toStatus: t.to_status,
      agentId: t.agent_id,
      userId: t.user_id,
      reason: t.reason,
      at: iso(t.at) as string,
    })),
    activity: activity.map((a) => ({
      id: Number(a.id),
      kind: a.kind,
      summary: a.summary,
      reason: a.reason,
      userId: a.user_id,
      agentId: a.agent_id,
      actorName: a.user_name ?? a.agent_name ?? null,
      at: iso(a.at) as string,
    })),
    threadId: card.id,
    thread: thread.map((m) => ({
      id: m.id,
      threadId: m.thread_id,
      authorKind: m.author_kind,
      authorUserId: m.author_user_id,
      authorAgentId: m.author_agent_id,
      authorName: m.user_name ?? m.agent_name ?? null,
      kind: m.kind,
      body: m.body,
      data: m.data,
      createdAt: iso(m.created_at) as string,
    })),
    attachments: await attachmentsOf(ctx.pool, card.id),
    currentShift: shiftRow ? toShiftDto(shiftRow) : null,
    mcpUsage: mcpShifts.map((s) => ({
      shiftId: s.id,
      agentName: s.agent_name ?? null,
      stage: s.stage ?? null,
      startedAt: iso(s.started_at) as string,
      calls: s.mcp_calls,
    })),
    permissions: {
      canEdit: manage && (card.status === 'draft' || (card.status === 'queued' && !card.claim_id)),
      canEditPriority: manage && card.status !== 'cancelled',
      canEditCompletion:
        manage && open && !['awaiting_approval', 'running'].includes(card.finalize_state ?? ''),
      canSetRisk: manage && open && !['awaiting_approval', 'running'].includes(card.finalize_state ?? ''),
      canSetPhase: open && memberRefusal(card) === null,
      canSpecify: manage && card.status === 'draft',
      canMove: manage && open,
      canRelease: manage && !!card.claim_id,
      canReleaseBackoff: manage && open && !!backoffOf(card, ctx.clock.now()),
      canCancel: manage && open,
      canReopen: manage && !open,
      canComment: canCommentOnCard(role),
      canAttach: manage && open,
    },
    moveTargets:
      manage && open && wf
        ? movableStages(wf.definition, card.stage).map((st) => ({
            id: st.id,
            label: st.label,
            kind: st.kind,
          }))
        : [],
    diffStats: lastDiff?.data?.diffStats ?? null,
    testing: await cardTesting(ctx, card, manage),
    subworkflows: await subworkflowsPanel(ctx, userId, card),
    qa: await cardQaDto(ctx.pool, card, { id: userId }, role),
    approval: await cardApprovalDto(ctx.pool, card, { id: userId }, role),
    blockers: (
      await rows(
        ctx.pool,
        `SELECT d.id, d.title, d.keep_blocked_until FROM card_blockers b JOIN desk_items d ON d.id = b.desk_item_id
          WHERE b.card_id=$1 AND (d.status='open' OR d.keep_blocked_until IS NOT NULL) ORDER BY d.created_at`,
        [card.id],
      )
    ).map((b) => ({
      deskItemId: b.id,
      title: b.title,
      ...(b.keep_blocked_until ? { keepBlockedUntil: b.keep_blocked_until as string } : {}),
    })),
    publication: await publicationOfCard(ctx.pool, card.id),
    phase: await cardPhaseRef(ctx.pool, card),
    ...(await splitLinks(ctx, card)),
    ...((await orgRoleOf(ctx.pool, userId, card.org_id))
      ? {
          spend: (
            await spendBriefs(ctx.pool, await orgCostCtx(ctx.pool, card.org_id), ctx.clock.now(), 'card', [
              card.id,
            ])
          ).get(card.id),
        }
      : {}),
  };
}

/**
 * What the board cards say beyond workability and back-off (T1): the reason behind "Blocked" (the desk item holding
 * the card), open hygiene findings on the card's repository, and the project's budget when it is at the warning level
 * or beyond. Each map is keyed by card id and holds only cards that have something to say.
 */
export async function boardNotices(
  ctx: Ctx,
  userId: string,
  project: Row,
  cards: Row[],
): Promise<{
  blocked: Map<string, BlockedReason>;
  hygiene: Map<string, CardHygiene[]>;
  budget: CardBudget | null;
}> {
  const blocked = new Map<string, BlockedReason>();
  const blockedIds = cards.filter((c) => c.status === 'blocked').map((c) => c.id as string);
  if (blockedIds.length > 0) {
    const held = await rows(
      ctx.pool,
      `SELECT cb.card_id, d.id, d.kind, d.title FROM card_blockers cb JOIN desk_items d ON d.id = cb.desk_item_id
        WHERE cb.card_id = ANY($1::uuid[]) AND (d.status = 'open' OR d.keep_blocked_until IS NOT NULL)
        ORDER BY d.created_at`,
      [blockedIds],
    );
    for (const h of held) {
      const prev = blocked.get(h.card_id);
      if (prev) prev.others += 1;
      else blocked.set(h.card_id, { deskItemId: h.id, kind: h.kind, title: h.title, others: 0 });
    }
  }
  const hygiene = new Map<string, CardHygiene[]>();
  const repoIds = [
    ...new Set(cards.filter((c) => c.repo_id && c.status !== 'done').map((c) => c.repo_id as string)),
  ];
  if (repoIds.length > 0) {
    const found = await rows(
      ctx.pool,
      `SELECT subject, kind, subject_name, detail FROM hygiene_findings
        WHERE status = 'open' AND project_id = $1 AND subject = ANY($2::text[]) ORDER BY first_seen_at`,
      [project.id, repoIds],
    );
    for (const c of cards) {
      if (!c.repo_id || c.status === 'done') continue;
      const mine = found.filter((f) => f.subject === c.repo_id);
      if (mine.length > 0)
        hygiene.set(
          c.id,
          mine.map((f) => ({
            kind: f.kind,
            repoName: f.subject_name,
            detail: String(f.detail ?? '').slice(0, 300),
          })),
        );
    }
  }
  let budget: CardBudget | null = null;
  if (project.budget_micros !== null && project.budget_micros !== undefined) {
    const role = await orgRoleOf(ctx.pool, userId, project.org_id);
    const c = await orgCostCtx(ctx.pool, project.org_id);
    const now = ctx.clock.now();
    const spend = await monthSpendByProject(ctx.pool, c, now, [project.id]);
    const b = budgetDto(project, spend.get(project.id) ?? 0, c, now, {
      canEdit: canEditBudget(role),
      showAmounts: seesAmounts(role),
    });
    const percent = b.percent ?? null;
    if (b.state === 'warning' || b.state === 'paused' || b.state === 'overridden')
      budget = { state: b.state, percent, resetsAt: b.resetsAt, canEdit: b.canEdit };
  }
  return { blocked, hygiene, budget };
}

/** Cards finished before this moment are archived: they are off the board and listed in the project's archive. */
export const archiveCutoff = (now: Date): Date =>
  new Date(now.getTime() - CARD_ARCHIVE_AFTER_HOURS * 3_600_000);

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The archive of a project: done and cancelled cards finished more than a day ago, newest first, searchable and filterable. */
export async function getArchive(ctx: Ctx, userId: string, query: ArchiveQuery): Promise<ArchiveResponse> {
  const project = await loadVisibleProject(ctx.pool, userId, query.projectId);
  const where: string[] = [
    `c.project_id = $1`,
    `c.finished_at IS NOT NULL`,
    `c.finished_at <= $2`,
    `c.status IN ('done','cancelled')`,
  ];
  const args: unknown[] = [project.id, archiveCutoff(ctx.clock.now())];
  const arg = (v: unknown) => `$${args.push(v)}`;
  if (query.status) where.push(`c.status = ${arg(query.status)}`);
  if (query.q) {
    const like = `%${escapeLike(query.q)}%`;
    const pfx = arg(`${escapeLike(query.q)}%`);
    const lk = arg(like);
    where.push(`(c.ref ILIKE ${pfx} OR c.title ILIKE ${lk} OR c.fields->>'externalRef' ILIKE ${lk})`);
  }
  if (query.from) where.push(`c.finished_at >= ${arg(`${query.from}T00:00:00Z`)}::timestamptz`);
  if (query.to)
    where.push(`c.finished_at < (${arg(`${query.to}T00:00:00Z`)}::timestamptz + interval '1 day')`);
  if (query.agentId)
    where.push(
      `EXISTS (SELECT 1 FROM card_handoffs h WHERE h.card_id = c.id AND h.agent_id = ${arg(query.agentId)})`,
    );
  const clause = where.join(' AND ');
  const total = Number(
    (await one(ctx.pool, `SELECT count(*)::int AS n FROM cards c WHERE ${clause}`, args))?.n ?? 0,
  );
  const list = await rows(
    ctx.pool,
    `SELECT c.id, c.ref, c.title, c.card_type, c.status, c.priority, c.finished_at, c.finalize_action,
            c.fields->>'externalRef' AS external_ref,
            (SELECT a.name FROM card_handoffs h JOIN agents a ON a.id = h.agent_id
              WHERE h.card_id = c.id ORDER BY h.created_at DESC LIMIT 1) AS last_agent
       FROM cards c WHERE ${clause}
      ORDER BY c.finished_at DESC, c.number DESC
      LIMIT ${arg(query.pageSize)} OFFSET ${arg((query.page - 1) * query.pageSize)}`,
    args,
  );
  return {
    projectId: project.id,
    afterHours: CARD_ARCHIVE_AFTER_HOURS,
    total,
    page: query.page,
    pageSize: query.pageSize,
    cards: list.map((c) => ({
      id: c.id,
      ref: c.ref,
      title: c.title,
      cardType: c.card_type,
      status: c.status,
      externalRef: c.external_ref ?? null,
      priority: c.priority,
      finishedAt: iso(c.finished_at) as string,
      completionAction: c.finalize_action ?? null,
      lastAgent: c.last_agent ?? null,
    })),
  };
}

export async function getBoard(
  ctx: Ctx,
  userId: string,
  projectId: string,
  phaseId?: string,
): Promise<BoardResponse> {
  const project = await loadVisibleProject(ctx.pool, userId, projectId);
  const wf = await resolveWorkflow(ctx.pool, project.org_id, project.workflow_key);
  if (!wf) throw notFound('workflow not found');
  const cards = await rows(
    ctx.pool,
    `SELECT c.*, a.name AS agent_name, wo.id AS waiting_on_id, wo.ref AS waiting_on_ref, ph.ref AS phase_ref
       FROM cards c LEFT JOIN agents a ON a.id = c.claimed_by_agent_id
       LEFT JOIN phases ph ON ph.id = c.phase_id
       LEFT JOIN LATERAL (SELECT ch.id, ch.ref FROM cards ch WHERE ch.parent_card_id = c.id AND ch.origin = 'test_failure'
                             AND ch.status NOT IN ('done','cancelled') ORDER BY ch.number DESC LIMIT 1) wo ON c.status = 'waiting'
      WHERE c.project_id=$1 AND c.status <> 'cancelled'
        AND ($2::text IS NULL OR ($2 = 'none' AND c.phase_id IS NULL) OR c.phase_id::text = $2)
        AND (c.finished_at IS NULL OR c.finished_at > $3)
      ORDER BY c.priority, c.queued_at NULLS LAST, c.number`,
    [projectId, phaseId ?? null, archiveCutoff(ctx.clock.now())],
  );
  // Open cards that run on other workflows than the project's (research cards in a code project, cards kept through a
  // conversion) add their columns before the terminal one; they show only while such cards exist.
  const others: WorkflowDefinition[] = [];
  const keyOf = new Map<string, string>();
  for (const c of cards) {
    if (keyOf.has(c.workflow_version_id)) continue;
    const w = await loadWorkflowById(ctx.pool, c.workflow_version_id);
    keyOf.set(c.workflow_version_id, w?.key ?? '');
    if (
      w &&
      w.key !== wf.key &&
      cards.some((o) => o.workflow_version_id === c.workflow_version_id && o.status !== 'done')
    )
      others.push(w.definition);
  }
  // Workflows the project enabled besides its primary always show their columns (docs/design/architect-and-workflows.md 4.3).
  for (const e of await enabledWorkflows(ctx.pool, project)) {
    if (e.isPrimary || e.workflowKey === wf.key || others.some((o) => o.key === e.workflowKey)) continue;
    const w = await resolveWorkflow(ctx.pool, project.org_id, e.workflowKey, project.id);
    if (w) others.push(w.definition);
  }
  const columns = boardColumnsWith(wf.definition as WorkflowDefinition, others);
  const workability = await cardWorkability(ctx, cards);
  const notices = await boardNotices(ctx, userId, project, cards);
  // Designs made before their dependencies landed: the refs still not landed (computed now, so a landed one drops out).
  const heldIds = cards
    .filter((c) => (c.design_review as { state?: string } | null)?.state === 'waiting')
    .map((c) => c.id as string);
  const heldRefs = new Map<string, string[]>();
  if (heldIds.length > 0)
    for (const d of await rows(
      ctx.pool,
      `SELECT d.card_id, dc.ref FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id
        WHERE d.card_id = ANY($1::uuid[]) AND NOT ${landedSql('dc')} ORDER BY dc.number`,
      [heldIds],
    ))
      heldRefs.set(d.card_id, [...(heldRefs.get(d.card_id) ?? []), d.ref]);
  // What each card has cost (members of the organization only; amounts are the organization's business).
  const spendOf = (await orgRoleOf(ctx.pool, userId, project.org_id))
    ? await spendBriefs(
        ctx.pool,
        await orgCostCtx(ctx.pool, project.org_id),
        ctx.clock.now(),
        'card',
        cards.map((c) => c.id as string),
      )
    : new Map();
  const subWaiting = await waitingChildren(
    ctx,
    userId,
    cards.filter((c) => c.status === 'waiting').map((c) => c.id as string),
  );
  const subStarted = await startedByMap(
    ctx,
    cards.filter((c) => c.origin === 'subworkflow').map((c) => c.id as string),
  );
  const byColumn = new Map<string, BoardResponse['columns'][number]['cards']>(columns.map((c) => [c, []]));
  // Steps for a person (manual QA, approval; a custom workflow's too): who each such card waits for.
  const humanOf = new Map<string, 'qa' | 'approval'>();
  for (const c of cards)
    if (c.status === 'waiting' || c.status === 'queued') {
      const p = await humanPurposeOf(ctx.pool, c);
      if (p) humanOf.set(c.id as string, p);
    }
  const isQaCard = (c: Row) => c.stage === 'qa_steps' || humanOf.get(c.id) === 'qa';
  const approvalOf = (c: Row) =>
    humanOf.get(c.id) === 'approval' && c.approval?.state === 'open' && c.approval.stageId === c.stage
      ? (c.approval as { approverUserId: string })
      : null;
  const qaPeople = new Map<string, string>(
    (
      await rows(ctx.pool, `SELECT id, display_name FROM users WHERE id = ANY($1::uuid[])`, [
        [
          ...cards
            .filter((c) => isQaCard(c) && c.qa?.assigneeUserId)
            .map((c) => c.qa.assigneeUserId as string),
          ...cards.map((c) => approvalOf(c)?.approverUserId).filter((x): x is string => !!x),
        ],
      ])
    ).map((u) => [u.id as string, u.display_name as string]),
  );
  const stageLabelOf = new Map<string, string>();
  for (const c of cards)
    if (humanOf.get(c.id) === 'approval') {
      const w = await loadWorkflowById(ctx.pool, c.workflow_version_id);
      stageLabelOf.set(c.id as string, (w ? getStage(w.definition, c.stage)?.label : undefined) ?? c.stage);
    }
  for (const c of cards) {
    const { column } = await cardColumn(ctx, c);
    if (!byColumn.has(column)) byColumn.set(column, []);
    byColumn.get(column)?.push({
      id: c.id,
      ref: c.ref,
      title: c.title,
      cardType: c.card_type,
      ...(keyOf.get(c.workflow_version_id) && keyOf.get(c.workflow_version_id) !== wf.key
        ? { workflowKey: keyOf.get(c.workflow_version_id) as string }
        : {}),
      stage: c.stage,
      status: c.status,
      assignee: c.claimed_by_agent_id ? { agentId: c.claimed_by_agent_id, name: c.agent_name } : null,
      updatedAt: iso(c.updated_at) as string,
      queuedAt: iso(c.queued_at),
      riskTier: c.risk_tier,
      blocked: c.status === 'blocked',
      reworkRound: c.rework_round,
      priority: c.priority,
      waitingFor:
        c.status !== 'waiting'
          ? null
          : humanOf.get(c.id) === 'qa'
            ? 'qa'
            : approvalOf(c)
              ? 'approval_step'
              : subWaiting.has(c.id)
                ? 'subworkflow'
                : c.finalize_state === 'awaiting_approval'
                  ? 'approval'
                  : c.finalize_state === 'running'
                    ? 'finalizing'
                    : c.parked_request_id && !c.waiting_on_id
                      ? 'devops'
                      : 'bug',
      waitingOn: subWaiting.has(c.id)
        ? (subWaiting.get(c.id) as NonNullable<ReturnType<typeof subWaiting.get>>)
        : c.waiting_on_id
          ? { id: c.waiting_on_id, ref: c.waiting_on_ref }
          : null,
      ...(subStarted.has(c.id) ? { startedBy: subStarted.get(c.id) } : {}),
      ...(approvalOf(c)
        ? {
            approval: {
              approverUserId: (approvalOf(c) as { approverUserId: string }).approverUserId,
              approverName:
                qaPeople.get((approvalOf(c) as { approverUserId: string }).approverUserId) ?? 'someone',
              stageLabel: stageLabelOf.get(c.id) ?? c.stage,
            },
          }
        : {}),
      ...(isQaCard(c) && c.qa?.assigneeUserId
        ? {
            qa: {
              state: c.stage === 'qa_steps' ? ('steps' as const) : ('open' as const),
              assigneeUserId: c.qa.assigneeUserId as string,
              assigneeName: qaPeople.get(c.qa.assigneeUserId) ?? 'someone',
            },
          }
        : {}),
      origin: c.origin,
      backoff: backoffOf(c, ctx.clock.now()),
      ...(heldIds.includes(c.id) ? { designHeld: { waitingFor: heldRefs.get(c.id) ?? [] } } : {}),
      phase: c.phase_id ? { id: c.phase_id, ref: c.phase_ref, assignment: c.phase_assignment } : null,
      ...(notices.blocked.has(c.id) ? { blockedReason: notices.blocked.get(c.id) as BlockedReason } : {}),
      ...(notices.hygiene.has(c.id) ? { hygiene: notices.hygiene.get(c.id) as CardHygiene[] } : {}),
      // A paused budget holds back what is still queued; a warning or override matters to anything not finished.
      ...(notices.budget &&
      (notices.budget.state === 'paused'
        ? c.status === 'queued'
        : c.status === 'queued' || c.status === 'claimed')
        ? { budget: notices.budget }
        : {}),
      ...(workability.get(c.id)?.ok === false ? { workability: workability.get(c.id) } : {}),
      ...(spendOf.get(c.id)
        ? { spend: { totalMicros: spendOf.get(c.id).totalMicros, currency: spendOf.get(c.id).currency } }
        : {}),
    });
  }
  // The Investigate & design column shows only for projects that switched the design step on, or while a card is in it.
  const designColumns = new Set(
    (wf.definition as WorkflowDefinition).stages
      .filter((s) => s.when?.field === 'designNeeded')
      .map((s) => s.column),
  );
  // The QA column shows while the project has manual QA on, or while a card is in it.
  const qaColumns = new Set(
    (wf.definition as WorkflowDefinition).stages
      .filter((s) => s.when?.field === 'manualQa')
      .map((s) => s.column),
  );
  return {
    projectId,
    workflowKey: wf.key,
    columns: [...byColumn.entries()]
      .filter(([name, cs]) => cs.length > 0 || !designColumns.has(name) || project.design_step === true)
      .filter(([name, cs]) => cs.length > 0 || !qaColumns.has(name) || project.manual_qa !== false)
      .map(([name, cs]) => ({ name, cards: cs })),
  };
}

/**
 * Cards of the projects the user is an active member of, by ref prefix or title text (the command palette). The
 * hidden projects behind interests (`kind = 'interest'`) are never listed: their cards are scan runs, reached through
 * the interest itself.
 */
export async function searchCards(
  db: Queryable,
  userId: string,
  q: string,
  limit: number,
): Promise<CardSearchResponse> {
  const esc = q.replace(/[\\%_]/g, (c) => `\\${c}`);
  const like = `%${esc}%`;
  const list = await rows(
    db,
    `SELECT c.id, c.ref, c.title, c.status, p.key AS project_key, p.name AS project_name
       FROM cards c
       JOIN projects p ON p.id = c.project_id AND p.status = 'active' AND p.kind <> 'interest'
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1 AND pm.status = 'active'
      WHERE c.status <> 'cancelled' AND (lower(c.ref) LIKE lower($3) || '%' OR c.title ILIKE $2)
      ORDER BY (lower(c.ref) = lower($4)) DESC, (lower(c.ref) LIKE lower($3) || '%') DESC, c.updated_at DESC
      LIMIT $5`,
    [userId, like, esc, q, limit],
  );
  return {
    cards: list.map((c) => ({
      id: c.id,
      ref: c.ref,
      title: c.title,
      status: c.status,
      projectKey: c.project_key,
      projectName: c.project_name,
    })),
  };
}

/**
 * Repository scoping: the cards a split card was replaced by (read from its `CardCancelled{cause:'split'}`, so a card
 * that merely has children is not mistaken for one), and the split parent of a child.
 */
async function splitLinks(ctx: Ctx, card: Row): Promise<Pick<CardDetailResponse, 'splitInto' | 'splitFrom'>> {
  const out: Pick<CardDetailResponse, 'splitInto' | 'splitFrom'> = {};
  const idsOf = async (cardId: string): Promise<string[]> => {
    const ev = await one<{ ids: string[] | null }>(
      ctx.pool,
      `SELECT payload->'childCardIds' AS ids FROM events
        WHERE stream_id=$1 AND type='CardCancelled' AND payload->>'cause'='split' ORDER BY seq DESC LIMIT 1`,
      [streamId.card(cardId)],
    );
    return ev?.ids ?? [];
  };
  if (card.status === 'cancelled') {
    const ids = await idsOf(card.id);
    if (ids.length) {
      const kids = await rows(
        ctx.pool,
        `SELECT c.id, c.ref, c.title, c.status, r.name AS repo_name FROM cards c
           LEFT JOIN project_repos r ON r.id = c.repo_id WHERE c.id = ANY($1::uuid[]) ORDER BY c.number`,
        [ids],
      );
      out.splitInto = kids.map((k) => ({
        id: k.id,
        ref: k.ref,
        title: k.title,
        status: k.status,
        repoName: k.repo_name ?? null,
      }));
    }
  }
  if (card.parent_card_id && (await idsOf(card.parent_card_id)).includes(card.id)) {
    const parent = await one(ctx.pool, 'SELECT id, ref FROM cards WHERE id=$1', [card.parent_card_id]);
    if (parent) out.splitFrom = { id: parent.id, ref: parent.ref };
  }
  return out;
}
