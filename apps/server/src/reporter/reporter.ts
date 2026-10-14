import { randomUUID } from 'node:crypto';
import { type FloorDigest, floorDigestIsEmpty, floorReportDue, streamId } from '@aom/shared';
import { queueCeoReviews } from '../ceo/pass.ts';
import { orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { releaseHeldEvents } from '../commands/reporter-tasks.ts';
import type { Ctx } from '../context.ts';
import { one, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { type Detected, detectAll } from './detectors.ts';
import { buildFloorDigest } from './digest.ts';
import { systemBy } from './report-items.ts';
import { reportingOf } from './settings.ts';
import { enqueueReporterTask } from './tasks.ts';

export interface ReporterRun {
  released: number;
  raised: number;
  resolved: number;
  alerts: number;
  floorReports: number;
}

/**
 * The server-side half of the BA reporter (docs/design/phases.md B4): every `AOM_REPORTER_SECONDS` (60) it
 *
 * 1. releases held desk items the BA did not triage within the window (the manager sees them unchanged),
 * 2. runs the deterministic detectors and keeps one `ba_signals` row per fingerprint (raised, updated, resolved),
 * 3. queues a `floor_alert` BA task for each urgent signal nobody has been told about, and
 * 4. queues the `floor_report` task once the manager's local clock passes `dailyAt` (08:00 by default).
 *
 * Nothing here spends tokens and no agent polls; the BA only works when a task is queued for it. A task no BA takes
 * is done by the server from a template (`runReporterFallback`).
 */
export class Reporter {
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    this.timer = setInterval(() => void this.run().catch(() => {}), this.ctx.config.reporterSeconds * 1000);
    this.timer.unref();
  }

  /** One sweep, serialized in-process. Tests call it after moving the test clock. */
  run(): Promise<ReporterRun> {
    if (this.stopped)
      return Promise.resolve({ released: 0, raised: 0, resolved: 0, alerts: 0, floorReports: 0 });
    const next = this.chain.then(() => sweep(this.ctx));
    this.chain = next.catch((err) => this.ctx.log.error({ err }, 'reporter sweep failed'));
    return next;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.chain.catch(() => {});
  }
}

export async function sweep(ctx: Ctx): Promise<ReporterRun> {
  const now = ctx.clock.now();
  const out: ReporterRun = { released: 0, raised: 0, resolved: 0, alerts: 0, floorReports: 0 };
  out.released = await releaseExpired(ctx, now);
  const sig = await reconcileSignals(ctx, now);
  out.raised = sig.raised;
  out.resolved = sig.resolved;
  out.alerts = await queueUrgentAlerts(ctx);
  out.floorReports = await queueFloorReports(ctx, now);
  if (out.released + out.alerts + out.floorReports > 0) ctx.services.dispatcher.trigger();
  return out;
}

/** Step 1: a hold the BA did not resolve in time ends here, unchanged. */
async function releaseExpired(ctx: Ctx, now: Date): Promise<number> {
  const due = await rows<{ id: string }>(
    ctx.pool,
    `SELECT id FROM desk_items WHERE triage='pending' AND status='open' AND triage_deadline <= $1`,
    [now],
  );
  if (due.length === 0) return 0;
  return withAppendTx(ctx.pool, async (tx) => {
    const events = await releaseHeldEvents(
      tx,
      due.map((d) => d.id),
      'the BA had not looked at this within the time limit',
    );
    await ctx.store.append(events, { tx });
    return events.length;
  });
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Step 2. */
async function reconcileSignals(ctx: Ctx, now: Date): Promise<{ raised: number; resolved: number }> {
  let detected: Detected[];
  try {
    detected = await detectAll(ctx, now);
  } catch (err) {
    ctx.log.error({ err }, 'reporter detectors failed');
    return { raised: 0, resolved: 0 };
  }
  return withAppendTx(ctx.pool, async (tx) => {
    const existing = await rows(tx, `SELECT * FROM ba_signals WHERE status <> 'resolved' FOR UPDATE`);
    const byKey = new Map<string, Row>(existing.map((s) => [`${s.org_id}|${s.fingerprint}`, s]));
    const seen = new Set<string>();
    const events: AppendInput[] = [];
    let raised = 0;
    for (const d of detected) {
      const key = `${d.orgId}|${d.fingerprint}`;
      seen.add(key);
      const ex = byKey.get(key);
      const scope = d.projectId ? projectScope(d.orgId, d.projectId) : orgScope(d.orgId);
      if (!ex) {
        const signalId = randomUUID();
        raised++;
        events.push({
          streamId: streamId.baSignal(signalId),
          event: {
            type: 'BaSignalRaised',
            payload: {
              signalId,
              ...(d.projectId ? { projectId: d.projectId } : {}),
              kind: d.kind,
              fingerprint: d.fingerprint,
              urgency: d.urgency,
              subject: d.subject,
              evidence: d.evidence,
              count: Math.max(1, d.count),
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        });
      } else if (
        ex.count !== Math.max(1, d.count) ||
        ex.urgency !== d.urgency ||
        !sameJson(ex.subject, d.subject)
      ) {
        events.push({
          streamId: streamId.baSignal(ex.id),
          event: {
            type: 'BaSignalUpdated',
            payload: {
              signalId: ex.id,
              count: Math.max(1, d.count),
              urgency: d.urgency,
              subject: d.subject,
              evidence: d.evidence,
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        });
      }
    }
    let resolved = 0;
    for (const [key, ex] of byKey) {
      if (seen.has(key)) continue;
      resolved++;
      const scope = ex.project_id ? projectScope(ex.org_id, ex.project_id) : orgScope(ex.org_id);
      events.push({
        streamId: streamId.baSignal(ex.id),
        event: { type: 'BaSignalResolved', payload: { signalId: ex.id, note: 'cleared' } },
        actor: SYSTEM_ACTOR,
        scope,
      });
      // The report item of a signal that cleared is acknowledged for the manager, like the tester bottleneck.
      if (ex.report_desk_item_id) {
        const item = await one(
          tx,
          `SELECT id, org_id, project_id FROM desk_items WHERE id=$1 AND status='open' AND subkind='ba_report'`,
          [ex.report_desk_item_id],
        );
        if (item)
          events.push({
            streamId: streamId.desk(item.id),
            event: {
              type: 'DeskItemResolved',
              payload: { deskItemId: item.id, resolution: 'acknowledged', note: 'cleared', by: systemBy },
            },
            actor: SYSTEM_ACTOR,
            scope: item.project_id ? projectScope(item.org_id, item.project_id) : orgScope(item.org_id),
          });
      }
    }
    await ctx.store.append(events, { tx });
    return { raised, resolved };
  });
}

/** Step 3: urgent signals nobody was told about yet become a `floor_alert` task (one per org and project). */
async function queueUrgentAlerts(ctx: Ctx): Promise<number> {
  const pending = await rows(
    ctx.pool,
    `SELECT s.* FROM ba_signals s
      WHERE s.urgency='urgent' AND s.status='open'
        AND NOT EXISTS (SELECT 1 FROM ceo_settings c WHERE c.org_id = s.org_id AND c.enabled AND NOT c.paused AND c.agent_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM ba_tasks t WHERE t.kind='floor_alert' AND s.id = ANY(t.signal_ids))
      ORDER BY s.first_seen_at, s.id`,
  );
  if (pending.length === 0) return 0;
  return withAppendTx(ctx.pool, async (tx) => {
    const groups = new Map<string, { orgId: string; projectId: string | null; ids: string[] }>();
    for (const s of pending) {
      const key = `${s.org_id}|${s.project_id ?? ''}`;
      const g: { orgId: string; projectId: string | null; ids: string[] } = groups.get(key) ?? {
        orgId: s.org_id,
        projectId: s.project_id,
        ids: [],
      };
      g.ids.push(s.id);
      groups.set(key, g);
    }
    let n = 0;
    for (const g of groups.values()) {
      const events = await enqueueReporterTask(tx, {
        orgId: g.orgId,
        projectId: g.projectId,
        kind: 'floor_alert',
        signalIds: g.ids,
      });
      await ctx.store.append(events, { tx });
      n += events.length ? 1 : 0;
    }
    return n;
  });
}

/** Step 4: the daily floor report, at `dailyAt` on the manager's clock; skipped on days with nothing to say. */
async function queueFloorReports(ctx: Ctx, now: Date): Promise<number> {
  const orgs = await rows<{ id: string }>(
    ctx.pool,
    `SELECT o.id FROM organizations o JOIN users u ON u.id = o.owner_user_id AND u.status='active'
      WHERE o.status IN ('trial','active')
        AND NOT EXISTS (SELECT 1 FROM ceo_settings c WHERE c.org_id = o.id AND c.enabled AND NOT c.paused AND c.agent_id IS NOT NULL)
        AND EXISTS (SELECT 1 FROM projects p WHERE p.org_id = o.id AND p.status='active' AND p.kind='project')`,
  );
  let n = await queueCeoReviews(ctx, now);
  for (const o of orgs) {
    const prefs = await reportingOf(ctx.pool, o.id);
    const due = floorReportDue(now, prefs.timezone, prefs.dailyAt, prefs.floorReportDay, prefs.createdAt);
    if (!due.due) continue;
    const digest: FloorDigest = await buildFloorDigest(ctx.pool, o.id, now, due.localDate);
    if (floorDigestIsEmpty(digest)) continue;
    const queued = await withAppendTx(ctx.pool, async (tx) => {
      const again = await reportingOf(tx, o.id);
      if (again.floorReportDay === due.localDate) return false;
      const events = await enqueueReporterTask(tx, {
        orgId: o.id,
        projectId: null,
        kind: 'floor_report',
        signalIds: digest.signals.filter((s) => s.status === 'open').map((s) => s.id),
        localDate: due.localDate,
      });
      await ctx.store.append(events, { tx });
      return events.length > 0;
    });
    if (queued) n++;
  }
  return n;
}
