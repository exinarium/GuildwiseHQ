import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  HOOK_DEFAULT_PER_HOUR,
  hookTokens,
  isOrgOperational,
  type ScheduleRunResult,
  type ScheduleTrigger,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { HttpError, notFound } from '../errors.ts';
import { countInbound } from '../mail/inbound/ingest.ts';
import {
  executeAction,
  failedRun,
  type RunOutcome,
  type RunSpec,
  runRecordedEvent,
} from './schedule-actions.ts';
import { afterRun, assertOwnerStillAllowed, hashHookSecret } from './schedules.ts';

/**
 * Incoming webhooks as an automation trigger (backlog #14, docs/design/workflow-builder.md). `POST /api/hooks/:id/:secret`
 * (or `Authorization: Bearer <secret>` on `/api/hooks/:id`) runs the automation once. The secret is the credential and is
 * kept as a hash; a wrong id, a wrong secret, a revoked or a switched-off hook all answer the same 404. The payload is
 * outside content: it reaches the action only as `{hook.*}` mapping tokens, the cards it makes are drafts unless the
 * Owner allowed otherwise, and briefs render the fields it filled inside an untrusted block. Every accepted call is a run
 * in the automation's history (the payload text is not stored in it).
 */

export interface HookResult {
  status: 200 | 202 | 422 | 429;
  body: Record<string, unknown>;
}

const sameHash = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** A short fingerprint of an idempotency key (the key itself is the sender's and not stored). */
const keyDigest = (key: string): string => createHash('sha256').update(key).digest('hex').slice(0, 32);

export async function receiveHook(
  ctx: Ctx,
  call: { scheduleId: string; secret: string | null; payload: unknown; idempotencyKey?: string | undefined },
): Promise<HookResult> {
  const s = await one(ctx.pool, `SELECT * FROM schedules WHERE id=$1 AND trigger->>'kind'='webhook_in'`, [
    call.scheduleId,
  ]);
  const trigger = s?.trigger as Extract<ScheduleTrigger, { kind: 'webhook_in' }> | undefined;
  const good =
    s?.enabled &&
    s.action &&
    trigger?.secretHash &&
    call.secret &&
    sameHash(hashHookSecret(call.secret), trigger.secretHash);
  if (!s || !trigger || !good) {
    await countInbound(ctx.pool, 'hook_refused').catch(() => {});
    throw notFound('no such hook');
  }
  const now = ctx.clock.now();
  const limit = trigger.maxPerHour ?? HOOK_DEFAULT_PER_HOUR;
  const since = new Date(now.getTime() - 3_600_000);
  const calls = Number(
    (
      await one(
        ctx.pool,
        `SELECT count(*) AS n FROM schedule_runs WHERE schedule_id=$1 AND source_key LIKE 'hook:%' AND started_at > $2`,
        [s.id, since],
      )
    )?.n ?? 0,
  );
  if (calls >= limit) {
    await recordLimit(ctx, s, limit, now);
    return {
      status: 429,
      body: { ok: false, error: 'rate_limited', message: `At most ${limit} calls per hour` },
    };
  }

  const sourceKey = call.idempotencyKey ? `hook:k:${keyDigest(call.idempotencyKey)}` : `hook:${randomUUID()}`;
  const keys =
    call.payload && typeof call.payload === 'object' && !Array.isArray(call.payload)
      ? Object.keys(call.payload).slice(0, 20)
      : [];
  const spec: RunSpec = {
    trigger: 'event',
    sourceKey,
    label: 'Incoming webhook',
    firedFor: now,
    text: { event: 'incoming webhook', ref: '' },
    tokens: { ...hookTokens(call.payload), event: 'incoming webhook' },
    hook: { allowQueued: trigger.allowQueued === true },
    details: { event: 'incoming_webhook', hook: { keys } },
  };
  let outcome: RunOutcome | null = null;
  let duplicate = false;
  try {
    outcome = await withAppendTx(ctx.pool, async (tx) => {
      const cur = await one(tx, 'SELECT * FROM schedules WHERE id=$1 AND enabled FOR UPDATE', [s.id]);
      const curTrigger = cur?.trigger as typeof trigger | undefined;
      // A rotate or revoke between the check above and now wins.
      if (!cur?.action || curTrigger?.secretHash !== trigger.secretHash) throw notFound('no such hook');
      if (
        await one(tx, 'SELECT 1 FROM schedule_runs WHERE schedule_id=$1 AND source_key=$2', [s.id, sourceKey])
      ) {
        duplicate = true;
        return null;
      }
      const org = await one(tx, 'SELECT status FROM organizations WHERE id=$1', [cur.org_id]);
      if (org && !isOrgOperational(org.status)) throw notFound('no such hook');
      if (cur.project_id) {
        const p = await one(tx, 'SELECT status FROM projects WHERE id=$1', [cur.project_id]);
        if (!p || p.status !== 'active') throw notFound('no such hook');
      }
      await assertOwnerStillAllowed(tx, cur);
      const o = await executeAction(ctx, tx, cur, spec);
      await ctx.store.append([...o.events, runRecordedEvent(cur, o, spec, now)], { tx });
      return o;
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const runId = randomUUID();
    await withAppendTx(ctx.pool, async (tx) => {
      if (
        await one(tx, 'SELECT 1 FROM schedule_runs WHERE schedule_id=$1 AND source_key=$2', [s.id, sourceKey])
      )
        return;
      await ctx.store.append([failedRun(runId, s, spec, msg)], { tx });
    }).catch(() => {});
    return { status: 422, body: { ok: false, error: 'run_failed', message: msg.slice(0, 300), runId } };
  }
  if (duplicate) return { status: 200, body: { ok: true, duplicate: true } };
  if (!outcome) return { status: 200, body: { ok: true } };
  await afterRun(ctx, outcome);
  const result = (outcome.result ?? {}) as ScheduleRunResult;
  return {
    status: 202,
    body: {
      ok: true,
      runId: outcome.runId,
      status: outcome.status,
      summary: outcome.summary,
      ...(result.cardIds?.length ? { cardIds: result.cardIds } : {}),
    },
  };
}

/** One audit run per hour says the hook is over its limit (every refused call would otherwise be a write). */
async function recordLimit(ctx: Ctx, s: Record<string, any>, limit: number, now: Date): Promise<void> {
  const hour = now.toISOString().slice(0, 13);
  const spec: RunSpec = {
    trigger: 'event',
    sourceKey: `hook-limit:${hour}`,
    label: 'Incoming webhook',
    firedFor: now,
  };
  await withAppendTx(ctx.pool, async (tx) => {
    if (await one(tx, 'SELECT 1 FROM schedule_runs WHERE schedule_id=$1 AND source_key=$2', [s.id, spec.sourceKey]))
      return;
    const o: RunOutcome = {
      runId: randomUUID(),
      events: [],
      status: 'ok',
      summary: `Skipped: more than ${limit} calls in an hour, further calls are refused until the hour passes`,
      after: [],
    };
    await ctx.store.append([runRecordedEvent(s as never, o, spec, now)], { tx });
  }).catch(() => {});
}
