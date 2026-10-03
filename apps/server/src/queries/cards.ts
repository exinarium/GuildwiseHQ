import {
  type BoardResponse,
  boardColumns,
  type CardDetailResponse,
  type CardDto,
  canCommentOnCard,
  canManageCard,
  columnFor,
  getStage,
  type ShiftDto,
  type WorkflowDefinition,
} from '@aom/shared';
import { loadVisibleCard, loadVisibleProject } from '../authz/scope.ts';
import { loadWorkflowById, resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';

const COLUMN_FALLBACK = 'Other';

async function cardColumn(ctx: Ctx, c: Row): Promise<{ column: string; key: string; version: number }> {
  const wf = await loadWorkflowById(ctx.pool, c.workflow_version_id);
  const stage = wf ? getStage(wf.definition, c.stage) : undefined;
  const column = stage
    ? columnFor(
        { status: c.status, stage: c.stage, reworkRound: c.rework_round, cardType: c.card_type },
        stage,
      )
    : COLUMN_FALLBACK;
  return { column, key: wf?.key ?? '', version: wf?.version ?? 0 };
}

export async function toCardDto(ctx: Ctx, c: Row): Promise<CardDto> {
  const { column, key, version } = await cardColumn(ctx, c);
  const deps = await rows(
    ctx.pool,
    `SELECT dc.id, dc.ref, dc.title, dc.status FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id WHERE d.card_id=$1 ORDER BY dc.number`,
    [c.id],
  );
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
    docsNeeded: c.docs_needed,
    completionAction: c.completion_action,
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
    dependencies: deps.map((d) => ({ cardId: d.id, ref: d.ref, title: d.title, status: d.status })),
    createdAt: iso(c.created_at) as string,
    updatedAt: iso(c.updated_at) as string,
    finalizedAt: iso(c.finalized_at),
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
  const ctxAuth = { userId, projectRole: role, cardOwnerUserId: card.owner_user_id };
  const manage = canManageCard(ctxAuth);
  const open = !['done', 'cancelled'].includes(card.status);
  const lastDiff = [...handoffs].reverse().find((h) => h.data?.diffStats);
  return {
    card: await toCardDto(ctx, card),
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
    currentShift: shiftRow ? toShiftDto(shiftRow) : null,
    permissions: {
      canEdit: manage && open,
      canSpecify: manage && card.status === 'draft',
      canMove: manage && open,
      canRelease: manage && !!card.claim_id,
      canCancel: manage && open,
      canComment: canCommentOnCard(role),
    },
    diffStats: lastDiff?.data?.diffStats ?? null,
  };
}

export async function getBoard(ctx: Ctx, userId: string, projectId: string): Promise<BoardResponse> {
  const project = await loadVisibleProject(ctx.pool, userId, projectId);
  const wf = await resolveWorkflow(ctx.pool, project.org_id, project.workflow_key);
  if (!wf) throw notFound('workflow not found');
  const columns = boardColumns(wf.definition as WorkflowDefinition);
  const cards = await rows(
    ctx.pool,
    `SELECT c.*, a.name AS agent_name FROM cards c LEFT JOIN agents a ON a.id = c.claimed_by_agent_id
      WHERE c.project_id=$1 AND c.status <> 'cancelled' ORDER BY c.priority, c.queued_at NULLS LAST, c.number`,
    [projectId],
  );
  const byColumn = new Map<string, BoardResponse['columns'][number]['cards']>(columns.map((c) => [c, []]));
  for (const c of cards) {
    const { column } = await cardColumn(ctx, c);
    if (!byColumn.has(column)) byColumn.set(column, []);
    byColumn.get(column)?.push({
      id: c.id,
      ref: c.ref,
      title: c.title,
      cardType: c.card_type,
      stage: c.stage,
      status: c.status,
      assignee: c.claimed_by_agent_id ? { agentId: c.claimed_by_agent_id, name: c.agent_name } : null,
      updatedAt: iso(c.updated_at) as string,
      queuedAt: iso(c.queued_at),
      riskTier: c.risk_tier,
      blocked: c.status === 'blocked',
      reworkRound: c.rework_round,
      priority: c.priority,
    });
  }
  return {
    projectId,
    workflowKey: wf.key,
    columns: [...byColumn.entries()].map(([name, cs]) => ({ name, cards: cs })),
  };
}
