import { randomUUID } from 'node:crypto';
import {
  type CreateDevOpsRequest,
  DEVOPS_OUTCOME_APPROVAL,
  DEVOPS_OUTCOME_DONE,
  DevopsApprovalDataSchema,
  DevopsDoneDataSchema,
  type DevOpsAccess,
  DevOpsAccessSchema,
  type DevOpsRequestDetail,
  type DevOpsRequestDto,
  type DevOpsRequester,
  type PatchDevOpsAccessRequest,
  type RunnerToServerOf,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard } from '../authz/scope.ts';
import { loadRole } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { getDeskPort } from '../desk-port.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentActor, orgScope, SYSTEM_ACTOR, userActor } from './common.ts';
import type { ReportResult, WsRef } from './shifts.ts';

const DEVOPS_NAMES = [
  'Atlas',
  'Forge',
  'Anvil',
  'Bolt',
  'Cog',
  'Dynamo',
  'Ratchet',
  'Sprocket',
  'Torque',
  'Wrench',
  'Gantry',
  'Lathe',
  'Piston',
  'Rivet',
  'Spindle',
];

/** First unused DevOps name in the org (retired agents keep their names; numbered variants when the list runs out). */
async function devopsName(db: Queryable, orgId: string): Promise<string> {
  const used = new Set(
    (await rows<{ n: string }>(db, 'SELECT lower(name) AS n FROM agents WHERE org_id=$1', [orgId])).map((r) => r.n),
  );
  for (let round = 1; ; round++) {
    for (const base of DEVOPS_NAMES) {
      const name = round === 1 ? base : `${base} ${round}`;
      if (!used.has(name.toLowerCase())) return name;
    }
  }
}

/**
 * `AgentHired{isDevops:true}` for a freshly paired workstation (docs/ARCHITECTURE.md section 16.2, section 24 item 16).
 * Appended in the same transaction as `WorkstationPaired`. The runtime is the role default; the first `hello`
 * re-points it to an available runtime when the default is missing on that workstation (`alignDevopsRuntime`).
 */
export async function devopsHireEvent(
  tx: Tx,
  userId: string,
  workstationId: string,
): Promise<AppendInput | null> {
  const role = await loadRole(tx, userId, 'devops');
  if (!role) return null;
  const agentId = randomUUID();
  const dm = role.definition.defaultModel;
  return {
    streamId: streamId.agent(agentId),
    event: {
      type: 'AgentHired',
      payload: {
        agentId,
        orgId: userId,
        hiredByUserId: userId,
        workstationId,
        name: await devopsName(tx, userId),
        roleKey: role.key,
        roleVersion: role.version,
        seniority: 'senior',
        runtime: dm.runtime,
        model: dm.model,
        effort: dm.effort,
        skills: role.definition.skills,
        permissions: role.definition.permissions,
        capacity: 1,
        isDevops: true,
      },
    },
    actor: SYSTEM_ACTOR,
    scope: orgScope(userId),
  };
}

