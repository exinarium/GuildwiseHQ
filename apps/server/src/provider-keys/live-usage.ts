import { randomUUID } from 'node:crypto';
import {
  budgetStatus,
  choiceKeyUse,
  costUsdMicros,
  isCostUnknown,
  type KeyUseReport,
  PROVIDER_KEY_LABEL,
  type RunnerToServerOf,
  streamId,
} from '@aom/shared';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { evaluateProviderCap } from '../commands/org-provider-keys.ts';
import type { Ctx } from '../context.ts';
import { loadOwnerPrices } from '../costs/stamp.ts';
import { one } from '../db/sql.ts';
import { providerCapState } from './caps.ts';

/**
 * Live enforcement of the organization provider caps (Q48, docs/ARCHITECTURE.md section 38.7): a run that spends the
 * organization's key is stopped as soon as the month's spend (finished runs from `shift_costs` plus what the runs in flight
 * have reported so far, `run.usage`) reaches the cap, not only at queue or dispatch. The live numbers are in memory: they
 * are cumulative reports that the runner repeats while the run goes, and a restart simply waits for the next one. What
 * lasts is derived from events: the cap notice (once a month, `OrgProviderCapThresholdReached`) and the run's own end.
 * A workstation's own key is never counted or stopped; a model with no price is unknown and counts nothing (Q50).
 */
interface Live {
  kind: 'shift' | 'chat' | 'delegate';
  id: string;
  orgId: string;
  provider: string;
  workstationId: string;
  micros: number;
  at: number;
  threadId?: string | null;
  cardId?: string | null;
  sessionTurn: boolean;
}

/** A report older than this belongs to a run that ended without the server hearing (its cost is booked, or it is gone). */
const STALE_MS = 60_000;
/** How long a finished or stopped run's id is remembered (a late report for it counts nothing). */
const REMEMBER_MS = 3_600_000;

/**
 * What one report may claim: the runner is the party being checked, so a report is bounded by how long the run has been going
 * (from the server's own record of its start). Generous per-second rates (parallel streams, long cached contexts) plus a burst:
 * a run cannot have used more than this, whatever the runner says. Tokens above it are not counted live (the booked cost at the
 * end is what the runner really reports, and the cap check at dispatch uses that).
 */
export const LIVE_TOKEN_CEILING = {
  /** Fresh input and cache writes. */
  inputPerSec: 100_000,
  inputBurst: 1_000_000,
  /** Generated tokens. */
  outputPerSec: 1_000,
  outputBurst: 50_000,
  /** Cache reads (a long context is re-read at every call). */
  cacheReadPerSec: 500_000,
  cacheReadBurst: 5_000_000,
} as const;

/** The usage a run that started `elapsedMs` ago can plausibly have: each count is limited by the ceilings. Pure. */
export function clampLiveUsage<
  U extends {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheWrite1hTokens?: number;
  },
>(usage: U, elapsedMs: number): U {
  const sec = Math.max(0, elapsedMs) / 1000;
  const c = LIVE_TOKEN_CEILING;
  const inCap = Math.floor(c.inputBurst + c.inputPerSec * sec);
  const input = Math.min(usage.inputTokens, inCap);
  const write = Math.min(usage.cacheWriteTokens ?? 0, Math.max(0, inCap - input));
  return {
    ...usage,
    inputTokens: input,
    outputTokens: Math.min(usage.outputTokens, Math.floor(c.outputBurst + c.outputPerSec * sec)),
    cacheReadTokens: Math.min(
      usage.cacheReadTokens ?? 0,
      Math.floor(c.cacheReadBurst + c.cacheReadPerSec * sec),
    ),
    cacheWriteTokens: write,
    ...(usage.cacheWrite1hTokens !== undefined
      ? { cacheWrite1hTokens: Math.min(usage.cacheWrite1hTokens, write) }
      : {}),
  };
}

const registry = new WeakMap<Ctx, Map<string, Live>>();
/**
 * Runs already told to stop (later reports of the same run, which may take a moment to die, are ignored so it is stopped once)
 * and runs that ended (a late report must not bring them back). The value is when it was remembered; old entries are pruned.
 */
const stoppedRegistry = new WeakMap<Ctx, Map<string, number>>();
const stoppedOf = (ctx: Ctx): Map<string, number> => {
  let m = stoppedRegistry.get(ctx);
  if (!m) {
    m = new Map();
    stoppedRegistry.set(ctx, m);
  }
  return m;
};
const endedRegistry = new WeakMap<Ctx, Map<string, number>>();
const endedOf = (ctx: Ctx): Map<string, number> => {
  let m = endedRegistry.get(ctx);
  if (!m) {
    m = new Map();
    endedRegistry.set(ctx, m);
  }
  return m;
};

