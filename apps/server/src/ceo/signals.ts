import { randomUUID } from 'node:crypto';
import { countRepeats, type DeskActor, streamId, suggestForRepeat } from '@aom/shared';
import { orgScope, projectScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { actorOf, systemBy } from '../commands/phase-events.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { AppendInput } from '../eventstore/types.ts';
import { type Detected, detectAll } from './detectors.ts';
import { queueCeoReviews } from './pass.ts';
import { sameJson } from './same-json.ts';
import { sweepTopics } from './topics-handoff.ts';

/**
 * Repeat detection for the off-system job log (docs/design/ceo-front-door.md section 4.3, with the owner's thresholds of
 * section 14.5): the same kind of job 4 or more times in 7 days, or 10 or more times in 30 days. Deterministic: no model
 * clusters anything. A dismissed repeat hides its key for 90 days; an accepted one only counts jobs logged after it.
 */
export async function repeatEvents(
  db: Queryable,
  orgId: string,
  kind: string,
  now: Date,
): Promise<AppendInput[]> {
  if (kind === 'unlabelled') return [];
  const open = await one(db, `SELECT 1 FROM ceo_repeats WHERE org_id=$1 AND key=$2 AND status='open'`, [
    orgId,
    kind,
  ]);
  if (open) return [];
  const last = await one(
    db,
    `SELECT decision, resolved_at, suppressed_until FROM ceo_repeats
      WHERE org_id=$1 AND key=$2 AND status='resolved' ORDER BY resolved_at DESC LIMIT 1`,
    [orgId, kind],
  );
  if (last?.decision === 'dismissed' && last.suppressed_until && new Date(last.suppressed_until) > now)
    return [];
  const baseline = last && last.decision !== 'dismissed' ? new Date(last.resolved_at) : null;
  const jobs = await rows(
    db,
    `SELECT id, created_at, project_id, first_token FROM ceo_offboard_jobs
      WHERE org_id=$1 AND kind=$2 AND created_at > $3 AND ($4::timestamptz IS NULL OR created_at > $4)
      ORDER BY created_at`,
    [orgId, kind, new Date(now.getTime() - 30 * 86_400_000), baseline],
  );
  const counted = countRepeats(
    jobs.map((j) => new Date(j.created_at)),
    now,
  );
  if (!counted.hit) return [];
  const projectId = jobs.find((j) => j.project_id)?.project_id as string | undefined;
  return [
    {
      streamId: streamId.ceo(orgId),
      event: {
        type: 'CeoRepeatDetected',
        payload: {
          repeatId: randomUUID(),
          orgId,
          key: kind,
          jobIds: jobs.slice(-100).map((j) => j.id),
          suggestion: suggestForRepeat({
            hasProject: !!projectId,
            firstTokens: jobs.map((j) => String(j.first_token ?? '')),
          }),
          count7: counted.count7,
          count30: counted.count30,
          ...(projectId ? { projectId } : {}),
        },
      },
      actor: SYSTEM_ACTOR,
      scope: orgScope(orgId),
    },
  ];
}

/** Re-checks every kind that has recent jobs (the daily report runs it, so a repeat is never missed). */
export async function detectRepeats(db: Queryable, orgId: string, now: Date): Promise<AppendInput[]> {
  const kinds = await rows(
    db,
    `SELECT DISTINCT kind FROM ceo_offboard_jobs WHERE org_id=$1 AND created_at > $2 AND kind <> 'unlabelled'`,
    [orgId, new Date(now.getTime() - 30 * 86_400_000)],
  );
  const out: AppendInput[] = [];
  for (const k of kinds) out.push(...(await repeatEvents(db, orgId, k.kind, now)));
  return out;
}

// ------------------------------------------------------------------------------------------------ the sweep

export interface SignalSweepRun {
  released: number;
  raised: number;
  resolved: number;
  reviews: number;
}

/**
 * The server-side sweep (it was the BA reporter's; docs/design/ceo-front-door.md step 3). Every `AOM_REPORTER_SECONDS`
 * (60) it
 *
 * 1. releases held desk items the CEO did not triage within the window (the owner sees them unchanged),
 * 2. runs the deterministic detectors and keeps one `ba_signals` row per fingerprint (raised, updated, resolved); a
 *    raised urgent signal wakes the CEO through the wake sources (`ceo/wakes.ts`), nothing is queued for a BA,
 * 3. queues the CEO's daily review wake once the owner's local clock passes the report time, and
 * 4. runs the research-topics sweep (problem notes, expiry, the one-way hand-off to the blog queue).
 *
 * Nothing here spends tokens and no agent polls. When the CEO cannot run, the deterministic fallbacks stay: held items
 * are released at the deadline, an urgent wake that waits too long becomes an owner notice and e-mail
 * (`offlineNotice`), and a review nobody wrote is posted from a template (`postFallbackReview`).
 */
export class SignalSweep {
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly ctx: Ctx) {}

  start(): void {
    this.timer = setInterval(() => void this.run().catch(() => {}), this.ctx.config.reporterSeconds * 1000);
    this.timer.unref();
  }

  /** One sweep, serialized in-process. Tests call it after moving the test clock. */
  run(): Promise<SignalSweepRun> {
    if (this.stopped) return Promise.resolve({ released: 0, raised: 0, resolved: 0, reviews: 0 });
    const next = this.chain.then(() => sweep(this.ctx));
    this.chain = next.catch((err) => this.ctx.log.error({ err }, 'signal sweep failed'));
    return next;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.chain.catch(() => {});
  }
}

export async function sweep(ctx: Ctx): Promise<SignalSweepRun> {
  const now = ctx.clock.now();
  const released = await releaseExpired(ctx, now);
  const sig = await reconcileSignals(ctx, now);
  const reviews = await queueCeoReviews(ctx, now);
  // Research topics (problem notes, expiry, the one-way hand-off to the blog queue): never blocks the sweep.
  await sweepTopics(ctx, now).catch((err) => ctx.log.error({ err }, 'ceo topics sweep failed'));
  if (reviews > 0) ctx.services.dispatcher.trigger();
  return { released, raised: sig.raised, resolved: sig.resolved, reviews };
}

const itemScope = (item: Row) =>
  item.project_id ? projectScope(item.org_id, item.project_id) : orgScope(item.org_id);

/** `DeskItemTriaged released` for every listed item that is still held: the owner sees it unchanged. */
export async function releaseHeldEvents(
  db: Queryable,
  ids: string[],
  note: string,
  by: DeskActor = systemBy,
): Promise<AppendInput[]> {
  if (ids.length === 0) return [];
  const held = await rows(
    db,
    `SELECT * FROM desk_items WHERE id = ANY($1::uuid[]) AND triage='pending' AND status='open'`,
    [ids],
  );
  return held.map((item) => ({
    streamId: streamId.desk(item.id),
    event: { type: 'DeskItemTriaged', payload: { deskItemId: item.id, outcome: 'released', note, by } },
    actor: actorOf(by),
    scope: itemScope(item),
  }));
}

/** Step 1: a hold the CEO did not resolve in time ends here, unchanged. */
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
      'the CEO had not looked at this within the time limit',
    );
    await ctx.store.append(events, { tx });
    return events.length;
  });
}

/** Step 2. */
async function reconcileSignals(ctx: Ctx, now: Date): Promise<{ raised: number; resolved: number }> {
  let detected: Detected[];
  try {
    detected = await detectAll(ctx, now);
  } catch (err) {
    ctx.log.error({ err }, 'signal detectors failed');
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