/** After `hello`: a DevOps agent whose runtime the workstation lacks moves to an available runtime. */
export async function alignDevopsRuntime(
  ctx: Ctx,
  workstationId: string,
  runtimes: Array<{ id: string; available: boolean }>,
): Promise<void> {
  const a = await one(
    ctx.pool,
    `SELECT id, org_id, runtime FROM agents WHERE workstation_id=$1 AND is_devops AND status='active'`,
    [workstationId],
  );
  if (!a) return;
  const available = runtimes.filter((r) => r.available);
  if (available.length === 0 || available.some((r) => r.id === a.runtime)) return;
  const next = available.find((r) => r.id !== 'mock') ?? available[0];
  if (!next) return;
  // The model names are runtime specific: the role default model applies to the claude-code runtime only.
  await ctx.store.append([
    {
      streamId: streamId.agent(a.id),
      event: {
        type: 'AgentChanged',
        payload: { agentId: a.id, changes: { runtime: next.id, ...(next.id === 'mock' ? { model: 'mock' } : {}) } },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(a.org_id),
    },
  ]);
}

// ---------------------------------------------------------------------------------------- requests

function threadMessage(
  threadId: string,
  orgId: string,
  author: { kind: 'user'; userId: string } | { kind: 'agent'; agentId: string } | { kind: 'system' },
  kind: 'comment' | 'system' | 'answer' | 'question' | 'handoff',
  body: string,
  data: Record<string, unknown> = {},
): AppendInput {
  return {
    streamId: streamId.thread(threadId),
    event: {
      type: 'ThreadMessagePosted',
      payload: {
        threadId,
        messageId: randomUUID(),
        authorKind: author.kind,
        authorUserId: author.kind === 'user' ? author.userId : undefined,
        authorAgentId: author.kind === 'agent' ? author.agentId : undefined,
        kind,
        body,
        data,
      },
    },
    actor:
      author.kind === 'user'
        ? userActor(author.userId)
        : author.kind === 'agent'
          ? agentActor(author.agentId)
          : SYSTEM_ACTOR,
    scope: orgScope(orgId),
  };
}

/** Creates the request, its thread and the first message. `tx` must be an append transaction. */
export async function createDevOpsRequestIn(
  ctx: Ctx,
  tx: Tx,
  input: { workstationId: string; summary: string; requestedBy: DevOpsRequester; cardId?: string },
): Promise<{ requestId: string; threadId: string }> {
  const ws = await one(tx, `SELECT id, user_id FROM workstations WHERE id=$1 AND status='active'`, [
    input.workstationId,
  ]);
  if (!ws) throw notFound('workstation not found');
  const agent = await one(
    tx,
    `SELECT id FROM agents WHERE workstation_id=$1 AND is_devops AND status='active'`,
    [input.workstationId],
  );
  if (!agent) throw conflict('no_devops_agent', 'this workstation has no DevOps engineer');
  const requestId = randomUUID();
  const author: Parameters<typeof threadMessage>[2] =
    input.requestedBy.kind === 'user'
      ? { kind: 'user', userId: input.requestedBy.id as string }
      : input.requestedBy.kind === 'agent'
        ? { kind: 'agent', agentId: input.requestedBy.id as string }
        : { kind: 'system' };
  await ctx.store.append(
    [
      {
        streamId: streamId.thread(requestId),
        event: {
          type: 'DevOpsRequested',
          payload: {
            requestId,
            workstationId: input.workstationId,
            devopsAgentId: agent.id,
            threadId: requestId,
            requestedBy: input.requestedBy,
            cardId: input.cardId,
            summary: input.summary,
          },
        },
        actor:
          input.requestedBy.kind === 'user'
            ? userActor(input.requestedBy.id as string)
            : input.requestedBy.kind === 'agent'
              ? agentActor(input.requestedBy.id as string)
              : SYSTEM_ACTOR,
        scope: orgScope(ws.user_id),
      },
      threadMessage(requestId, ws.user_id, author, 'comment', input.summary),
    ],
    { tx },
  );
  return { requestId, threadId: requestId };
}

export async function createDevOpsRequest(
  ctx: Ctx,
  user: AuthSession['user'],
  req: CreateDevOpsRequest,
): Promise<string> {
  return withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(tx, `SELECT user_id FROM workstations WHERE id=$1 AND status='active'`, [
      req.workstationId,
    ]);
    if (!ws || ws.user_id !== user.id) throw notFound('workstation not found');
    if (req.cardId) await loadVisibleCard(tx, user.id, req.cardId);
    const { requestId } = await createDevOpsRequestIn(ctx, tx, {
      workstationId: req.workstationId,
      summary: req.summary,
      requestedBy: { kind: 'user', id: user.id, name: user.displayName },
      cardId: req.cardId,
    });
    return requestId;
  });
}

const REQUEST_SQL = `SELECT r.*, w.name AS workstation_name, a.name AS agent_name, c.ref AS card_ref
   FROM devops_requests r JOIN workstations w ON w.id = r.workstation_id
   JOIN agents a ON a.id = r.devops_agent_id LEFT JOIN cards c ON c.id = r.card_id`;