/** Forgets what is stale: reports nobody repeated (the run is gone) and old stop/end marks. Keeps every map bounded. */
function prune(ctx: Ctx): void {
  const now = ctx.clock.now().getTime();
  const live = liveOf(ctx);
  for (const [id, l] of live) if (now - l.at >= STALE_MS) live.delete(id);
  for (const m of [stoppedOf(ctx), endedOf(ctx)])
    for (const [id, at] of m) if (now - at >= REMEMBER_MS) m.delete(id);
}

/** How many runs are tracked (for tests: nothing may accumulate). */
export function liveUsageSize(ctx: Ctx): { live: number; stopped: number; ended: number } {
  return { live: liveOf(ctx).size, stopped: stoppedOf(ctx).size, ended: endedOf(ctx).size };
}
const liveOf = (ctx: Ctx): Map<string, Live> => {
  let m = registry.get(ctx);
  if (!m) {
    m = new Map();
    registry.set(ctx, m);
  }
  return m;
};

/** The run ended: its cost is in `shift_costs` now, so it no longer counts as live. */
export function dropLiveUsage(ctx: Ctx, id: string): void {
  liveOf(ctx).delete(id);
  stoppedOf(ctx).delete(id);
  // a report that was being resolved when the run ended must not put it back
  endedOf(ctx).set(id, ctx.clock.now().getTime());
}

/** Micros the runs in flight have used so far on this organization's key of the provider (for tests and the notice). */
export function liveSpendMicros(ctx: Ctx, orgId: string, provider: string): number {
  const now = ctx.clock.now().getTime();
  let sum = 0;
  for (const l of liveOf(ctx).values())
    if (l.orgId === orgId && l.provider === provider && now - l.at < STALE_MS) sum += l.micros;
  return sum;
}

async function resolveRun(
  ctx: Ctx,
  workstationId: string,
  msg: RunnerToServerOf<'run.usage'>,
): Promise<{
  orgId: string;
  runtime: string;
  model: string;
  threadId: string | null;
  cardId: string | null;
  sessionTurn: boolean;
  startedAt: Date | null;
} | null> {
  if (msg.kind === 'delegate') {
    // R3b: a child run reports its own usage; it counts against the cap of its own model's provider and is stopped with the rest.
    const d = await one(
      ctx.pool,
      `SELECT b.org_id, b.runtime, b.model, b.thread_id, b.caller_id, b.begun_at, s.card_id
         FROM delegate_begins b LEFT JOIN shifts s ON s.id = b.caller_id
        WHERE b.delegate_id::text=$1 AND b.workstation_id=$2
          AND NOT EXISTS (SELECT 1 FROM shift_costs sc WHERE sc.shift_id = b.delegate_id AND sc.kind = 'delegate')`,
      [msg.id, workstationId],
    );
    if (!d?.runtime || !d.model) return null;
    return {
      orgId: d.org_id,
      runtime: d.runtime,
      model: d.model,
      threadId: d.thread_id ?? null,
      cardId: d.card_id ?? null,
      sessionTurn: !!d.thread_id,
      startedAt: d.begun_at ? new Date(d.begun_at) : null,
    };
  }
  if (msg.kind === 'shift') {
    const s = await one(
      ctx.pool,
      `SELECT org_id, runtime, model, card_id, started_at FROM shifts
        WHERE id::text=$1 AND workstation_id=$2 AND status <> 'ended'`,
      [msg.id, workstationId],
    );
    if (!s) return null;
    return {
      orgId: s.org_id,
      runtime: s.runtime,
      model: s.model,
      threadId: null,
      cardId: s.card_id ?? null,
      sessionTurn: false,
      startedAt: s.started_at ? new Date(s.started_at) : null,
    };
  }
  // a session turn: it must be running on the workstation that reports it
  const t = await one(
    ctx.pool,
    `SELECT org_id, thread_id, model, COALESCE(started_at, queued_at) AS began FROM session_turns
      WHERE id::text=$1 AND status='running' AND workstation_id=$2`,
    [msg.id, workstationId],
  );
  if (t) {
    const m = t.model as { runtime?: string; model?: string } | null;
    if (!m?.runtime || !m.model) return null;
    return {
      orgId: t.org_id,
      runtime: m.runtime,
      model: m.model,
      threadId: t.thread_id,
      cardId: null,
      sessionTurn: true,
      startedAt: t.began ? new Date(t.began) : null,
    };
  }
  // a plain chat is a shift of kind 'chat' on the agent's workstation (it must be the one reporting)
  const c = await one(
    ctx.pool,
    `SELECT org_id, runtime, model, started_at FROM shifts
      WHERE id::text=$1 AND kind='chat' AND workstation_id=$2 AND status <> 'ended'`,
    [msg.id, workstationId],
  );
  if (!c) return null;
  return {
    orgId: c.org_id,
    runtime: c.runtime,
    model: c.model,
    threadId: ctx.services.chat?.threadOfChat(msg.id) ?? null,
    cardId: null,
    sessionTurn: false,
    startedAt: c.started_at ? new Date(c.started_at) : null,
  };
}

