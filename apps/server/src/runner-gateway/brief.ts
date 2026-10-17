import { randomUUID } from 'node:crypto';
import {
  AgentPermissionsSchema,
  type AgentRuntimeSpec,
  allowedOutcomes,
  DevOpsAccessSchema,
  type DevopsShift,
  devopsBriefOutcomes,
  effectiveFeatures,
  getStage,
  type InvestigationLocation,
  type ReadRepo,
  renderUntrusted,
  resolveReportTarget,
  type ServerToRunnerOf,
  type ShiftBrief,
  VAULT_UNAVAILABLE_NOTE,
  type WorktreeSpec,
} from '@aom/shared';
import { loadRole, loadWorkflowById } from '../catalogue/loader.ts';
import { briefAttachments } from '../commands/card-attachments.ts';
import { workflowView } from '../commands/cards.ts';
import { effectiveCompletionAction } from '../commands/completion.ts';
import { scoutCandidates, seenUrls, tasteSeedFor } from '../commands/feeds.ts';
import { grantedMcpServers } from '../commands/mcp-servers.ts';
import { riskOf } from '../commands/review-risk.ts';
import { runBriefFor } from '../commands/runs.ts';
import { shiftEnvironmentFor } from '../commands/test-environments.ts';
import { projectHasVault, vaultForProject } from '../commands/vaults.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { ClaimResult } from '../dispatcher/claim.ts';
import { dependencyStates } from '../dispatcher/dependencies.ts';
import { cardLedgerEntries, standingOrdersFor, standingOrdersForProjects } from '../queries/ledger.ts';
import { orgReadRepos, referenceReadRepos } from './read-repos.ts';
import { localReadRepos } from './workstation-repos.ts';

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

/** Name of the person who last sent the card back from manual QA (null: it was never sent back). */
async function qaSentBackBy(db: Queryable, card: Row): Promise<string | null> {
  const by = card.qa?.lastSendBack?.by as string | undefined;
  if (!by) return null;
  return (await one(db, 'SELECT display_name FROM users WHERE id=$1', [by]))?.display_name ?? 'the tester';
}

/** The latest send back by a person, from manual QA or an approval step: who, what and when (null: none). */
async function personSendBack(
  db: Queryable,
  card: Row,
): Promise<{ name: string; comment: string; at: string } | null> {
  const found: Array<{ by: string; comment: string; at: string; label: string }> = [];
  const qa = card.qa?.lastSendBack as { by: string; comment: string; at: string } | undefined;
  if (qa) found.push({ ...qa, label: 'manual QA' });
  const ap = card.approval?.lastSendBack as { by: string; comment: string; at: string } | undefined;
  if (ap) found.push({ ...ap, label: 'approval' });
  const last = found.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())[0];
  if (!last) return null;
  const name = (await one(db, 'SELECT display_name FROM users WHERE id=$1', [last.by]))?.display_name;
  return { name: `${name ?? 'the approver'} (${last.label})`, comment: last.comment, at: last.at };
}

/**
 * What the builder must address: the latest "request changes" of a reviewer, or, when the card was sent back from manual
 * QA after that, the tester's comment (shown as a review comment).
 */
function reviewCommentsOf(
  lastChanges: Row | undefined,
  card: Row,
  sb: { name: string; comment: string; at: string } | null,
): ShiftBrief['reviewComments'] {
  if (sb && (!lastChanges || new Date(sb.at) > new Date(lastChanges.created_at)))
    return [
      {
        reviewerName: sb.name,
        reasons: [],
        criteriaMissed: [],
        comments: sb.comment,
        at: iso(sb.at) as string,
      },
    ];
  return lastChanges
    ? [
        {
          reviewerName: lastChanges.agent_name ?? 'reviewer',
          reasons: lastChanges.data?.reasons ?? [],
          criteriaMissed: lastChanges.data?.criteriaMissed ?? [],
          comments: lastChanges.note,
          at: iso(lastChanges.created_at) as string,
        },
      ]
    : [];
}

/** What a prompt carries of the card thread: the last 3 messages within 3 KB (`aom thread read` still reads 30). */
export const THREAD_MAX_MESSAGES = 3;
export const THREAD_MAX_BYTES = 3072;

