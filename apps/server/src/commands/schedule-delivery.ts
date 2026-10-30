import { createHmac } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  type DeliverySendPayload,
  DeliverySendResultSchema,
  isRetryableStatus,
  type ScheduleAction,
  type ScheduleDelivery,
  sheetRow,
  streamId,
  WEBHOOK_MAX_ATTEMPTS,
  webhookBackoffMs,
  whatsappText,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest } from '../errors.ts';
import { scheduledReportMail } from '../mail/templates.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { SYSTEM_ACTOR } from './common.ts';
import { scheduleScope, webhookSecret } from './schedule-actions.ts';
import { cardOutput, deliverOutputOf, sampleOutput } from './schedule-output.ts';

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

/** `X-Guildwise-Signature` (and the legacy `X-AOM-Signature`, sent until 27 Oct 2027): `sha256=` + hex HMAC of `<timestamp>.<body>` with the webhook's secret. */
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
    const secret = await webhookSecret(ctx, s.action as ScheduleAction, d.secret);
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
        // `x-aom-signature` is the legacy name of `x-guildwise-signature` (same value). Receivers have until
        // 27 Oct 2027 to switch; remove the legacy header on or after that date.
        ...(secret
          ? (() => {
              const signature = signWebhook(secret, timestamp, d.body);
              return { 'x-guildwise-signature': signature, 'x-aom-signature': signature };
            })()
          : {}),
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

