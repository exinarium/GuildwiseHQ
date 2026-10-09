import { randomUUID } from 'node:crypto';
import {
  type CreateDevOpsRequest,
  DEFAULT_AVATAR_STYLE,
  DEVOPS_OUTCOME_APPROVAL,
  DEVOPS_OUTCOME_DONE,
  DEVOPS_ROLE_KEY,
  type DevOpsAccess,
  DevOpsAccessSchema,
  type DevOpsRequestDetail,
  type DevOpsRequestDto,
  type DevOpsRequester,
  DevopsApprovalDataSchema,
  DevopsDoneDataSchema,
  type HygieneSpec,
  type PatchDevOpsAccessRequest,
  type RunnerToServerOf,
  randomAvatarSeed,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard } from '../authz/scope.ts';
import { loadRole } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { closeDeskItemIn, raiseDeskItem } from '../desk-port.ts';
import { conflict, notFound } from '../errors.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentActor, orgScope, SYSTEM_ACTOR, userActor, userScope } from './common.ts';
import { hygieneReportEvents } from './hygiene.ts';
import type { ReportResult, WsRef } from './shifts.ts';
import { afterAccessChangedIn, deliver } from './workstation-setup.ts';

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
    (await rows<{ n: string }>(db, 'SELECT lower(name) AS n FROM agents WHERE org_id=$1', [orgId])).map(
      (r) => r.n,
    ),
  );
  for (let round = 1; ; round++) {
    for (const base of DEVOPS_NAMES) {
      const name = round === 1 ? base : `${base} ${round}`;
      if (!used.has(name.toLowerCase())) return name;
    }
  }
}

/**
 * `AgentHired{isDevops:true}` for one organization on one workstation (docs/ARCHITECTURE.md section 16.2, section 24
 * item 16): one DevOps engineer per organization and workstation, free (it does not count against the limits) and not
 * extendable (owner decisions 15 and 15a). The runtime is the role default; the first `hello` re-points it to an
 * available runtime when the default is missing on that workstation (`alignDevopsRuntime`). Null when the engineer
 * already exists or the role is unavailable.
 */
export async function devopsHireEvent(
  tx: Tx,
  userId: string,
  orgId: string,
  workstationId: string,
): Promise<AppendInput | null> {
  const role = await loadRole(tx, orgId, DEVOPS_ROLE_KEY);
  if (!role) return null;
  if (
    await one(
      tx,
      `SELECT 1 FROM agents WHERE org_id=$1 AND workstation_id=$2 AND is_devops AND status='active'`,
      [orgId, workstationId],
    )
  )
    return null;
  const agentId = randomUUID();
  const dm = role.definition.defaultModel;
  return {
    streamId: streamId.agent(agentId),
    event: {
      type: 'AgentHired',
      payload: {
        agentId,
        orgId,
        hiredByUserId: userId,
        workstationId,
        name: await devopsName(tx, orgId),
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
        avatarSeed: randomAvatarSeed(),
        avatarStyle: DEFAULT_AVATAR_STYLE,
      },
    },
    actor: SYSTEM_ACTOR,
    scope: orgScope(orgId),
  };
}

/** The DevOps engineers a user's active workstation needs: one for each organization they are an active member of. */
export async function devopsHireEvents(
  tx: Tx,
  userId: string,
  workstationId: string,
): Promise<AppendInput[]> {
  const orgs = await rows<{ org_id: string }>(
    tx,
    `SELECT om.org_id FROM org_members om JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id=$1 AND om.status='active' AND o.status IN ('trial','active') ORDER BY om.joined_at`,
    [userId],
  );
  const out: AppendInput[] = [];
  for (const o of orgs) {
    const ev = await devopsHireEvent(tx, userId, o.org_id, workstationId);
    if (ev) out.push(ev);
  }
  return out;
}

/** The user joined an organization (or started one): their active workstations get its DevOps engineer. */
export async function hireDevopsForOrgIn(ctx: Ctx, tx: Tx, userId: string, orgId: string): Promise<void> {
  const stations = await rows<{ id: string }>(
    tx,
    `SELECT id FROM workstations WHERE user_id=$1 AND status='active' ORDER BY paired_at`,
    [userId],
  );
  const events: AppendInput[] = [];
  for (const w of stations) {
    const ev = await devopsHireEvent(tx, userId, orgId, w.id);
    if (ev) events.push(ev);
  }
  if (events.length) await ctx.store.append(events, { tx });
}

