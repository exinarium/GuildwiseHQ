import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  isRetryableStatus,
  type ScheduleAction,
  type ScheduleDelivery,
  streamId,
  WEBHOOK_MAX_ATTEMPTS,
  webhookBackoffMs,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest } from '../errors.ts';
import { SYSTEM_ACTOR } from './common.ts';
import { scheduleScope, webhookSecret } from './schedule-actions.ts';

const TIMEOUT_MS = 10_000;

/** Loopback, private, link-local and unique-local addresses (an outgoing webhook must not reach the inside by default). */
export function isPrivateAddress(ip: string): boolean {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateAddress(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

/** 400 for a URL a webhook may not post to. The same check runs again, on the resolved address, at delivery. */
export function assertWebhookUrl(ctx: Ctx, url: string): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw badRequest('invalid_url', 'the webhook URL is not a valid URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw badRequest('invalid_url', 'the webhook URL must start with https:// or http://');
  if (u.username || u.password)
    throw badRequest('invalid_url', 'put no user name or password in the URL: use the signature instead');
  if (!ctx.config.webhookAllowPrivate) {
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    )
      throw badRequest('private_url', 'the webhook URL points at this machine or a private network');
    if (isIP(host) && isPrivateAddress(host))
      throw badRequest('private_url', 'the webhook URL points at this machine or a private network');
  }
  return u;
}

async function assertResolvesPublic(ctx: Ctx, u: URL): Promise<void> {
  if (ctx.config.webhookAllowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) return;
  const all = await lookup(host, { all: true });
  if (all.some((a) => isPrivateAddress(a.address)))
    throw badRequest('private_url', 'the webhook host resolves to a private address');
}

/** `X-AOM-Signature`: `sha256=` + hex HMAC of `<timestamp>.<body>` with the webhook's secret. */
export const signWebhook = (secret: string, timestamp: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;

export interface AttemptResult {
  ok: boolean;
  httpStatus?: number;
  error?: string;
  retryable: boolean;
  durationMs: number;
}

async function postWebhook(
  ctx: Ctx,
  s: Row,
  runId: string,
  d: Extract<ScheduleDelivery, { kind: 'webhook' }>,
): Promise<AttemptResult> {
  const started = Date.now();
  try {
    const u = assertWebhookUrl(ctx, d.url);
    await assertResolvesPublic(ctx, u);
    const secret = await webhookSecret(ctx, s.action as ScheduleAction);
    const timestamp = String(Math.floor(ctx.clock.now().getTime() / 1000));
    const res = await fetch(u, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        'content-type': 'application/json',
        'user-agent': 'GuildwiseHQ-Webhook/1',
        'x-aom-event': d.event,
        'x-aom-delivery': runId,
        'x-aom-timestamp': timestamp,
        ...(secret ? { 'x-aom-signature': signWebhook(secret, timestamp, d.body) } : {}),
      },
      body: d.body,
    });
    await res.arrayBuffer().catch(() => undefined);
    const durationMs = Date.now() - started;
    if (res.status >= 200 && res.status < 300)
      return { ok: true, httpStatus: res.status, retryable: false, durationMs };
    return {
      ok: false,
      httpStatus: res.status,
      error: `the endpoint answered ${res.status}${res.status >= 300 && res.status < 400 ? ' (redirects are not followed)' : ''}`,
      retryable: isRetryableStatus(res.status),
      durationMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - started;
    // A bad URL is final; a network error or a timeout is worth another try.
    const final = err instanceof Error && 'status' in err && (err as { status?: number }).status === 400;
    return { ok: false, error: msg.slice(0, 500), retryable: !final, durationMs };
  }
}

async function sendMail(ctx: Ctx, d: Extract<ScheduleDelivery, { kind: 'email' }>): Promise<AttemptResult> {
  const started = Date.now();
  try {
    for (const to of d.to) await ctx.mailer.send({ to, subject: d.subject, text: d.text });
    return { ok: true, retryable: false, durationMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      retryable: true,
      durationMs: Date.now() - started,
    };
  }
}

/**
 * One try of a pending delivery. The HTTP call or the mail is made outside any transaction; the outcome is one
 * `ScheduleDeliveryAttempted`. A retryable failure schedules the next try with a growing pause (1 min, 5 min, 30 min,
 * 2 h) up to five tries; `single` (a test) never retries.
 */
export async function attemptDelivery(
  ctx: Ctx,
  runId: string,
  opts: { single?: boolean } = {},
): Promise<AttemptResult | null> {
  const run = await one(ctx.pool, `SELECT * FROM schedule_runs WHERE id=$1 AND status='pending'`, [runId]);
  const delivery = run?.delivery as ScheduleDelivery | null | undefined;
  if (!run || !delivery) return null;
  const s = await one(ctx.pool, 'SELECT * FROM schedules WHERE id=$1', [run.schedule_id]);
  if (!s) return null;
  const attempt = Number(run.attempts) + 1;
  const result =
    delivery.kind === 'webhook' ? await postWebhook(ctx, s, runId, delivery) : await sendMail(ctx, delivery);
  const now = ctx.clock.now();
  const retry = !result.ok && result.retryable && !opts.single && attempt < WEBHOOK_MAX_ATTEMPTS;
  const nextAttemptAt = retry ? new Date(now.getTime() + webhookBackoffMs(attempt)) : null;
  await withAppendTx(ctx.pool, async (tx) => {
    const cur = await one(tx, `SELECT attempts, status FROM schedule_runs WHERE id=$1 FOR UPDATE`, [runId]);
    if (!cur || cur.status !== 'pending' || Number(cur.attempts) !== Number(run.attempts)) return; // answered elsewhere
    await ctx.store.append(
      [
        {
          streamId: streamId.schedule(s.id),
          event: {
            type: 'ScheduleDeliveryAttempted',
            payload: {
              runId,
              scheduleId: s.id,
              attempt,
              ok: result.ok,
              ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
              ...(result.error ? { error: result.error } : {}),
              durationMs: result.durationMs,
              status: result.ok ? 'ok' : retry ? 'pending' : 'failed',
              ...(nextAttemptAt ? { nextAttemptAt: nextAttemptAt.toISOString() } : {}),
            },
          },
          actor: SYSTEM_ACTOR,
          scope: scheduleScope(s),
        },
      ],
      { tx },
    );
  });
  return result;
}

/** Every delivery whose try is due (the scheduler's tick). */
export async function deliverDue(ctx: Ctx): Promise<number> {
  const due = await rows<{ id: string }>(
    ctx.pool,
    `SELECT id FROM schedule_runs WHERE status='pending' AND delivery IS NOT NULL AND next_attempt_at <= $1
      ORDER BY next_attempt_at, id LIMIT 20`,
    [ctx.clock.now()],
  );
  let n = 0;
  for (const r of due) {
    try {
      if (await attemptDelivery(ctx, r.id)) n++;
    } catch (err) {
      ctx.log.error({ err, runId: r.id }, 'schedule delivery failed');
    }
  }
  return n;
}

export const attemptsOf = (db: Parameters<typeof rows>[0], runIds: string[]) =>
  runIds.length
    ? rows(db, `SELECT * FROM schedule_attempts WHERE run_id = ANY($1::uuid[]) ORDER BY run_id, attempt`, [
        runIds,
      ])
    : Promise.resolve([] as Row[]);

export { iso };