/** `run.usage`: counts the report and, when the cap is reached, stops every run of the organization on that key. */
export async function applyRunUsage(
  ctx: Ctx,
  ws: { id: string },
  msg: RunnerToServerOf<'run.usage'>,
): Promise<void> {
  prune(ctx);
  if (stoppedOf(ctx).has(msg.id) || endedOf(ctx).has(msg.id)) return;
  const run = await resolveRun(ctx, ws.id, msg);
  if (!run) return;
  const w = await one(ctx.pool, 'SELECT runtimes FROM workstations WHERE id=$1', [ws.id]);
  const reports = (Array.isArray(w?.runtimes) ? w?.runtimes : []) as KeyUseReport[];
  const use = choiceKeyUse(reports, { runtime: run.runtime, model: run.model }, run.orgId);
  if (!use || use.source !== 'org') return; // the workstation's own key (or none): never counted, never stopped
  // the report is bounded by how long the run has been going (the server's own record of its start)
  const now = ctx.clock.now().getTime();
  const elapsed = run.startedAt ? Math.max(0, now - run.startedAt.getTime()) : 0;
  const usage = clampLiveUsage(msg.usage, elapsed);
  const live = liveOf(ctx);
  // a model with no price is unknown: it counts nothing against the cap (Q50)
  // ... unless the Owner set a price for it (R2): the live figure is priced the way the booked cost will be
  const priced = msg.usage.model ?? (run.runtime === 'gemini' ? `gemini:${run.model}` : run.model);
  const owner = await loadOwnerPrices(ctx.pool, run.orgId);
  const micros = isCostUnknown(priced, undefined, owner)
    ? 0
    : costUsdMicros(priced, { ...usage }, undefined, owner);
  // the run ended (or was stopped) while this report was being resolved: it must not come back
  if (endedOf(ctx).has(msg.id) || stoppedOf(ctx).has(msg.id)) return;
  live.set(msg.id, {
    kind: msg.kind,
    id: msg.id,
    orgId: run.orgId,
    provider: use.provider,
    workstationId: ws.id,
    micros,
    at: ctx.clock.now().getTime(),
    threadId: run.threadId,
    cardId: run.cardId,
    sessionTurn: run.sessionTurn,
  });
  await enforceProviderCap(ctx, run.orgId, use.provider);
}

/** Stops the runs in flight on an organization key whose cap the live spend has reached. Safe to repeat. */
export async function enforceProviderCap(ctx: Ctx, orgId: string, provider: string): Promise<void> {
  const now = ctx.clock.now();
  const st = await providerCapState(ctx.pool, orgId, provider, now);
  if (st.capMicros === null || st.overridden) return;
  const liveMicros = liveSpendMicros(ctx, orgId, provider);
  if (budgetStatus(st.capMicros, st.spendMicros + liveMicros, false).state !== 'paused') return;
  // the notice first (once a month, replay-safe), counting the live spend, so the dispatcher refuses new starts too
  await evaluateProviderCap(ctx, orgId, provider, liveMicros);
  const label = PROVIDER_KEY_LABEL[provider] ?? provider;
  const live = liveOf(ctx);
  for (const l of [...live.values()]) {
    if (l.orgId !== orgId || l.provider !== provider) continue;
    live.delete(l.id);
    stoppedOf(ctx).set(l.id, now.getTime()); // once: the stop below is not repeated by the next report
    const text = `Stopped: the organization's ${label} key reached its monthly cap while this was running. Raise the cap or override it for this month under Settings > Model providers, or run it on a workstation with its own ${label} key.`;
    if (l.kind === 'shift') ctx.services.gateway.stopShift(l.workstationId, l.id, 'manager');
    // a chat, a session turn or a delegate: the runner knows each by this id
    else ctx.services.runners.send(l.workstationId, 'chat.cancel', { chatId: l.id }, now);
    const thread = l.threadId ?? (l.cardId ? await cardThread(ctx, l.cardId) : null);
    if (thread)
      await ctx.store.append([
        {
          streamId: streamId.thread(thread),
          event: {
            type: 'ThreadMessagePosted',
            payload: {
              threadId: thread,
              messageId: randomUUID(),
              authorKind: 'system',
              kind: 'system',
              body: text,
              data: { blocked: 'provider_cap_reached', stoppedRun: l.id },
            },
          },
          actor: SYSTEM_ACTOR,
          scope: orgScope(orgId),
        },
      ]);
  }
}

async function cardThread(ctx: Ctx, cardId: string): Promise<string | null> {
  const t = await one(ctx.pool, `SELECT id FROM threads WHERE card_id=$1 AND kind='card' LIMIT 1`, [cardId]);
  return t?.id ?? null;
}