/** After `hello`: a DevOps agent whose runtime the workstation lacks moves to an available runtime. */
export async function alignDevopsRuntime(
  ctx: Ctx,
  workstationId: string,
  runtimes: Array<{ id: string; available: boolean }>,
): Promise<void> {
  const list = await rows(
    ctx.pool,
    `SELECT id, org_id, runtime FROM agents WHERE workstation_id=$1 AND is_devops AND status='active'`,
    [workstationId],
  );
  const available = runtimes.filter((r) => r.available);
  if (available.length === 0) return;
  for (const a of list) {
    if (available.some((r) => r.id === a.runtime)) continue;
    const next = available.find((r) => r.id !== 'mock') ?? available[0];
    if (!next) continue;
    // The model names are runtime specific: the role default model applies to the claude-code runtime only.
    await ctx.store.append([
      {
        streamId: streamId.agent(a.id),
        event: {
          type: 'AgentChanged',
          payload: {
            agentId: a.id,
            changes: { runtime: next.id, ...(next.id === 'mock' ? { model: 'mock' } : {}) },
          },
        },
        actor: SYSTEM_ACTOR,
        scope: orgScope(a.org_id),
      },
    ]);
  }
}

// ---------------------------------------------------------------------------------------- requests

export function threadMessage(
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

/** The DevOps engineer of `orgId` on the workstation, else (a guest's machine) its oldest active engineer. */
export async function devopsAgentOn(
  db: Queryable,
  workstationId: string,
  orgId: string | null,
): Promise<{ id: string; org_id: string } | undefined> {
  return one<{ id: string; org_id: string }>(
    db,
    `SELECT a.id, a.org_id FROM agents a JOIN organizations o ON o.id = a.org_id
      WHERE a.workstation_id=$1 AND a.is_devops AND a.status='active'
      ORDER BY (a.org_id = $2::uuid) DESC NULLS LAST, (o.status IN ('trial','active')) DESC, a.hired_at, a.id LIMIT 1`,
    [workstationId, orgId],
  );
}

/** Creates the request, its thread and the first message. `tx` must be an append transaction. */
export async function createDevOpsRequestIn(
  ctx: Ctx,
  tx: Tx,
  input: {
    workstationId: string;
    summary: string;
    requestedBy: DevOpsRequester;
    cardId?: string;
    hygiene?: HygieneSpec;
    /** The organization the request is for: its DevOps engineer on this workstation works it (else the oldest one). */
    orgId?: string | null;
  },
): Promise<{ requestId: string; threadId: string }> {
  const ws = await one(tx, `SELECT id, user_id FROM workstations WHERE id=$1 AND status='active'`, [
    input.workstationId,
  ]);
  if (!ws) throw notFound('workstation not found');
  const agent = await devopsAgentOn(tx, input.workstationId, input.orgId ?? null);
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
            ...(input.hygiene ? { hygiene: input.hygiene } : {}),
          },
        },
        actor:
          input.requestedBy.kind === 'user'
            ? userActor(input.requestedBy.id as string)
            : input.requestedBy.kind === 'agent'
              ? agentActor(input.requestedBy.id as string)
              : SYSTEM_ACTOR,
        scope: orgScope(agent.org_id),
      },
      threadMessage(requestId, agent.org_id, author, 'comment', input.summary),
    ],
    { tx },
  );
  return { requestId, threadId: requestId };
}

export async function createDevOpsRequest(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string },
  req: CreateDevOpsRequest,
): Promise<string> {
  return withAppendTx(ctx.pool, async (tx) => {
    const ws = await one(tx, `SELECT user_id FROM workstations WHERE id=$1 AND status='active'`, [
      req.workstationId,
    ]);
    if (!ws || ws.user_id !== user.id) throw notFound('workstation not found');
    const card = req.cardId ? (await loadVisibleCard(tx, user.id, req.cardId)).card : undefined;
    const { requestId } = await createDevOpsRequestIn(ctx, tx, {
      orgId: card?.org_id ?? org.id,
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
  const ap = r.approval as {
    deskItemId: string;
    action: string;
    reason: string;
    commands: string[];
    resolution: 'approved' | 'rejected' | null;
  } | null;
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

/** Requests on the user's own workstations (newest first): the machine's user answers for them. */
export async function listDevOpsRequests(
  ctx: Ctx,
  userId: string,
  filter: { workstationId?: string; status?: string } = {},
): Promise<DevOpsRequestDto[]> {
  const r = await rows(
    ctx.pool,
    `${REQUEST_SQL} WHERE w.user_id = $1 AND ($2::uuid IS NULL OR r.workstation_id = $2) AND ($3::text IS NULL OR r.status = $3)
      ORDER BY r.created_at DESC, r.id DESC LIMIT 200`,
    [userId, filter.workstationId ?? null, filter.status ?? null],
  );
  return r.map(toRequestDto);
}

export async function getDevOpsRequest(ctx: Ctx, userId: string, id: string): Promise<DevOpsRequestDetail> {
  const r = await one(ctx.pool, `${REQUEST_SQL} WHERE r.id = $1 AND w.user_id = $2`, [id, userId]);
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
          scope: userScope(user.id),
        },
      ],
      { tx },
    );
    // Check that the ticked rights are real on the machine, and retry environments that waited for them.
    await afterAccessChangedIn(ctx, tx, workstationId, access);
    return access;
  }).then((access) => {
    deliver(ctx, [workstationId]);
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
    const deskItemId = await resolveDevOpsApprovalIn(ctx, tx, user, requestId, resolution, note);
    await closeDeskItemIn(ctx, tx, deskItemId, { userId: user.id }, resolution, note);
  });
  ctx.services.dispatcher.trigger();
}

