import { randomUUID } from 'node:crypto';
import {
  AgentPermissionsSchema,
  type AgentRuntimeSpec,
  DevOpsAccessSchema,
  devopsBriefOutcomes,
  effectiveFeatures,
  getStage,
  type ServerToRunnerOf,
  type ShiftBrief,
  type WorktreeSpec,
} from '@aom/shared';
import { loadRole, loadWorkflowById } from '../catalogue/loader.ts';
import { scoutCandidates, seenUrls, tasteSeedFor } from '../commands/feeds.ts';
import { vaultForProject } from '../commands/vaults.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import type { ClaimResult } from '../dispatcher/claim.ts';
import { cardLedgerEntries, standingOrdersFor } from '../queries/ledger.ts';

type ShiftStartPayload = Omit<ServerToRunnerOf<'shift.start'>, 'v' | 'id' | 'type' | 'ts'>;

export function agentSpec(a: Row): AgentRuntimeSpec {
  return {
    agentId: a.id,
    name: a.name,
    roleKey: a.role_key,
    seniority: a.seniority,
    runtime: a.runtime,
    model: a.model,
    effort: a.effort ?? undefined,
    skills: a.skills,
    permissions: AgentPermissionsSchema.parse(a.permissions),
    isDevops: a.is_devops,
  };
}

/** The agent as its runner sees it, with `browser` off when the organization has the browser-tools feature switched off. */
export async function agentSpecFor(ctx: Ctx, a: Row): Promise<AgentRuntimeSpec> {
  const spec = agentSpec(a);
  if (!spec.permissions.browser) return spec;
  const org = await one(ctx.pool, 'SELECT plan, features FROM organizations WHERE id=$1', [a.org_id]);
  if (org && !effectiveFeatures(org.plan, org.features).browserTools)
    return { ...spec, permissions: { ...spec.permissions, browser: false } };
  return spec;
}