function toRequestDto(r: Row): DevOpsRequestDto {
  const ap = r.approval as { deskItemId: string; action: string; reason: string; commands: string[]; resolution: 'approved' | 'rejected' | null } | null;
  return {
    id: r.id,
    workstationId: r.workstation_id,
    workstationName: r.workstation_name,
    devopsAgentId: r.devops_agent_id,
    devopsAgentName: r.agent_name,
    threadId: r.thread_id,
    requestedBy: { kind: r.requested_by_kind, id: r.requested_by_id, name: r.requested_by_name ?? undefined },
    cardId: r.card_id,
    cardRef: r.card_ref,
    summary: r.summary,
    status: r.status,
    approval: ap
      ? {
          deskItemId: ap.deskItemId,
          action: ap.action,
          reason: ap.reason,
          commands: ap.commands ?? [],
          resolution: ap.resolution ?? null,
        }
      : null,
    resultSummary: r.result_summary,
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

/** Requests on the user's own workstations (newest first). */
export async function listDevOpsRequests(
  ctx: Ctx,
  userId: string,
  filter: { workstationId?: string; status?: string } = {},
): Promise<DevOpsRequestDto[]> {
  const r = await rows(
    ctx.pool,
    `${REQUEST_SQL} WHERE r.org_id = $1 AND ($2::uuid IS NULL OR r.workstation_id = $2) AND ($3::text IS NULL OR r.status = $3)
      ORDER BY r.created_at DESC, r.id DESC LIMIT 200`,
    [userId, filter.workstationId ?? null, filter.status ?? null],
  );
  return r.map(toRequestDto);
}

export async function getDevOpsRequest(ctx: Ctx, userId: string, id: string): Promise<DevOpsRequestDetail> {
  const r = await one(ctx.pool, `${REQUEST_SQL} WHERE r.id = $1 AND r.org_id = $2`, [id, userId]);
  if (!r) throw notFound('request not found');
  const messages = await rows(
    ctx.pool,
    `SELECT m.*, u.display_name AS user_name, a.name AS agent_name FROM thread_messages m
       LEFT JOIN users u ON u.id = m.author_user_id LEFT JOIN agents a ON a.id = m.author_agent_id
      WHERE m.thread_id = $1 ORDER BY m.created_at, m.event_seq`,
    [r.thread_id],
  );
  const changes = await rows(
    ctx.pool,
    'SELECT * FROM environment_changes WHERE request_id=$1 ORDER BY created_at, id',
    [id],
  );
  return {
    request: toRequestDto(r),
    messages: messages.map((m) => ({
      id: m.id,
      authorKind: m.author_kind,
      authorName: m.user_name ?? m.agent_name ?? 'system',
      kind: m.kind,
      body: m.body,
      data: m.data ?? {},
      createdAt: iso(m.created_at) as string,
    })),
    changes: changes.map((c) => ({
      id: c.id,
      summary: c.summary,
      commands: c.commands,
      createdAt: iso(c.created_at) as string,
    })),
  };
}

// ------------------------------------------------------------------------------------------ access

export async function patchDevOpsAccess(
  ctx: Ctx,
  user: AuthSession['user'],
  workstationId: string,
  patch: PatchDevOpsAccessRequest,
): Promise<DevOpsAccess> {
  return withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(
      tx,
      `SELECT user_id, devops_access FROM workstations WHERE id=$1 AND status='active'`,
      [workstationId],
    );
    if (!ws || ws.user_id !== user.id) throw notFound('workstation not found');
    const access = DevOpsAccessSchema.parse({ ...(ws.devops_access ?? {}), ...patch });
    await ctx.store.append(
      [
        {
          streamId: streamId.workstation(workstationId),
          event: { type: 'DevOpsAccessChanged', payload: { workstationId, access, changedBy: user.id } },
          actor: userActor(user.id),
          scope: orgScope(user.id),
        },
      ],
      { tx },
    );
    return access;
  });
}

// ---------------------------------------------------------------------------------------- approval

/**
 * The manager answers a DevOps approval. Called by the M3 endpoint and by the M2 desk resolve for
 * `subkind 'devops'` (see desk-port.ts). Approved: the request is queued again with the approval attached.
 */
