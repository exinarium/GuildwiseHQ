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
  kind: 'shift' | 'chat';
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

const registry = new WeakMap<Ctx, Map<string, Live>>();
/** Runs already told to stop: later reports of the same run (it may take a moment to die) are ignored, so it is stopped once. */
const stoppedRegistry = new WeakMap<Ctx, Set<string>>();
const stoppedOf = (ctx: Ctx): Set<string> => {
  let m = stoppedRegistry.get(ctx);
  if (!m) stoppedRegistry.set(ctx, (m = new Set()));
  return m;
};
const liveOf = (ctx: Ctx): Map<string, Live> => {
  let m = registry.get(ctx);
  if (!m) registry.set(ctx, (m = new Map()));
  return m;
};

/** The run ended: its cost is in `shift_costs` now, so it no longer counts as live. */
export function dropLiveUsage(ctx: Ctx, id: string): void {
  liveOf(ctx).delete(id);
  stoppedOf(ctx).delete(id);
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
} | null> {
  if (msg.kind === 'shift') {
    const s = await one(
      ctx.pool,
      `SELECT org_id, runtime, model, card_id FROM shifts WHERE id=$1 AND workstation_id=$2 AND status <> 'ended'`,
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
    };
  }
  const t = await one(
    ctx.pool,
    `SELECT org_id, thread_id, model FROM session_turns WHERE id::text=$1 AND status='running'`,
    [msg.id],
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
    };
  }
  // a plain chat: the agent the thread belongs to
  const c = await one(
    ctx.pool,
    `SELECT t.org_id, t.id AS thread_id, a.runtime, a.model FROM threads t JOIN agents a ON a.id = t.agent_id
      WHERE t.id = (SELECT thread_id FROM thread_messages WHERE id::text=$1 LIMIT 1)`,
    [msg.id],
  );
  if (!c) return null;
  return {
    orgId: c.org_id,
    runtime: c.runtime,
    model: c.model,
    threadId: c.thread_id,
    cardId: null,
    sessionTurn: false,
  };
}

/** `run.usage`: counts the report and, when the cap is reached, stops every run of the organization on that key. */
export async function applyRunUsage(
  ctx: Ctx,
  ws: { id: string },
  msg: RunnerToServerOf<'run.usage'>,
): Promise<void> {
  if (stoppedOf(ctx).has(msg.id)) return;
  const run = await resolveRun(ctx, ws.id, msg);
  if (!run) return;
  const w = await one(ctx.pool, 'SELECT runtimes FROM workstations WHERE id=$1', [ws.id]);
  const reports = (Array.isArray(w?.runtimes) ? w?.runtimes : []) as KeyUseReport[];
  const use = choiceKeyUse(reports, { runtime: run.runtime, model: run.model }, run.orgId);
  if (!use || use.source !== 'org') return; // the workstation's own key (or none): never counted, never stopped
  const live = liveOf(ctx);
  // a model with no price is unknown: it counts nothing against the cap (Q50)
  const priced = msg.usage.model ?? (run.runtime === 'gemini' ? `gemini:${run.model}` : run.model);
  const micros = isCostUnknown(priced) ? 0 : costUsdMicros(priced, { ...msg.usage });
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
    stoppedOf(ctx).add(l.id); // once: the stop below is not repeated by the next report
    const text = `Stopped: the organization's ${label} key reached its monthly cap while this was running. Raise the cap or override it for this month under Settings > Model providers, or run it on a workstation with its own ${label} key.`;
    if (l.kind === 'shift') ctx.services.gateway.stopShift(l.workstationId, l.id, 'manager');
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