/** Pure: keeps the newest messages that fit the byte budget (input oldest first, output oldest first); long bodies are cut. */
export function capThread<T extends { body?: unknown }>(oldestFirst: T[], full = false): T[] {
  if (full) return oldestFirst;
  const out: T[] = [];
  let bytes = 0;
  for (const m of [...oldestFirst].reverse().slice(0, THREAD_MAX_MESSAGES)) {
    const room = THREAD_MAX_BYTES - bytes;
    if (room <= 0) break;
    const text = String(m.body ?? '');
    const body = Buffer.byteLength(text) > room ? `${text.slice(0, Math.max(0, room - 3))}...` : text;
    bytes += Buffer.byteLength(body);
    out.unshift({ ...m, body });
  }
  return out;
}

/** Brief for one card shift: what the agent sees (docs/ARCHITECTURE.md section 11.2, ShiftBrief). */
export async function buildBrief(
  ctx: Ctx,
  shift: Row,
  opts: { vaultAvailable?: boolean; readOnly?: boolean; fullThread?: boolean } = {},
): Promise<ShiftBrief | null> {
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
      WHERE m.thread_id=$1 ORDER BY m.created_at DESC, m.event_seq DESC LIMIT $2`,
    [card.id, opts.fullThread ? 30 : THREAD_MAX_MESSAGES],
  );
  const deps = await dependencyStates(ctx.pool, card.id);
  const cardLedger = await cardLedgerEntries(ctx.pool, card.id);
  const repo = card.repo_id
    ? await one(ctx.pool, 'SELECT project_path FROM project_repos WHERE id=$1', [card.repo_id])
    : undefined;
  const parent = card.parent_card_id
    ? await one(ctx.pool, 'SELECT ref, title FROM cards WHERE id=$1', [card.parent_card_id])
    : undefined;
  // A card made from an inbound e-mail: the fields filled from the message are outside content (untrusted block).
  const mailLink = await one(
    ctx.pool,
    `SELECT t.untrusted_fields, t.untrusted_title,
            (SELECT from_address FROM mail_messages WHERE thread_id = t.id ORDER BY received_at LIMIT 1) AS from_address
       FROM mail_threads t WHERE t.card_id=$1 AND t.org_id=$2`,
    [card.id, card.org_id],
  );
  // A card made from an incoming webhook (#14): same treatment, from the payload.
  const hookLink = mailLink
    ? undefined
    : await one(ctx.pool, 'SELECT fields, title FROM card_untrusted WHERE card_id=$1 AND org_id=$2', [
        card.id,
        card.org_id,
      ]);
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
      // Outcomes guarded by a card flag (handoff vs report) are offered only when they apply to this card.
      outcomes: allowedOutcomes(wf.definition, workflowView(card), stage.id).map((o) => ({
        id: o.id,
        label: o.label,
        kind: o.kind,
        data: o.data,
      })),
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
      completionAction: await effectiveCompletionAction(ctx.pool, card),
      docsNeeded: card.docs_needed,
      designNeeded: card.design_needed ?? false,
      investigationOnly: card.investigation_only ?? false,
      dependencies: deps.map((d) => ({ ref: d.ref, title: d.title, status: d.status, landed: d.landed })),
      attachments: await briefAttachments(ctx.pool, card.id),
      parent: parent ? { ref: parent.ref, title: parent.title } : undefined,
      ...(hookLink
        ? {
            untrusted: {
              source: 'email' as const,
              kind: 'webhook' as const,
              fields: (hookLink.fields ?? []) as string[],
              title: Boolean(hookLink.title),
            },
          }
        : {}),
      ...(mailLink
        ? {
            untrusted: {
              source: 'email' as const,
              fields: (mailLink.untrusted_fields ?? []) as string[],
              title: Boolean(mailLink.untrusted_title),
              ...(mailLink.from_address ? { from: mailLink.from_address as string } : {}),
            },
          }
        : {}),
    },
    project: {
      id: project.id,
      key: project.key,
      name: project.name,
      workingBranch: project.working_branch,
      e2eGlobs: project.e2e_globs,
      architecturalGlobs: project.architectural_globs,
      vaultFolder: project.vault_folder ?? undefined,
      ...(repo?.project_path ? { projectPath: repo.project_path as string } : {}),
    },
    role: {
      key: role.definition.key,
      name: role.definition.name,
      instructions: role.definition.instructions,
      coreRules: role.definition.coreRules,
      extensions: mergedInstr || undefined,
      skills: [...new Set([...(agent.skills as string[]), ...(extension?.skills ?? [])])],
    },
    ...(['test', 'qa_steps'].includes(stage.id) && riskOf(card)
      ? { reviewRisk: riskOf(card) as NonNullable<ReturnType<typeof riskOf>> }
      : {}),
    ...(card.design_needed || card.investigation_only || card.investigation
      ? {
          investigation: investigationBrief(
            card,
            project,
            opts.vaultAvailable ?? (await projectHasVault(ctx.pool, project.id)),
            opts.readOnly
              ? await unlandedForDesign(
                  ctx.pool,
                  deps.filter((d) => !d.landed),
                )
              : undefined,
          ),
        }
      : {}),
    handoffs: handoffs.map((h) => ({
      stage: h.stage,
      agentName: h.agent_name ?? 'unknown',
      outcome: h.outcome,
      note: h.note,
      at: iso(h.created_at) as string,
    })),
    reviewComments: reviewCommentsOf(lastChanges, card, await personSendBack(ctx.pool, card)),
    thread: capThread(thread.reverse(), opts.fullThread).map((m) => {
      // Replies that came in by e-mail are outside text: their name is not the sender's to choose either.
      const outside = m.data?.source === 'email';
      return {
        authorName: outside ? 'E-mail sender' : (m.user_name ?? m.agent_name ?? 'system'),
        kind: m.kind,
        body: m.body,
        at: iso(m.created_at) as string,
        ...(outside ? { untrusted: true } : {}),
      };
    }),
    standingOrders: [
      ...(await standingOrdersFor(ctx.pool, card.org_id, card.project_id)),
      ...(extension?.standingOrders ?? []).map((body, i) => ({
        title: `Owner standing order for ${role.definition.name} ${i + 1}`,
        body,
      })),
    ],
    ledger: cardLedger.entries,
    ...(cardLedger.total > cardLedger.entries.length ? { ledgerTotal: cardLedger.total } : {}),
    ...(await testerEnvironment(ctx, card, agent, shift)),
    ...(project.test_without_environment && agent.role_key === 'tester' && !agent.is_devops
      ? { testWithoutEnvironment: true }
      : {}),
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

/** The environment a shift of an environment stage works against (backlog #59): the card's healthy test environment, or the target. */
async function testerEnvironment(
  ctx: Ctx,
  card: Row,
  agent: Row,
  shift: Row,
): Promise<{ environment: NonNullable<ShiftBrief['environment']> } | Record<string, never>> {
  if (agent.is_devops) return {};
  const env = await shiftEnvironmentFor(ctx.pool, card, shift.workstation_id ?? agent.workstation_id);
  return env ? { environment: env } : {};
}

/** Where the architect writes its report, and what was recorded once it did (docs/design/architect-and-workflows.md 3.4). */
function investigationBrief(
  card: Row,
  project: Row,
  vaultAvailable: boolean,
  unlanded?: NonNullable<NonNullable<ShiftBrief['investigation']>['unlandedDependencies']>,
): NonNullable<ShiftBrief['investigation']> {
  const target = resolveReportTarget({
    cardReportPath: card.fields?.reportPath,
    projectPath: project.investigation_path,
    projectLocation: project.investigation_location,
    ref: card.ref,
    title: card.title,
    vaultAvailable,
  });
  const rec = card.investigation as {
    reportPath: string;
    location: InvestigationLocation;
    summary: string;
    commit: string | null;
    body?: string;
    assumptions?: Array<{ assumption: string; dependency: string; ifWrong: string }>;
  } | null;
  const held = card.design_review?.state === 'waiting';
  return {
    reportPath: target.reportPath,
    location: target.location,
    ...(target.location === 'repo' && target.folder ? { folder: target.folder } : {}),
    investigationOnly: card.investigation_only ?? false,
    ...(target.vaultUnavailable ? { note: VAULT_UNAVAILABLE_NOTE } : {}),
    mergeMainFirst: card.merge_main_first ?? project.merge_main_first ?? true,
    ...(rec
      ? {
          report: {
            reportPath: rec.reportPath,
            location: rec.location,
            summary: rec.summary,
            ...(rec.commit ? { commit: rec.commit } : {}),
            ...(rec.body ? { body: rec.body } : {}),
          },
        }
      : {}),
    ...(unlanded ? { readOnly: true, unlandedDependencies: unlanded } : {}),
    ...(held
      ? {
          review: {
            assumptions: rec?.assumptions ?? [],
            dependencies: (card.design_review?.dependencies ?? []) as string[],
          },
        }
      : {}),
  };
}

/** What a design made before its dependencies landed builds on: their specs, and their design reports if any. */
async function unlandedForDesign(
  db: Queryable,
  unlanded: Array<{ id: string; ref: string; title: string; status: string }>,
): Promise<NonNullable<NonNullable<ShiftBrief['investigation']>['unlandedDependencies']>> {
  const out: NonNullable<NonNullable<ShiftBrief['investigation']>['unlandedDependencies']> = [];
  for (const d of unlanded) {
    const c = await one(db, 'SELECT fields, investigation FROM cards WHERE id=$1', [d.id]);
    const f = (c?.fields ?? {}) as Record<string, unknown>;
    const spec = ['context', 'requirements', 'acceptanceCriteria']
      .flatMap((k) => (typeof f[k] === 'string' && f[k] ? [`${k}: ${f[k] as string}`] : []))
      .join('\n')
      .slice(0, 6000);
    const inv = c?.investigation as
      | { reportPath: string; location: 'repo' | 'vault'; summary: string; body?: string }
      | null
      | undefined;
    out.push({
      ref: d.ref,
      title: d.title,
      status: d.status,
      ...(spec ? { spec } : {}),
      ...(inv
        ? {
            report: {
              reportPath: inv.reportPath,
              location: inv.location,
              summary: inv.summary,
              ...(inv.body ? { body: inv.body.slice(0, 30000) } : {}),
            },
          }
        : {}),
    });
  }
  return out;
}

/** The vault a question or BA task shift of `projectId` reads (read-only), on the agent's workstation. */
export async function shiftVault(
  ctx: Ctx,
  agent: { workstation_id?: string | null },
  projectId: string,
): Promise<{ vaultId: string; kind: 'org' | 'project'; folder: string } | null> {
  const ws = agent.workstation_id
    ? await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [agent.workstation_id])
    : undefined;
  const v = ws ? await vaultForProject(ctx.pool, projectId, ws.user_id) : null;
  return v ? { vaultId: v.id, kind: v.kind, folder: v.folder } : null;
}

/** The `shift.start` payload for a fresh claim. */
export async function buildShiftStart(ctx: Ctx, claim: ClaimResult): Promise<ShiftStartPayload | null> {
  const shift = await one(ctx.pool, 'SELECT * FROM shifts WHERE id=$1', [claim.shiftId]);
  const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [claim.agentId]);
  if (!shift || !agent) return null;
  let brief = await buildBrief(ctx, shift, { readOnly: !!claim.worktree?.readOnly });
  if (!brief) return null;
  const worktree: WorktreeSpec | null = claim.worktree
    ? {
        mode: claim.worktree.readOnly ? 'readonly' : claim.worktree.created ? 'create' : 'reuse',
        repoId: claim.worktree.repoId,
        remoteUrlNormalized: claim.worktree.remoteUrlNormalized,
        baseBranch: claim.worktree.baseBranch,
        branchName: claim.worktree.branchName,
        path: claim.worktree.created ? undefined : claim.worktree.worktreePath,
        ...(claim.worktree.mainBranch ? { mainBranch: claim.worktree.mainBranch } : {}),
      }
    : null;
  // The one vault this card may read: its project vault (or the organization vault), only if this workstation's user can access it.
  const ws = await one(ctx.pool, 'SELECT user_id FROM workstations WHERE id=$1', [claim.workstationId]);
  const vault = ws ? await vaultForProject(ctx.pool, brief.project.id, ws.user_id) : null;
  // This workstation's user cannot reach a vault the project-level check found (an organization vault): the runner would refuse a vault report.
  if (!vault && brief.investigation?.location === 'vault')
    brief =
      (await buildBrief(ctx, shift, { vaultAvailable: false, readOnly: !!claim.worktree?.readOnly })) ??
      brief;
  // plugin MCP servers the project's Owner granted (names only; the runner holds the configuration)
  const mcp = await grantedMcpServers(ctx.pool, brief.project.id);
  return {
    shiftId: claim.shiftId,
    claimId: claim.claimId,
    kind: 'card',
    agent: await agentSpecFor(ctx, agent),
    brief,
    worktree,
    prepare: { rebase: claim.rebase, ...(claim.syncMain ? { syncMain: claim.syncMain } : {}) },
    orgId: agent.org_id,
    maxShiftMinutes: claim.maxShiftMinutes,
    vault: vault ? { vaultId: vault.id, kind: vault.kind, folder: vault.folder } : null,
    // The card's own repository is its worktree; the project's reference repositories are opened besides, and every
    // repository of the organization for a role with `readOrgRepos` (the architect).
    readRepos: await shiftReadRepos(ctx, agent, brief.project.id, ws?.user_id, claim.worktree?.repoId),
    localReadRepos: await localReadRepos(ctx.pool, brief.project.id, claim.workstationId),
    ...(mcp.length > 0 ? { mcpServers: mcp } : {}),
  };
}

/** Reference repositories, plus (for a role with `readOrgRepos`) the organization's, without the card's own repository. */
async function shiftReadRepos(
  ctx: Ctx,
  agent: Row,
  projectId: string,
  workstationUserId: string | undefined,
  ownRepoId: string | undefined,
): Promise<ReadRepo[]> {
  const out = await referenceReadRepos(ctx.pool, projectId);
  if (agent.permissions?.readOrgRepos === true && workstationUserId) {
    const seen = new Set(out.map((r) => r.repoId));
    for (const r of await orgReadRepos(ctx.pool, agent.org_id, workstationUserId))
      if (!seen.has(r.repoId)) out.push(r);
  }
  return out.filter((r) => r.repoId !== ownRepoId);
}

const DEVOPS_MAX_SHIFT_MINUTES = 30;

/** The card a DevOps request was filed for: fields, project, repository and the latest comments (oldest first). */
export async function devopsCardBrief(
  ctx: Ctx,
  cardId: string,
  orgId: string,
): Promise<DevopsShift['card'] | undefined> {
  const card = await one(ctx.pool, 'SELECT * FROM cards WHERE id=$1 AND org_id=$2', [cardId, orgId]);
  if (!card) return undefined;
  const project = await one(ctx.pool, 'SELECT key, name FROM projects WHERE id=$1', [card.project_id]);
  const repo = card.repo_id
    ? await one(ctx.pool, 'SELECT name FROM project_repos WHERE id=$1', [card.repo_id])
    : undefined;
  const comments = await rows(
    ctx.pool,
    `SELECT m.kind, m.body, m.data, m.created_at, u.display_name AS user_name, a.name AS agent_name FROM thread_messages m
       LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN agents a ON a.id = m.author_agent_id
      WHERE m.thread_id=$1 ORDER BY m.created_at DESC, m.event_seq DESC LIMIT 10`,
    [card.id],
  );
  // Text from an inbound e-mail reaches the agent inside an untrusted block here too.
  const mail = await one(
    ctx.pool,
    'SELECT untrusted_fields, untrusted_title FROM mail_threads WHERE card_id=$1 AND org_id=$2',
    [card.id, orgId],
  );
  const hook = mail
    ? undefined
    : await one(ctx.pool, 'SELECT fields, title FROM card_untrusted WHERE card_id=$1 AND org_id=$2', [
        card.id,
        orgId,
      ]);
  const outsideFields = (mail ? mail.untrusted_fields : hook?.fields) ?? [];
  const outsideTitle = Boolean(mail ? mail.untrusted_title : hook?.title);
  const what = mail ? 'E-mail' : 'Webhook';
  const fields = { ...((card.fields ?? {}) as Record<string, unknown>) };
  for (const key of outsideFields as string[]) {
    const v = fields[key];
    if (v !== undefined && v !== null)
      fields[key] = renderUntrusted(`${what}: ${key}`, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return {
    ref: card.ref,
    title: outsideTitle ? renderUntrusted(`${what} subject`, card.title) : card.title,
    cardType: card.card_type,
    stage: card.stage ?? undefined,
    status: card.status,
    fields,
    project: project ? { key: project.key, name: project.name } : undefined,
    repo: repo?.name,
    attachments: await briefAttachments(ctx.pool, card.id),
    comments: comments.reverse().map((m) => ({
      authorName: m.user_name ?? m.agent_name ?? 'system',
      kind: m.kind,
      body: m.data?.source === 'email' ? renderUntrusted('E-mail reply', m.body) : m.body,
      at: iso(m.created_at) as string,
    })),
  };
}

/**
 * "Ask DevOps": the instruction followed by what the user was looking at (page, project, card, repository, workstation,
 * the last error), resolved to names. Plain text, so the runner's brief needs no new field.
 */
export async function withRequestContext(ctx: Ctx, req: Record<string, any>): Promise<string> {
  const c = (req.context ?? null) as Record<string, string | undefined> | null;
  if (!c) return req.summary;
  // Defence in depth: only entities of the request's own organization are ever resolved.
  const orgId = req.org_id as string;
  const lines: string[] = [];
  if (req.origin) lines.push(`Asked from: ${req.origin}`);
  if (c.route) lines.push(`Page: ${c.route}`);
  if (c.projectId) {
    const p = await one(ctx.pool, 'SELECT key, name FROM projects WHERE id=$1 AND org_id=$2', [
      c.projectId,
      orgId,
    ]);
    if (p) lines.push(`Project: ${p.name} (${p.key})`);
  }
  if (c.cardId) {
    const k = await one(ctx.pool, 'SELECT ref, title FROM cards WHERE id=$1 AND org_id=$2', [
      c.cardId,
      orgId,
    ]);
    if (k) lines.push(`Card: ${k.ref} ${k.title}`);
  }
  if (c.repoId) {
    const r = await one(
      ctx.pool,
      'SELECT r.name FROM project_repos r JOIN projects p ON p.id = r.project_id WHERE r.id=$1 AND p.org_id=$2',
      [c.repoId, orgId],
    );
    if (r) lines.push(`Repository: ${r.name}`);
  }
  if (c.deskItemId) {
    const d = await one(ctx.pool, 'SELECT title FROM desk_items WHERE id=$1 AND org_id=$2', [
      c.deskItemId,
      orgId,
    ]);
    if (d) lines.push(`Desk item: ${d.title}`);
  }
  if (c.errorText) lines.push(`Last error:\n${c.errorText}`);
  return lines.length
    ? `${req.summary}\n\nContext the user was looking at:\n${lines.join('\n')}`
    : req.summary;
}

/** The projects a DevOps request touches: its card's, the one the user was looking at, a run's and a hygiene run's. */
async function devopsProjectIds(ctx: Ctx, req: Row, orgId: string): Promise<string[]> {
  const ids = new Set<string>();
  const add = (v: unknown) => typeof v === 'string' && ids.add(v);
  if (req.card_id)
    add((await one(ctx.pool, 'SELECT project_id FROM cards WHERE id=$1', [req.card_id]))?.project_id);
  const c = (req.context ?? null) as { projectId?: string; envId?: string } | null;
  if (c?.projectId)
    add((await one(ctx.pool, 'SELECT id FROM projects WHERE id=$1 AND org_id=$2', [c.projectId, orgId]))?.id);
  if (c?.envId)
    add((await one(ctx.pool, 'SELECT project_id FROM run_environments WHERE id=$1', [c.envId]))?.project_id);
  for (const r of (req.hygiene?.repos ?? []) as Array<{ projectId?: string }>) add(r.projectId);
  return [...ids];
}

/**
 * Standing orders for a DevOps shift (backlog #75): the organization-wide ones, those of every project the request
 * touches, and the owner's standing orders for the DevOps role. Before this the brief carried none, so the engineer never saw them.
 */
export async function devopsStandingOrders(
  ctx: Ctx,
  req: Row,
  orgId: string,
  roleKey: string,
): Promise<Array<{ title: string; body: string }>> {
  const ext = await one(ctx.pool, 'SELECT extensions FROM role_extensions WHERE org_id=$1 AND role_key=$2', [
    orgId,
    roleKey,
  ]);
  const own = ((ext?.extensions as { standingOrders?: string[] } | undefined)?.standingOrders ?? []).map(
    (body, i) => ({ title: `Owner standing order for DevOps ${i + 1}`, body }),
  );
  return [
    ...(await standingOrdersForProjects(ctx.pool, orgId, await devopsProjectIds(ctx, req, orgId))),
    ...own,
  ];
}

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
  const card = req.card_id ? await devopsCardBrief(ctx, req.card_id, req.org_id) : undefined;
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
    // Binding like every other agent's: the organization's orders plus those of each project the request touches.
    standingOrders: await devopsStandingOrders(ctx, req, agent.org_id, role.definition.key),
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
      summary: await withRequestContext(ctx, req),
      requestedBy: {
        kind: req.requested_by_kind,
        id: req.requested_by_id,
        name: req.requested_by_name ?? undefined,
      },
      card,
      workstationName: ws.name,
      access: DevOpsAccessSchema.parse(ws.devops_access ?? {}),
      hygiene: req.hygiene ?? undefined,
      run: (await runBriefFor(ctx, req)) ?? undefined,
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