export async function resolveDevOpsApproval(
  ctx: Ctx,
  user: AuthSession['user'],
  requestId: string,
  resolution: 'approved' | 'rejected',
  note?: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const r = await one(tx, 'SELECT * FROM devops_requests WHERE id=$1 AND org_id=$2 FOR UPDATE', [
      requestId,
      user.id,
    ]);
    if (!r) throw notFound('request not found');
    const ap = r.approval as { deskItemId: string; resolution: string | null } | null;
    if (r.status !== 'needs_approval' || !ap || ap.resolution)
      throw conflict('not_awaiting_approval', 'this request is not waiting for approval');
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(requestId),
          event: {
            type: 'DevOpsApprovalResolved',
            payload: { requestId, deskItemId: ap.deskItemId, resolution, resolvedBy: user.id, note },
          },
          actor: userActor(user.id),
          scope: orgScope(user.id),
        },
        threadMessage(
          r.thread_id,
          user.id,
          { kind: 'user', userId: user.id },
          'answer',
          `${resolution === 'approved' ? 'Approved' : 'Rejected'}${note ? `: ${note}` : ''}`,
          { resolution },
        ),
      ],
      { tx },
    );
  });
  ctx.services.dispatcher.trigger();
}

// ------------------------------------------------------------------------- reports of a DevOps shift

/** Terminal and non-terminal reports of a `devops` shift (`aom devops-done`, `aom devops-approval`, `aom comment`). */
export async function applyDevopsReport(
  ctx: Ctx,
  tx: Tx,
  ws: WsRef,
  msg: RunnerToServerOf<'shift.report'>,
  shift: Row,
): Promise<ReportResult> {
  const req = await one(tx, 'SELECT * FROM devops_requests WHERE shift_id=$1 FOR UPDATE', [shift.id]);
  if (!req) return { accepted: false, error: 'this shift has no open DevOps request' };
  const report = msg.report;
  const scope = orgScope(ws.userId);
  const agent = { kind: 'agent' as const, agentId: shift.agent_id as string };

  if (report.kind === 'comment') {
    await ctx.store.append([threadMessage(req.thread_id, ws.userId, agent, 'comment', report.note)], { tx });
    return { accepted: true };
  }
  if (report.kind === 'question') {
    return {
      accepted: false,
      error: `questions are not available in a DevOps shift; ask for approval with \`aom ${DEVOPS_OUTCOME_APPROVAL.replace('_', '-')}\` instead`,
    };
  }
  if (req.status !== 'running') {
    return { accepted: false, error: 'already reported: exactly one terminal report is accepted per shift (409)' };
  }

  if (report.outcomeId === DEVOPS_OUTCOME_DONE) {
    const data = DevopsDoneDataSchema.safeParse(report.data);
    if (!data.success) return { accepted: false, error: `invalid devops-done data: ${data.error.message}` };
    await ctx.store.append(
      [
        {
          streamId: streamId.workstation(ws.id),
          event: {
            type: 'EnvironmentChanged',
            payload: {
              changeId: randomUUID(),
              requestId: req.id,
              workstationId: ws.id,
              summary: data.data.summary,
              commands: data.data.commands,
            },
          },
          actor: agentActor(shift.agent_id),
          scope,
        },
        threadMessage(
          req.thread_id,
          ws.userId,
          agent,
          'handoff',
          `${data.data.summary}${data.data.commands.length ? `\n\nCommands:\n${data.data.commands.map((c) => `- ${c}`).join('\n')}` : ''}`,
          { commands: data.data.commands },
        ),
        {
          streamId: streamId.thread(req.id),
          event: { type: 'DevOpsRequestCompleted', payload: { requestId: req.id, status: 'done', summary: data.data.summary } },
          actor: agentActor(shift.agent_id),
          scope,
        },
      ],
      { tx },
    );
    return { accepted: true };
  }

  if (report.outcomeId === DEVOPS_OUTCOME_APPROVAL) {
    const data = DevopsApprovalDataSchema.safeParse(report.data);
    if (!data.success) return { accepted: false, error: `invalid devops-approval data: ${data.error.message}` };
    const project = req.card_id
      ? await one<{ project_id: string }>(tx, 'SELECT project_id FROM cards WHERE id=$1', [req.card_id])
      : undefined;
    const { deskItemId } = await getDeskPort().raise(tx, {
      kind: 'approval',
      subkind: 'devops',
      title: `DevOps needs approval: ${data.data.action}`,
      body: data.data.reason,
      pinned: true,
      blocking: true,
      orgId: ws.userId,
      projectId: project?.project_id ?? null,
      cardId: req.card_id,
      routeToUserId: ws.userId,
      context: { requestId: req.id, workstationId: ws.id, commands: data.data.commands },
    });
    await ctx.store.append(
      [
        {
          streamId: streamId.thread(req.id),
          event: {
            type: 'DevOpsApprovalNeeded',
            payload: {
              requestId: req.id,
              deskItemId,
              action: data.data.action,
              reason: data.data.reason,
              commands: data.data.commands,
            },
          },
          actor: agentActor(shift.agent_id),
          scope,
        },
        threadMessage(
          req.thread_id,
          ws.userId,
          agent,
          'question',
          `Needs approval: ${data.data.action}\n\n${data.data.reason}`,
          { commands: data.data.commands, deskItemId },
        ),
      ],
      { tx },
    );
    return { accepted: true };
  }

  return {
    accepted: false,
    error: `outcome '${report.outcomeId}' is not available in a DevOps shift (allowed: ${DEVOPS_OUTCOME_DONE}, ${DEVOPS_OUTCOME_APPROVAL})`,
  };
}

