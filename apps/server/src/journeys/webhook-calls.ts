import { randomUUID } from 'node:crypto';
import {
  CALL_MAX_ATTEMPTS,
  callBackoffMs,
  type BodyToken,
  DeliverySendResultSchema,
  isRetryableHttpStatus,
  type JourneyDefinition,
  type JourneyWebhookCallPayload,
  type JourneyWebhookCallStep,
  renderBodyTemplate,
} from '@aom/shared';
import { advanceIn, ev, loadDefinition, lockInstance } from '../commands/journey-runtime.ts';
import { clientLinkUrl } from '../commands/public-forms.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';

/** The runner has this long to answer one try; an offline workstation counts as a failed, retryable try. */
export const CALL_DISPATCH_MS = 2 * 60_000;

/** Executor for a `webhook_call` step: a call row that the tick sends. */
export async function enterWebhookCallStep(
  _ctx: Ctx,
  _tx: Tx,
  inst: Row,
  def: JourneyDefinition,
  run: Row,
): Promise<AppendInput[]> {
  const step = def.steps.find((s) => s.id === run.step_id) as JourneyWebhookCallStep;
  return [
    ev(inst, {
      type: 'JourneyWebhookCallStarted',
      payload: {
        callId: randomUUID(),
        instanceId: inst.id,
        visit: run.visit,
        stepId: run.step_id,
        workstationId: step.workstationId as string,
      },
    }),
  ];
}

type Result = { ok: boolean; httpStatus?: number; error?: string; durationMs: number; retryable: boolean };

/** Sends every call that is due, and closes tries nobody answered. Returns how many tries it started or closed. */
export async function callDue(ctx: Ctx, projectId: string | null = null): Promise<number> {
  const now = ctx.clock.now();
  const due = await rows(
    ctx.pool,
    `SELECT id, workstation_id FROM journey_webhook_calls
      WHERE ((status='pending' AND next_attempt_at <= $1) OR (status='dispatched' AND command_deadline <= $1))
        AND ($2::uuid IS NULL OR project_id = $2)
      ORDER BY COALESCE(next_attempt_at, command_deadline), id LIMIT 50`,
    [now, projectId],
  );
  let n = 0;
  const workstations = new Set<string>();
  for (const d of due) {
    try {
      if (await tryOnce(ctx, d.id)) {
        n++;
        workstations.add(d.workstation_id);
      }
    } catch (err) {
      ctx.log.error({ err, callId: d.id }, 'journey webhook call failed');
    }
  }
  for (const w of workstations) await ctx.services.gateway.deliverPending(w).catch(() => undefined);
  return n;
}

async function varsFor(ctx: Ctx, tx: Tx, inst: Row, def: JourneyDefinition, step: JourneyWebhookCallStep) {
  const record = (await one(tx, 'SELECT * FROM journey_records WHERE id=$1', [inst.record_id])) as Row;
  const vars: Partial<Record<BodyToken, string>> = {
    'record.name': record.display_name,
    'record.type': record.record_type,
    'record.externalId': record.external_id ?? '',
    'journey.name': def.name,
    'instance.id': inst.id,
    'step.id': step.id,
    'step.label': step.label,
    now: ctx.clock.now().toISOString(),
  };
  const w = await one(
    tx,
    `SELECT * FROM journey_waits WHERE instance_id=$1 AND kind='form' ORDER BY visit DESC LIMIT 1`,
    [inst.id],
  );
  if (w?.submission_id) vars['submission.id'] = String(w.submission_id);
  const formId = (w?.config as { waitFor?: { formId?: string; send?: { via?: string } } } | undefined)?.waitFor;
  if (w?.link_id && formId?.formId && formId.send?.via === 'webhook') {
    const url = await clientLinkUrl(ctx, inst.org_id, formId.formId, w.link_id);
    if (url) vars['wait.link'] = url;
  }
  return vars;
}