/** Brief for one card shift: what the agent sees (docs/ARCHITECTURE.md section 11.2, ShiftBrief). */
export async function buildBrief(ctx: Ctx, shift: Row): Promise<ShiftBrief | null> {
  const card = await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1', [shift.card_id]);
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [shift.agent_id]);
  if (!card || !agent) return null;
  const project = (await one(ctx.pool, 'SELECT * FROM projects WHERE id=$1', [card.project_id])) as Row;
  const wf = await loadWorkflowById(ctx.pool, card.workflow_version_id);
  const stage = wf ? getStage(wf.definition, shift.stage ?? card.stage) : undefined;
  const role = await loadRole(ctx.pool, agent.org_id, agent.role_key, agent.role_version);
  if (!wf || !stage || !role) return null;
  const ext = await one(ctx.pool, 'SELECT extensions FROM role_extensions WHERE org_id=$1 AND role_key=$2', [
    agent.org_id,
    agent.role_key,
  ]);

  const handoffs = await rows(
    ctx.pool,
    `SELECT h.*, a.name AS agent_name FROM card_handoffs h LEFT JOIN agents a ON a.id = h.agent_id
      WHERE h.card_id=$1 ORDER BY h.created_at, h.event_seq`,
    [card.id],
  );
  const lastChanges = [...handoffs]
    .reverse()
    .find((h) => h.outcome === 'changes' || h.outcome === 'unsupported');
  const thread = await rows(
    ctx.pool,
    `SELECT m.*, u.display_name AS user_name, a.name AS agent_name FROM thread_messages m
       LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN agents a ON a.id = m.author_agent_id
      WHERE m.thread_id=$1 ORDER BY m.created_at DESC, m.event_seq DESC LIMIT 30`,
    [card.id],
  );
  const deps = await rows(
    ctx.pool,
    `SELECT dc.ref, dc.title, dc.status FROM card_dependencies d JOIN cards dc ON dc.id = d.depends_on_card_id WHERE d.card_id=$1`,
    [card.id],
  );
  const parent = card.parent_card_id
    ? await one(ctx.pool, 'SELECT ref, title FROM cards WHERE id=$1', [card.parent_card_id])
    : undefined;
  const extension = ext?.extensions as
    | { instructions?: string; skills?: string[]; standingOrders?: string[] }
    | undefined;
  const mergedInstr = extension?.instructions;

  return {
    shift: {
      id: shift.id,
      kind: shift.kind,
      stage: stage.id,
      stageLabel: stage.label,
      doneCriteria: stage.doneCriteria,
      outcomes: stage.outcomes.map((o) => ({ id: o.id, label: o.label, kind: o.kind, data: o.data })),
      maxShiftMinutes: stage.maxShiftMinutes,
    },
    agent: { id: agent.id, name: agent.name, seniority: agent.seniority },
    card: {
      id: card.id,
      ref: card.ref,
      title: card.title,
      cardType: card.card_type,
      fields: card.fields,
      riskTier: card.risk_tier,
      reworkRound: card.rework_round,
      completionAction: card.completion_action,
      docsNeeded: card.docs_needed,
      dependencies: deps.map((d) => ({ ref: d.ref, title: d.title, status: d.status })),
      parent: parent ? { ref: parent.ref, title: parent.title } : undefined,
    },
    project: {
      id: project.id,
      key: project.key,
      name: project.name,
      workingBranch: project.working_branch,
      e2eGlobs: project.e2e_globs,
      architecturalGlobs: project.architectural_globs,
      vaultFolder: project.vault_folder ?? undefined,
    },
    role: {
      key: role.definition.key,
      name: role.definition.name,
      instructions: role.definition.instructions,
      coreRules: role.definition.coreRules,
      extensions: mergedInstr || undefined,
      skills: [...new Set([...(agent.skills as string[]), ...(extension?.skills ?? [])])],
    },
    handoffs: handoffs.map((h) => ({
      stage: h.stage,
      agentName: h.agent_name ?? 'unknown',
      outcome: h.outcome,
      note: h.note,
      at: iso(h.created_at) as string,
    })),
    reviewComments: lastChanges
      ? [
          {
            reviewerName: lastChanges.agent_name ?? 'reviewer',
            reasons: lastChanges.data?.reasons ?? [],
            criteriaMissed: lastChanges.data?.criteriaMissed ?? [],
            comments: lastChanges.note,
            at: iso(lastChanges.created_at) as string,
          },
        ]
      : [],
    thread: thread.reverse().map((m) => ({
      authorName: m.user_name ?? m.agent_name ?? 'system',
      kind: m.kind,
      body: m.body,
      at: iso(m.created_at) as string,
    })),
    standingOrders: [
      ...(await standingOrdersFor(ctx.pool, card.org_id, card.project_id)),
      ...(extension?.standingOrders ?? []).map((body, i) => ({
        title: `Owner standing order for ${role.definition.name} ${i + 1}`,
        body,
      })),
    ],
    ledger: await cardLedgerEntries(ctx.pool, card.id),
    ...(card.card_type === 'feed'
      ? {
          feed: {
            candidates: stage.id === 'curate' ? ((await scoutCandidates(ctx.pool, card.id)) ?? []) : [],
            seenUrls: await seenUrls(ctx.pool, card.project_id),
            tasteSeed: await tasteSeedFor(ctx.pool, card.project_id, card.interest_id),
          },
        }
      : {}),
  };
}

/** The `shift.start` payload for a fresh claim. */
export async function buildShiftStart(ctx: Ctx, claim: ClaimResult): Promise<ShiftStartPayload | null> {
  const shift = await one(ctx.pool, 'SELECT * FROM shifts WHERE id=$1', [claim.shiftId]);
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [claim.agentId]);
  if (!shift || !agent) return null;
  const brief = await buildBrief(ctx, shift);
  if (!brief) return null;
  const worktree: WorktreeSpec | null = claim.worktree
    ? {
        mode: claim.worktree.created ? 'create' : 'reuse',
        repoId: claim.worktree.repoId,
        remoteUrlNormalized: claim.worktree.remoteUrlNormalized,
        baseBranch: claim.worktree.baseBranch,
        branchName: claim.worktree.branchName,
        path: claim.worktree.created ? undefined : claim.worktree.worktreePath,
      }
    : null;
  // The one vault this card may read: its project vault (or the organization vault), only if this workstation's user can access it.
  const ws = await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [claim.workstationId]);
  const vault = ws ? await vaultForProject(ctx.pool, brief.project.id, ws.user_id) : null;
  return {
    shiftId: claim.shiftId,
    claimId: claim.claimId,
    kind: 'card',
    agent: await agentSpecFor(ctx, agent),
    brief,
    worktree,
    prepare: { rebase: claim.rebase },
    maxShiftMinutes: claim.maxShiftMinutes,
    vault: vault ? { vaultId: vault.id, kind: vault.kind, folder: vault.folder } : null,
  };
}

