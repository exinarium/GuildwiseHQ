import { durationMs, type JourneyDuration } from '@aom/shared';
import type { Who } from '../auth/org-context.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Queryable, type Row, rows } from '../db/sql.ts';
import { badRequest, forbidden, notFound } from '../errors.ts';
import { cancelFromWait, continueWait, extendWait, gotoFromWait, resendLink } from '../journeys/waits.ts';
import { clientLinkUrl } from './public-forms.ts';

async function loadWait(db: Queryable, id: string): Promise<Row> {
  const w = await one(db, 'SELECT * FROM journey_waits WHERE id=$1', [id]);
  if (!w) throw notFound('wait not found');
  return w;
}

/** The project owner, the organization's Owner and Admins (my_role 'owner'), and the one the escalation was addressed to. */
async function mayManage(ctx: Ctx, who: Who, w: Row): Promise<void> {
  const project = await loadVisibleProject(ctx.pool, who.userId, w.project_id);
  if (project.my_role === 'owner') return;
  if (w.desk_item_id) {
    const d = await one(ctx.pool, 'SELECT addressee_user_id FROM desk_items WHERE id=$1', [w.desk_item_id]);
    if (d?.addressee_user_id === who.userId) return;
  }
  throw forbidden('only the project owner, an Owner or Admin, or the person asked can do this');
}

export interface WaitDto {
  id: string;
  visit: number;
  stepId: string;
  kind: string;
  status: string;
  startedAt: string | null;
  deadlineAt: string | null;
  nextFireAt: string | null;
  remindersSent: number;
  remindersMax: number | null;
  linkUrl: string | null;
  linkExpiresAt: string | null;
  fellBack: boolean;
  resolution: string | null;
  resolvedAt: string | null;
  events: Array<{ at: string; type: string; text: string }>;
}

export interface CallDto {
  id: string;
  visit: number;
  stepId: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  finishedAt: string | null;
}

/** The waits and calls of an instance with their deadlines and history. The link URL is signed on read, never stored. */
export async function listInstanceWaits(ctx: Ctx, who: Who, instanceId: string): Promise<{ waits: WaitDto[]; calls: CallDto[] }> {
  const inst = await one(ctx.pool, 'SELECT * FROM journey_instances WHERE id=$1', [instanceId]);
  if (!inst) throw notFound('instance not found');
  await loadVisibleProject(ctx.pool, who.userId, inst.project_id);
  const ws = await rows(ctx.pool, 'SELECT * FROM journey_waits WHERE instance_id=$1 ORDER BY visit', [instanceId]);
  const waits: WaitDto[] = [];
  for (const w of ws) {
    const cfg = w.config as { waitFor?: { formId?: string }; onTimeout?: { action?: string; maxReminders?: number } };
    const open = w.status === 'open' || w.status === 'escalated';
    waits.push({
      id: w.id,
      visit: w.visit,
      stepId: w.step_id,
      kind: w.kind,
      status: w.status,
      startedAt: iso(w.started_at),
      deadlineAt: iso(w.deadline_at),
      nextFireAt: iso(w.next_fire_at),
      remindersSent: w.reminders_sent,
      remindersMax: cfg.onTimeout?.action === 'remind' ? (cfg.onTimeout.maxReminders ?? 3) : null,
      linkUrl: open && w.link_id && cfg.waitFor?.formId ? await clientLinkUrl(ctx, inst.org_id, cfg.waitFor.formId, w.link_id) : null,
      linkExpiresAt: iso(w.link_expires_at),
      fellBack: w.fell_back,
      resolution: w.resolution,
      resolvedAt: iso(w.resolved_at),
      events: w.events,
    });
  }
  const cs = await rows(ctx.pool, 'SELECT * FROM journey_webhook_calls WHERE instance_id=$1 ORDER BY visit', [instanceId]);
  return {
    waits,
    calls: cs.map((c) => ({
      id: c.id,
      visit: c.visit,
      stepId: c.step_id,
      status: c.status,
      attempts: c.attempts,
      nextAttemptAt: iso(c.next_attempt_at),
      lastHttpStatus: c.last_http_status,
      lastError: c.last_error,
      finishedAt: iso(c.finished_at),
    })),
  };
}

export async function extendWaitCmd(ctx: Ctx, who: Who, waitId: string, duration: JourneyDuration): Promise<void> {
  const w = await loadWait(ctx.pool, waitId);
  await mayManage(ctx, who, w);
  if (!(await extendWait(ctx, waitId, who.userId, durationMs(duration)))) throw badRequest('wait_not_open', 'This wait cannot be extended.');
}
export async function continueWaitCmd(ctx: Ctx, who: Who, waitId: string): Promise<void> {
  const w = await loadWait(ctx.pool, waitId);
  await mayManage(ctx, who, w);
  if (!(await continueWait(ctx, waitId, who.userId))) throw badRequest('wait_not_open', 'This wait already ended.');
}
export async function gotoWaitCmd(ctx: Ctx, who: Who, waitId: string, stepId: string): Promise<void> {
  const w = await loadWait(ctx.pool, waitId);
  await mayManage(ctx, who, w);
  if (!(await gotoFromWait(ctx, waitId, who.userId, stepId))) throw badRequest('wait_not_open', 'This wait cannot go to that step.');
}
export async function cancelWaitCmd(ctx: Ctx, who: Who, waitId: string): Promise<void> {
  const w = await loadWait(ctx.pool, waitId);
  await mayManage(ctx, who, w);
  if (!(await cancelFromWait(ctx, waitId, who.userId))) throw badRequest('wait_not_open', 'This wait already ended.');
}
export async function resendLinkCmd(ctx: Ctx, who: Who, waitId: string): Promise<void> {
  const w = await loadWait(ctx.pool, waitId);
  await mayManage(ctx, who, w);
  if (!(await resendLink(ctx, waitId))) throw badRequest('wait_not_open', 'This wait has no link to send again.');
}