/**
 * A DevOps shift ended or was rejected without a terminal report: `rejected`/`lost`/`stopped` shifts go back to the
 * queue, anything else (crash, timeout, no report) fails the request with the runner's last text.
 */
export function devopsShiftEndEvents(
  req: Row,
  outcome: 'rejected' | 'lost' | 'stopped' | 'no_report' | 'crashed' | 'timeout' | 'reported',
  orgId: string,
  finalText?: string,
): AppendInput[] {
  if (req.status !== 'running') return [];
  const requeue = outcome === 'rejected' || outcome === 'lost' || outcome === 'stopped';
  const text = requeue
    ? `The DevOps shift did not complete (${outcome}); the request is back in the queue.`
    : `The DevOps shift ended without a report (${outcome}).${finalText ? `\n\n${finalText}` : ''}`;
  return [
    {
      streamId: streamId.thread(req.id),
      event: requeue
        ? { type: 'DevOpsRequestRequeued', payload: { requestId: req.id, reason: outcome } }
        : {
            type: 'DevOpsRequestCompleted',
            payload: { requestId: req.id, status: 'failed', summary: text.slice(0, 2000) },
          },
      actor: SYSTEM_ACTOR,
      scope: orgScope(orgId),
    },
    threadMessage(req.thread_id, orgId, { kind: 'system' }, 'system', text),
  ];
}

/** `ShiftEnded` for a DevOps shift plus the request consequences (requeue or fail) when no report was applied. */
export async function endDevopsShift(
  tx: Queryable,
  shift: Row,
  outcome: 'rejected' | 'lost' | 'stopped' | 'no_report' | 'crashed' | 'timeout' | 'reported',
  extra: {
    durationMs?: number;
    usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };
    exitCode?: number | null;
    finalText?: string;
    guardViolations?: { rule: string; detail: string }[];
  } = {},
): Promise<AppendInput[]> {
  const req = await runningRequestOfShift(tx, shift.id);
  const events: AppendInput[] = [
    {
      streamId: streamId.shift(shift.id),
      event: {
        type: 'ShiftEnded',
        payload: {
          shiftId: shift.id,
          agentId: shift.agent_id,
          outcome,
          durationMs: extra.durationMs ?? 0,
          usage: extra.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          exitCode: extra.exitCode,
          guardViolations: extra.guardViolations ?? [],
        },
      },
      actor: { kind: 'runner', id: shift.workstation_id },
      scope: orgScope(shift.org_id),
    },
  ];
  if (req) events.push(...devopsShiftEndEvents(req, outcome, shift.org_id, extra.finalText));
  return events;
}

/** The DevOps request a shift is working (if it still is). */
export const runningRequestOfShift = (db: Queryable, shiftId: string) =>
  one(db, `SELECT * FROM devops_requests WHERE shift_id=$1 AND status='running'`, [shiftId]);