async function tryOnce(ctx: Ctx, callId: string): Promise<boolean> {
  return withAppendTx(ctx.pool, async (tx) => {
    const now = ctx.clock.now();
    const call = await one(
      tx,
      `SELECT * FROM journey_webhook_calls WHERE id=$1
          AND ((status='pending' AND next_attempt_at <= $2) OR (status='dispatched' AND command_deadline <= $2)) FOR UPDATE SKIP LOCKED`,
      [callId, now],
    );
    if (!call) return false;
    const inst = await lockInstance(tx, call.instance_id, call.visit, 'waiting');
    if (!inst) return false;
    const def = await loadDefinition(tx, inst.journey_id, inst.journey_version);
    const step = def.steps.find((s) => s.id === call.step_id) as JourneyWebhookCallStep | undefined;
    if (call.status === 'dispatched') {
      // The try was never answered: close the command, empty its body, count a failed retryable try.
      if (call.command_id)
        await tx.query(`UPDATE runner_commands SET status='failed', payload='{}'::jsonb, last_error='no answer', done_at=$2 WHERE id=$1`, [
          call.command_id,
          now,
        ]);
      await recordAttempt(ctx, tx, inst, def, call, call.attempts, {
        ok: false,
        error: 'the workstation did not answer (offline?)',
        durationMs: 0,
        retryable: true,
      });
      return true;
    }
    const attempt = Number(call.attempts) + 1;
    const ws = await one(tx, `SELECT id, status FROM workstations WHERE id=$1`, [call.workstation_id]);
    if (!step || !ws || ws.status !== 'active') {
      await recordAttempt(ctx, tx, inst, def, call, attempt, {
        ok: false,
        error: 'the workstation of this step is not available: choose another one',
        durationMs: 0,
        retryable: false,
      });
      return true;
    }
    let body: string;
    try {
      body = renderBodyTemplate(step.body, await varsFor(ctx, tx, inst, def, step), step.contentType);
    } catch (err) {
      await recordAttempt(ctx, tx, inst, def, call, attempt, {
        ok: false,
        error: (err as Error).message.slice(0, 200),
        durationMs: 0,
        retryable: false,
      });
      return true;
    }
    const payload: JourneyWebhookCallPayload = {
      callId: call.id,
      attempt,
      url: step.url,
      method: step.method,
      headers: step.headers,
      credentialHeaders: step.credentialHeaders,
      ...(step.signWith ? { signWith: step.signWith } : {}),
      contentType: step.contentType,
      body,
    };
    const deadline = new Date(now.getTime() + CALL_DISPATCH_MS);
    const commandId = await enqueueRunnerCommand(ctx.pool, call.workstation_id, 'journey.webhook.call', payload, deadline);
    await ctx.store.append(
      [ev(inst, { type: 'JourneyWebhookCallDispatched', payload: { callId, attempt, commandId, deadline: deadline.toISOString() } })],
      { tx },
    );
    return true;
  });
}

/** One recorded try: retry with backoff, or the final result and the move along `done` / `failed`. */
async function recordAttempt(
  ctx: Ctx,
  tx: Tx,
  inst: Row,
  def: JourneyDefinition,
  call: Row,
  attempt: number,
  r: Result,
): Promise<void> {
  const backoff = r.retryable && !r.ok ? callBackoffMs(attempt) : null;
  const nextAttemptAt = backoff !== null ? new Date(ctx.clock.now().getTime() + backoff) : null;
  const events: AppendInput[] = [
    ev(inst, {
      type: 'JourneyWebhookCallAttempted',
      payload: {
        callId: call.id,
        attempt,
        ok: r.ok,
        ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}),
        ...(r.error ? { error: r.error.slice(0, 500) } : {}),
        durationMs: r.durationMs,
        ...(nextAttemptAt ? { nextAttemptAt: nextAttemptAt.toISOString() } : {}),
      },
    }),
  ];
  if (nextAttemptAt && attempt < CALL_MAX_ATTEMPTS) {
    await ctx.store.append(events, { tx });
    return;
  }
  events.push(
    ev(inst, {
      type: 'JourneyWebhookCallFinished',
      payload: { callId: call.id, ok: r.ok, attempts: attempt, ...(r.httpStatus ? { httpStatus: r.httpStatus } : {}) },
    }),
  );
  await ctx.store.append(events, { tx });
  const run = await one(tx, 'SELECT * FROM journey_step_runs WHERE instance_id=$1 AND visit=$2', [inst.id, call.visit]);
  if (!run || run.status !== 'waiting') return;
  if (r.ok) await advanceIn(ctx, tx, inst, def, run, 'done', null);
  else await advanceIn(ctx, tx, inst, def, run, 'cancelled', null, 'failed');
}

/** The workstation answered a `journey.webhook.call` (called by the gateway). */
export async function applyJourneyWebhookResult(
  ctx: Ctx,
  payload: { callId?: string; attempt?: number },
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  if (!payload.callId || !payload.attempt) return;
  await withAppendTx(ctx.pool, async (tx) => {
    const call = await one(tx, `SELECT * FROM journey_webhook_calls WHERE id=$1 AND status='dispatched' FOR UPDATE`, [payload.callId]);
    if (!call || Number(call.attempts) !== payload.attempt) return;
    const inst = await lockInstance(tx, call.instance_id, call.visit, 'waiting');
    if (!inst) return;
    const def = await loadDefinition(tx, inst.journey_id, inst.journey_version);
    const parsed = DeliverySendResultSchema.safeParse(result);
    const out: Result = !ok
      ? { ok: false, error: (error ?? 'the workstation could not send').slice(0, 500), retryable: true, durationMs: 0 }
      : !parsed.success
        ? { ok: false, error: 'the workstation answered something unexpected', retryable: true, durationMs: 0 }
        : {
            ok: parsed.data.ok,
            ...(parsed.data.httpStatus ? { httpStatus: parsed.data.httpStatus } : {}),
            ...(parsed.data.error ? { error: parsed.data.error } : {}),
            durationMs: 0,
            retryable: parsed.data.retryable || (parsed.data.httpStatus ? isRetryableHttpStatus(parsed.data.httpStatus) : false),
          };
    await recordAttempt(ctx, tx, inst, def, call, payload.attempt as number, out);
  });
}