/** Same inside the caller's append transaction (the desk resolve path); returns the approval's desk item id. */
export async function resolveDevOpsApprovalIn(
  ctx: Ctx,
  tx: Tx,
  user: AuthSession['user'],
  requestId: string,
  resolution: 'approved' | 'rejected',
  note?: string,
): Promise<string> {
  // The machine's own user answers: approving runs commands on their workstation.
  const r = await one(
    tx,
    `SELECT r.* FROM devops_requests r JOIN workstations w ON w.id = r.workstation_id
      WHERE r.id=$1 AND w.user_id=$2 FOR UPDATE OF r`,
    [requestId, user.id],
  );
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
        scope: orgScope(r.org_id),
      },
      threadMessage(
        r.thread_id,
        r.org_id,
        { kind: 'user', userId: user.id },
        'answer',
        `${resolution === 'approved' ? 'Approved' : 'Rejected'}${note ? `: ${note}` : ''}`,
        { resolution },
      ),
    ],
    { tx },
  );
  return ap.deskItemId;
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
  const scope = orgScope(req.org_id);
  const agent = { kind: 'agent' as const, agentId: shift.agent_id as string };

  if (report.kind === 'comment') {
    await ctx.store.append([threadMessage(req.thread_id, req.org_id, agent, 'comment', report.note)], { tx });
    return { accepted: true };
  }
  if (report.kind !== 'outcome') {
    return {
      accepted: false,
      error: `questions are not available in a DevOps shift; ask for approval with \`aom ${DEVOPS_OUTCOME_APPROVAL.replace('_', '-')}\` instead`,
    };
  }
  if (req.status !== 'running') {
    return {
      accepted: false,
      error: 'already reported: exactly one terminal report is accepted per shift (409)',
    };
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
        ...(data.data.hygiene
          ? await hygieneReportEvents(ctx, tx, req, shift.agent_id as string, data.data.hygiene)
          : []),
        threadMessage(
          req.thread_id,
          req.org_id,
          agent,
          'handoff',
          `${data.data.summary}${data.data.commands.length ? `\n\nCommands:\n${data.data.commands.map((c) => `- ${c}`).join('\n')}` : ''}`,
          { commands: data.data.commands },
        ),
        {
          streamId: streamId.thread(req.id),
          event: {
            type: 'DevOpsRequestCompleted',
            payload: { requestId: req.id, status: 'done', summary: data.data.summary },
          },
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
    if (!data.success)
      return { accepted: false, error: `invalid devops-approval data: ${data.error.message}` };
    const project = req.card_id
      ? await one<{ project_id: string }>(tx, 'SELECT project_id FROM cards WHERE id=$1', [req.card_id])
      : undefined;
    const { deskItemId } = await raiseDeskItem(ctx, tx, {
      kind: 'approval',
      subkind: 'devops',
      title: `DevOps needs approval: ${data.data.action}`,
      body: data.data.reason,
      pinned: true,
      blocking: true,
      orgId: req.org_id,
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
          req.org_id,
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

/**
 * Whoever becomes a member of an organization (an invitation, the CLI, a migration) gets that organization's DevOps
 * engineer on each of their active workstations (owner decision 15). Idempotent: the accept flows hire synchronously,
 * this covers every other path and a retry after a crash.
 */
export function registerDevopsMembershipHook(ctx: Ctx): () => void {
  return ctx.store.subscribe(async (e) => {
    try {
      if (e.event.type !== 'OrgMemberAdded') return;
      const p = e.event.payload;
      await withAppendTx(ctx.pool, (tx) => hireDevopsForOrgIn(ctx, tx, p.userId, p.orgId));
    } catch (err) {
      ctx.log.warn({ err }, 'devops membership hook failed');
    }
  });
}