async function sendMail(
  ctx: Ctx,
  d: Extract<ScheduleDelivery, { kind: 'email' }>,
  orgId: string | null,
): Promise<AttemptResult> {
  const started = Date.now();
  try {
    for (const to of d.to)
      await ctx.mailer.send({
        ...scheduledReportMail({ to, subject: d.subject, text: d.text, origin: ctx.config.publicOrigin }),
        ...(orgId ? { orgId } : {}),
      });
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

/** The runner has this long to answer a `delivery.send` before the try counts as failed (an offline workstation). */
export const RUNNER_DISPATCH_MS = 15 * 60_000;

/**
 * Records one try of a delivery (one `ScheduleDeliveryAttempted`) and schedules the next with a growing pause (1 min,
 * 5 min, 30 min, 2 h) up to five tries; `single` (a test) never retries. A try already answered elsewhere is ignored.
 */
export async function recordAttempt(
  ctx: Ctx,
  run: Row,
  s: Row,
  attempt: number,
  result: AttemptResult,
  opts: { single?: boolean } = {},
): Promise<void> {
  const now = ctx.clock.now();
  const retry = !result.ok && result.retryable && !opts.single && attempt < WEBHOOK_MAX_ATTEMPTS;
  const nextAttemptAt = retry ? new Date(now.getTime() + webhookBackoffMs(attempt)) : null;
  await withAppendTx(ctx.pool, async (tx) => {
    const cur = await one(tx, `SELECT attempts, status FROM schedule_runs WHERE id=$1 FOR UPDATE`, [run.id]);
    if (!cur || cur.status !== 'pending' || Number(cur.attempts) !== Number(run.attempts)) return; // answered elsewhere
    await ctx.store.append(
      [
        {
          streamId: streamId.schedule(s.id),
          event: {
            type: 'ScheduleDeliveryAttempted',
            payload: {
              runId: run.id,
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
}

/**
 * A WhatsApp or Sheets delivery: the runner sends it with the credential it keeps. Returns the result of an earlier
 * try that never got an answer (so it can be recorded), or null after handing a new try to the runner (the answer
 * comes through `recordAttempt` in the gateway). The text exists only in the command payload.
 */
async function dispatchToRunner(
  ctx: Ctx,
  run: Row,
  s: Row,
  d: Extract<ScheduleDelivery, { kind: 'runner' }>,
  attempt: number,
  single: boolean,
): Promise<AttemptResult | null> {
  const started = Date.now();
  const fail = (error: string, retryable: boolean): AttemptResult => ({
    ok: false,
    error,
    retryable,
    durationMs: Date.now() - started,
  });
  const now = ctx.clock.now();
  // 1. An earlier command that nobody answered by its deadline: close it, empty its text, count a failed try.
  const open = await one(
    ctx.pool,
    `SELECT id FROM runner_commands WHERE type='delivery.send'
        AND (status IN ('pending','sent') OR (status='failed' AND last_error='expired'))
        AND payload->>'runId' = $1 AND (payload->>'attempt')::int = $2 LIMIT 1`,
    [run.id, attempt],
  );
  const ws = await one(ctx.pool, `SELECT id, name, status, user_id FROM workstations WHERE id=$1`, [
    d.workstationId,
  ]);
  if (open) {
    await ctx.pool.query(
      `UPDATE runner_commands SET status='failed', payload='{}'::jsonb, last_error='no answer', done_at=$2 WHERE id=$1`,
      [open.id, now],
    );
    return fail(`the workstation ${ws?.name ?? ''} did not answer (offline?)`.replace('  ', ' '), true);
  }
  // 2. The workstation must still be active and belong to the schedule's owner.
  if (!ws || ws.status !== 'active' || (s.owner_user_id && ws.user_id !== s.owner_user_id))
    return fail('the workstation of this destination is not available: choose another one', false);
  const out = deliverOutputOf(s.action as ScheduleAction);
  const dest = out?.destinations[d.destination];
  if (!dest || (dest.kind !== 'whatsapp' && dest.kind !== 'google_sheet'))
    return fail('this destination no longer exists on the automation', false);
  const test = single || run.trigger === 'test';
  const o = test ? await sampleOutput(ctx, ctx.pool, s) : await cardOutput(ctx, ctx.pool, d.cardId);
  if (!o) return fail('the card is gone', false);
  const payload: DeliverySendPayload =
    dest.kind === 'whatsapp'
      ? {
          runId: run.id,
          attempt,
          test,
          channel: 'whatsapp',
          instance: dest.instance,
          whatsapp: {
            to: dest.to,
            ...(dest.template ? { template: dest.template } : {}),
            text: whatsappText(o),
          },
        }
      : {
          runId: run.id,
          attempt,
          test,
          channel: 'google_sheet',
          instance: dest.instance,
          sheet: {
            spreadsheetId: dest.spreadsheetId,
            sheet: dest.sheet,
            row: sheetRow(now.toISOString(), s.name, o),
          },
        };
  const deadline = new Date(now.getTime() + RUNNER_DISPATCH_MS);
  const commandId = await enqueueRunnerCommand(ctx.pool, d.workstationId, 'delivery.send', payload, deadline);
  // 3. Not due again before the deadline.
  await withAppendTx(ctx.pool, (tx) =>
    ctx.store.append(
      [
        {
          streamId: streamId.schedule(s.id),
          event: {
            type: 'ScheduleDeliveryDispatched',
            payload: {
              runId: run.id,
              scheduleId: s.id,
              attempt,
              commandId,
              deadline: deadline.toISOString(),
            },
          },
          actor: SYSTEM_ACTOR,
          scope: scheduleScope(s),
        },
      ],
      { tx },
    ),
  );
  await ctx.services.gateway.deliverPending(d.workstationId);
  return null;
}

/**
 * One try of a pending delivery. The HTTP call or the mail is made outside any transaction; the outcome is one
 * `ScheduleDeliveryAttempted` (see `recordAttempt`). A runner delivery is handed to the workstation and answers later.
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
  // A test is never retried, also when its deadline lapses and the scheduler picks it up.
  const single = Boolean(opts.single) || run.trigger === 'test';
  const result =
    delivery.kind === 'webhook'
      ? await postWebhook(ctx, s, runId, delivery)
      : delivery.kind === 'runner'
        ? await dispatchToRunner(ctx, run, s, delivery, attempt, single)
        : await sendMail(ctx, delivery, (s.org_id as string | null) ?? null);
  if (!result) return null;
  await recordAttempt(ctx, run, s, attempt, result, { single });
  return result;
}

/**
 * The workstation answered a `delivery.send`. The answer is one recorded try of the run (an answer for a run that is no
 * longer pending, or for another try, is ignored by `recordAttempt`). Nothing of the payload is logged.
 */
export async function applyDeliverySendResult(
  ctx: Ctx,
  payload: { runId?: string; attempt?: number; test?: boolean },
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  if (!payload.runId || !payload.attempt) return;
  const run = await one(ctx.pool, `SELECT * FROM schedule_runs WHERE id=$1 AND status='pending'`, [payload.runId]);
  if (!run || Number(run.attempts) + 1 !== payload.attempt) return;
  const s = await one(ctx.pool, 'SELECT * FROM schedules WHERE id=$1', [run.schedule_id]);
  if (!s) return;
  const parsed = DeliverySendResultSchema.safeParse(result);
  const outcome: AttemptResult = !ok
    ? { ok: false, error: (error ?? 'the workstation could not send').slice(0, 500), retryable: true, durationMs: 0 }
    : !parsed.success
      ? { ok: false, error: 'the workstation answered something unexpected', retryable: true, durationMs: 0 }
      : {
          ok: parsed.data.ok,
          retryable: parsed.data.retryable,
          ...(parsed.data.httpStatus ? { httpStatus: parsed.data.httpStatus } : {}),
          ...(parsed.data.error ? { error: parsed.data.error.slice(0, 500) } : {}),
          durationMs: 0,
        };
  await recordAttempt(ctx, run, s, payload.attempt, outcome, { single: Boolean(payload.test) });
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