const DEVOPS_MAX_SHIFT_MINUTES = 30;

/**
 * The `shift.start` for one DevOps request. A DevOps shift has no card, but the runner's shift machinery is brief
 * driven, so the brief carries a placeholder card ("DEVOPS") and the real request travels in `devops`.
 */
export async function buildDevopsShiftStart(
  ctx: Ctx,
  requestId: string,
  shiftId: string,
): Promise<ShiftStartPayload | null> {
  const req = await one(ctx.pool, 'SELECT * FROM devops_requests WHERE id=$1', [requestId]);
  if (!req) return null;
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [req.devops_agent_id]);
  const ws = await one(ctx.pool, 'SELECT id, name, devops_access FROM workstations WHERE id=$1', [
    req.workstation_id,
  ]);
  if (!agent || !ws) return null;
  const role = await loadRole(ctx.pool, agent.org_id, agent.role_key, agent.role_version);
  if (!role) return null;
  const card = req.card_id
    ? await one(ctx.pool, 'SELECT ref, title FROM cards WHERE id=$1', [req.card_id])
    : undefined;
  const history = await rows(
    ctx.pool,
    `SELECT m.kind, m.body, m.created_at, u.display_name AS user_name, a.name AS agent_name FROM thread_messages m
       LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN agents a ON a.id = m.author_agent_id
      WHERE m.thread_id=$1 ORDER BY m.created_at, m.event_seq LIMIT 30`,
    [req.thread_id],
  );
  const ap = req.approval as {
    action: string;
    reason: string;
    commands: string[];
    resolution: string | null;
    note?: string;
  } | null;
  const placeholder = { id: requestId, key: 'DEVOPS', name: 'DevOps', ref: 'DEVOPS' };
  const brief: ShiftBrief = {
    shift: {
      id: shiftId,
      kind: 'devops',
      stage: 'devops',
      stageLabel: 'DevOps request',
      doneCriteria: 'The request is done within the granted access, or the manager approved what it needs.',
      outcomes: devopsBriefOutcomes(),
      maxShiftMinutes: DEVOPS_MAX_SHIFT_MINUTES,
    },
    agent: { id: agent.id, name: agent.name, seniority: agent.seniority },
    card: {
      id: requestId,
      ref: placeholder.ref,
      title: String(req.summary).replace(/\s+/g, ' ').slice(0, 120),
      cardType: 'support',
      fields: {},
      riskTier: null,
      reworkRound: 0,
      completionAction: null,
      docsNeeded: false,
      dependencies: [],
    },
    project: {
      id: placeholder.id,
      key: placeholder.key,
      name: placeholder.name,
      workingBranch: 'main',
      e2eGlobs: [],
      architecturalGlobs: [],
    },
    role: {
      key: role.definition.key,
      name: role.definition.name,
      instructions: role.definition.instructions,
      coreRules: role.definition.coreRules,
      skills: agent.skills,
    },
    handoffs: [],
    reviewComments: [],
    thread: [],
    standingOrders: [],
    ledger: [],
  };
  return {
    shiftId,
    claimId: randomUUID(),
    kind: 'devops',
    agent: await agentSpecFor(ctx, agent),
    brief,
    worktree: null,
    prepare: { rebase: false },
    maxShiftMinutes: DEVOPS_MAX_SHIFT_MINUTES,
    devops: {
      requestId,
      threadId: req.thread_id,
      summary: req.summary,
      requestedBy: {
        kind: req.requested_by_kind,
        id: req.requested_by_id,
        name: req.requested_by_name ?? undefined,
      },
      card: card ? { ref: card.ref, title: card.title } : undefined,
      workstationName: ws.name,
      access: DevOpsAccessSchema.parse(ws.devops_access ?? {}),
      hygiene: req.hygiene ?? undefined,
      approval:
        ap?.resolution === 'approved'
          ? { action: ap.action, reason: ap.reason, commands: ap.commands ?? [], note: ap.note ?? undefined }
          : undefined,
      history: history.map((m) => ({
        authorName: m.user_name ?? m.agent_name ?? 'system',
        kind: m.kind,
        body: m.body,
        at: iso(m.created_at) as string,
      })),
    },
    vault: null,
  };
}
