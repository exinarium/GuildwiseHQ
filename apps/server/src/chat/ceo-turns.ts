import { randomUUID } from 'node:crypto';
import {
  type AgentRuntimeSpec,
  CEO_DEGRADED_FULL_POWER_OFF,
  CEO_FULL_POWER_CAPABILITY,
  CEO_QUEUE_STALE_HOURS,
  type ChatContext,
  costUsdMicros,
  isKnownChoice,
  type ModelChoice,
  modelChoiceLabel,
  normalizeJobKind,
  type RunnerToServerOf,
  resolveModelChoice,
  streamId,
  type ToolCounts,
} from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import { buildOwnerBrief, buildOwnerContext } from '../ceo/brief.ts';
import { authorizedOrders, currentAuthority, orderVersionHash } from '../ceo/orders.ts';
import { loadCeo } from '../ceo/state.ts';
import { agentActor, orgScope, runnerActor, SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { agentSpecFor } from '../runner-gateway/brief.ts';

/** A CEO conversation is one long session (docs section 5.3): it rotates after this long or this much context. */
export const CEO_SESSION_MAX_MS = 24 * 3_600_000;
export const CEO_SESSION_MAX_CONTEXT_TOKENS = 120_000;

const ZERO_USAGE = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** What the relay tracks for a CEO owner or order turn that is on its way (also persisted in `ceo_turns`). */
export interface CeoInflightInfo {
  mode: 'owner' | 'order';
  model: ModelChoice;
  queuedAt: Date;
  /** The owner's message that started it (an order turn has none). */
  messageId: string | null;
  orderEntryId: string | null;
  orderVersionHash: string | null;
  runtimeSessionStartedAt: Date;
  cwd: string;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** `ceo.settings.models.chat` as a choice for the agent's runtime. */
export function defaultChoiceOf(agent: Row, chat: { model: string; effort: string }): ModelChoice {
  return { runtime: agent.runtime, model: chat.model, effort: chat.effort };
}

/** The thread's model override (a `ChatThreadModelSet` choice), or null. */
export function threadOverride(row: Row): ModelChoice | null {
  const o = row.model_override as ModelChoice | null;
  return o?.runtime && o?.model ? o : null;
}

/** Message override, else thread override, else the default; unknown choices are refused (null). */
export function resolveTurnModel(
  agent: Row,
  threadRow: Row,
  chat: { model: string; effort: string },
  message?: ModelChoice | null,
): { choice: ModelChoice; source: 'message' | 'thread' | 'default' } | null {
  const r = resolveModelChoice({
    message: message ?? null,
    thread: threadOverride(threadRow),
    default: defaultChoiceOf(agent, chat),
  });
  if (r.source !== 'default' && !isKnownChoice(r.choice)) return null;
  return r;
}

/** Does this workstation announce the CEO's full-power profile (the machine owner ran `aom-runner ceo full-power on`)? */
export async function workstationFullPower(db: Queryable, workstationId: string): Promise<boolean> {
  const r = await one(
    db,
    'SELECT $2 = ANY(capabilities) AS on FROM workstation_capabilities WHERE workstation_id=$1',
    [workstationId, CEO_FULL_POWER_CAPABILITY],
  );
  return r?.on === true;
}

interface PriorSession {
  sessionId: string | undefined;
  startedAt: Date;
  /** Why a new session starts when `sessionId` is absent. */
  fresh: 'first' | 'runtime' | 'cwd' | 'rotated' | undefined;
}

/**
 * The session this turn resumes. The same runtime resumes its session (a model change keeps it); another runtime, another
 * working directory, 24 hours or 120K tokens of context start a new one with a handover (docs sections 5.2 to 5.4).
 */
export async function sessionPlan(
  ctx: Ctx,
  threadId: string,
  choice: ModelChoice,
  cwd: string,
): Promise<PriorSession> {
  const now = ctx.clock.now();
  const last = await one(
    ctx.pool,
    `SELECT data, created_at FROM thread_messages
      WHERE thread_id=$1 AND author_kind='agent' AND data ? 'runtimeSessionId'
        AND COALESCE(data->>'runtime','claude-code') = $2
      ORDER BY created_at DESC, event_seq DESC LIMIT 1`,
    [threadId, choice.runtime],
  );
  if (!last) {
    const any = await one(
      ctx.pool,
      `SELECT 1 FROM thread_messages WHERE thread_id=$1 AND author_kind='agent' LIMIT 1`,
      [threadId],
    );
    return { sessionId: undefined, startedAt: now, fresh: any ? 'runtime' : 'first' };
  }
  const d = last.data as {
    runtimeSessionId: string;
    cwd?: string;
    sessionStartedAt?: string;
    usage?: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  };
  const startedAt = d.sessionStartedAt ? new Date(d.sessionStartedAt) : new Date(last.created_at);
  if ((d.cwd ?? '') !== cwd) return { sessionId: undefined, startedAt: now, fresh: 'cwd' };
  const tokens =
    (d.usage?.inputTokens ?? 0) + (d.usage?.cacheReadTokens ?? 0) + (d.usage?.cacheWriteTokens ?? 0);
  if (now.getTime() - startedAt.getTime() > CEO_SESSION_MAX_MS || tokens > CEO_SESSION_MAX_CONTEXT_TOKENS)
    return { sessionId: undefined, startedAt: now, fresh: 'rotated' };
  return { sessionId: d.runtimeSessionId, startedAt, fresh: undefined };
}

/** The handover for a new session: the last 20 messages, open tasks and the corrections of this conversation. */
export async function handoverSummary(
  ctx: Ctx,
  orgId: string,
  threadId: string,
): Promise<string | undefined> {
  const msgs = await rows(
    ctx.pool,
    `SELECT author_kind, body FROM thread_messages WHERE thread_id=$1 AND kind IN ('chat','system')
      ORDER BY created_at DESC, event_seq DESC LIMIT 20`,
    [threadId],
  );
  if (!msgs.length) return undefined;
  const tasks = await rows(
    ctx.pool,
    `SELECT title, status FROM ceo_tasks WHERE org_id=$1 AND status IN ('open','in_progress','waiting_owner','waiting_work') ORDER BY created_at LIMIT 10`,
    [orgId],
  );
  const corr = await rows(
    ctx.pool,
    `SELECT rule FROM ceo_corrections WHERE org_id=$1 ORDER BY created_at DESC LIMIT 10`,
    [orgId],
  );
  return [
    '## Handover: this conversation continues in a new session',
    'The earlier session ended (another runtime, another working directory, or it grew too long). What was said last, oldest first:',
    msgs
      .reverse()
      .map(
        (m) =>
          `${m.author_kind === 'user' ? 'Owner' : m.author_kind === 'agent' ? 'You' : 'System'}: ${clip(String(m.body).replace(/\s+/g, ' '), 600)}`,
      )
      .join('\n'),
    tasks.length ? `Open tasks: ${tasks.map((t) => `${t.title} [${t.status}]`).join('; ')}` : '',
    corr.length ? `Corrections from this conversation: ${corr.map((c) => c.rule).join(' | ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** The first line of a message, for the title of an automatic job log. */
export const firstLine = (s: string): string =>
  clip((s.split('\n').find((l) => l.trim()) ?? s).trim().replace(/\s+/g, ' '), 200);

export interface ThreadRow extends Row {
  thread_kind: string;
}

/** The turn row of a chat id (the turn id is the chat id and the shift id), or undefined. */
export async function loadTurn(db: Queryable, id: string): Promise<Row | undefined> {
  return one(db, 'SELECT * FROM ceo_turns WHERE id=$1', [id]);
}

/** Cards, requests and deploys the CEO started in this turn: the turn used the board, so no off-board job is logged. */
const BOARD_ACTIONS = ['intake', 'draft-cards', 'specify', 'devops', 'deploy', 'invoke-order'];

/**
 * The server backstop of the off-system job log (docs section 4.2): an owner turn that used tools, created no board object
 * and logged no job gets an automatic `unlabelled` entry with the first line of the owner's message as its title.
 */
export async function backstopJobEvents(
  ctx: Ctx,
  turn: Row,
  info: { toolCounts: ToolCounts | undefined; usage: typeof ZERO_USAGE; durationMs: number; model: string },
): Promise<AppendInput[]> {
  if (turn.mode !== 'owner') return [];
  const t = info.toolCounts;
  if (!t || t.bash + t.edit + t.mcp === 0) return [];
  const board = await one(
    ctx.pool,
    `SELECT 1 FROM ceo_actions WHERE turn_id=$1 AND mode='decided' AND action = ANY($2::text[]) LIMIT 1`,
    [turn.id, BOARD_ACTIONS],
  );
  if (board) return [];
  const logged = await one(ctx.pool, 'SELECT 1 FROM ceo_offboard_jobs WHERE turn_id=$1 LIMIT 1', [turn.id]);
  if (logged) return [];
  const msg = turn.message_id
    ? await one(ctx.pool, 'SELECT body FROM thread_messages WHERE id=$1', [turn.message_id])
    : undefined;
  return [
    {
      streamId: streamId.ceo(turn.org_id),
      event: {
        type: 'CeoOffboardJobLogged',
        payload: {
          jobId: randomUUID(),
          orgId: turn.org_id,
          turnId: turn.id,
          kind: normalizeJobKind('unlabelled'),
          title: firstLine(msg?.body ?? 'A job done in the chat'),
          summary: '',
          costMicros: costUsdMicros(info.model, { ...info.usage }),
          durationMs: info.durationMs,
          auto: true,
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(turn.org_id),
    },
  ];
}

export interface DispatchPlan {
  turn: Row;
  agent: Row;
  thread: Row;
}

/** Everything `chat.start` needs for a CEO turn, or the reason it cannot start now. */
export async function buildChatStart(
  ctx: Ctx,
  plan: DispatchPlan,
  opts: { message: string; order?: { entryId: string; hash: string } },
): Promise<
  | { ok: false; reason: 'offline' | 'unavailable'; message: string }
  | {
      ok: true;
      workstationId: string;
      payload: Record<string, unknown>;
      model: ModelChoice;
      info: CeoInflightInfo;
      degraded: boolean;
    }
> {
  const { turn, agent, thread } = plan;
  const ceo = await loadCeo(ctx.pool, turn.org_id);
  if (!ceo || !ceo.enabled || ceo.agentId !== agent.id)
    return { ok: false, reason: 'unavailable', message: 'the CEO is not available' };
  const ws = await one(ctx.pool, `SELECT id, name, user_id, status FROM workstations WHERE id=$1`, [
    agent.workstation_id,
  ]);
  if (!ws || ws.status !== 'active' || !ctx.services.runners.isOnline(ws.id))
    return { ok: false, reason: 'offline', message: 'the workstation is offline' };
  const ownerId = await orgOwnerId(ctx.pool, turn.org_id);
  // Full power belongs to the Owner and stays on his machine: another user's workstation runs the restricted profile.
  const fullPowerHost = ws.user_id === ownerId;
  const model = turn.model as ModelChoice;
  const cwd = ceo.settings.ownerTurn.cwd;
  const plan2 = await sessionPlan(ctx, turn.thread_id, model, cwd);
  const brief = await buildOwnerBrief(ctx, ceo, agent);
  const handover =
    plan2.fresh && plan2.fresh !== 'first'
      ? await handoverSummary(ctx, turn.org_id, turn.thread_id)
      : undefined;
  const lastDone = await one(
    ctx.pool,
    `SELECT finished_at FROM ceo_turns WHERE thread_id=$1 AND status='done' AND id <> $2 ORDER BY finished_at DESC LIMIT 1`,
    [turn.thread_id, turn.id],
  );
  const dyn = await buildOwnerContext(ctx, ceo, {
    since: plan2.sessionId && lastDone?.finished_at ? new Date(lastDone.finished_at) : undefined,
    handover,
  });
  const spec = await agentSpecFor(ctx, agent);
  const agentSpec: AgentRuntimeSpec = {
    ...spec,
    runtime: model.runtime,
    model: model.model,
  };
  if (model.effort) agentSpec.effort = model.effort;
  else delete agentSpec.effort;
  const context: ChatContext = { orgId: turn.org_id, ceo: { brief } };
  const payload: Record<string, unknown> = {
    chatId: turn.id,
    threadId: turn.thread_id,
    agent: agentSpec,
    message: opts.message,
    ...(plan2.sessionId ? { resumeSessionId: plan2.sessionId } : {}),
    context,
    ...(fullPowerHost ? { ceoMode: turn.mode } : {}),
    ...(cwd ? { cwd } : {}),
    ...((thread.dirs as string[] | null)?.length ? { addDirs: thread.dirs } : {}),
    ...(turn.queued ? { queuedAt: new Date(turn.queued_at).toISOString() } : {}),
    ...(dyn ? { briefDelta: dyn } : {}),
  };
  if (turn.mode === 'order' && opts.order) {
    const e = await one(
      ctx.pool,
      'SELECT title, body, retired_at, superseded_by FROM ledger_entries WHERE id=$1',
      [opts.order.entryId],
    );
    const auth = await currentAuthority(ctx.pool, opts.order.entryId);
    if (
      !e ||
      !auth ||
      auth.versionHash !== opts.order.hash ||
      orderVersionHash(e.title, e.body) !== auth.versionHash
    )
      return {
        ok: false,
        reason: 'unavailable',
        message: 'the order is no longer authorized in this wording',
      };
    payload.order = {
      entryId: opts.order.entryId,
      versionHash: auth.versionHash,
      title: e.title,
      body: e.body,
      ownerMarked: true,
      covers: auth.covers,
    };
  }
  return {
    ok: true,
    workstationId: ws.id,
    payload,
    model,
    degraded: !fullPowerHost,
    info: {
      mode: turn.mode,
      model,
      queuedAt: new Date(turn.queued_at),
      messageId: turn.message_id ?? null,
      orderEntryId: turn.order_entry_id ?? null,
      orderVersionHash: turn.order_version_hash ?? null,
      runtimeSessionStartedAt: plan2.startedAt,
      cwd,
    },
  };
}

/** What `chat.done` adds to the owner's reply message (the next turn reads `runtimeSessionId`, `runtime` and `cwd`). */
export function replyData(
  msg: RunnerToServerOf<'chat.done'>,
  info: CeoInflightInfo,
  waitedMs: number | undefined,
): Record<string, unknown> {
  return {
    ...(msg.runtimeSessionId ? { runtimeSessionId: msg.runtimeSessionId } : {}),
    usage: msg.usage,
    runtime: info.model.runtime,
    model: modelChoiceLabel(info.model),
    modelChoice: info.model,
    cwd: info.cwd,
    sessionStartedAt: info.runtimeSessionStartedAt.toISOString(),
    ...(waitedMs ? { waitedMs } : {}),
    ...(msg.degraded ? { degraded: msg.degraded } : {}),
    ...(msg.degraded === CEO_DEGRADED_FULL_POWER_OFF
      ? { notice: 'Full power is off on this workstation: this reply ran in the restricted mode.' }
      : {}),
  };
}

export const STALE_QUEUE_MS = CEO_QUEUE_STALE_HOURS * 3_600_000;

export { agentActor, authorizedOrders, runnerActor, SYSTEM_ACTOR, userActor };
