import { randomUUID } from 'node:crypto';
import {
  CEO_OUTCOME,
  type CeoShift,
  floorDigestIsEmpty,
  floorReportDue,
  isHandoverReason,
  type ServerToRunnerOf,
  type ShiftBrief,
  streamId,
} from '@aom/shared';
import { loadRole } from '../catalogue/loader.ts';
import { orgScope, runnerActor, SYSTEM_ACTOR } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { buildFloorDigest } from '../reporter/digest.ts';
import { reportingOf } from '../reporter/settings.ts';
import { carrierProject } from '../reporter/tasks.ts';
import { agentSpecFor, shiftVault } from '../runner-gateway/brief.ts';
import { buildCeoBrief } from './brief.ts';
import { ceoGate } from './gate.ts';
import { notifyOwner } from './notify.ts';
import { checkOrgBudget } from './orgbudget.ts';
import { postFallbackReview } from './report.ts';
import { ceoFailures, FAILURE_NOTICE_AT, releaseBatch, releaseStuckBatches } from './shift.ts';
import { type CeoState, ceoReachable, loadCeo } from './state.ts';
import { enqueueWake } from './wakes.ts';

type ShiftStartPayload = Omit<ServerToRunnerOf<'shift.start'>, 'v' | 'id' | 'type' | 'ts'>;

export const CEO_WAKE_MAX_MINUTES = 15;
export const CEO_REVIEW_MAX_MINUTES = 30;
const OFFLINE_NOTICE_MS = 30 * 60_000;
const FALLBACK_REVIEW_MS = 2 * 3600_000;
const MISSED_DROP_MS = 24 * 3600_000;
const OVERRUN_SLACK_MS = 10 * 60_000;
const MAX_ATTEMPTS = 2;

/** Model and effort for a purpose: the owner's settings (wake, review, chat) override the role default. */
export function modelFor(
  ceo: CeoState,
  purpose: 'wake' | 'review' | 'chat' | 'handover',
): { model: string; effort: string } {
  return ceo.settings.models[purpose];
}

/** The outcomes a CEO shift may report. */
export const ceoOutcomes = (purpose: 'wake' | 'review'): BriefOutcome[] =>
  purpose === 'review'
    ? [{ id: CEO_OUTCOME.report, label: 'The daily report', kind: 'success', data: 'ceoReport' }]
    : [{ id: CEO_OUTCOME.done, label: 'The wake is handled', kind: 'success', data: 'ceoDone' }];

type BriefOutcome = ShiftBrief['shift']['outcomes'][number];

/** The `shift.start` of a CEO batch: no worktree, the brief carries a placeholder card (like a BA task). */
async function buildCeoShiftStart(
  ctx: Ctx,
  ceo: CeoState,
  agent: Row,
  batchId: string,
  shiftId: string,
  wakes: Row[],
  purpose: 'wake' | 'review',
  localDate?: string,
): Promise<ShiftStartPayload | null> {
  const role = await loadRole(ctx.pool, agent.org_id, agent.role_key, agent.role_version);
  if (!role) return null;
  const projectId = await carrierProject(ctx.pool, agent.org_id, null);
  const project = projectId
    ? await one(ctx.pool, 'SELECT * FROM projects WHERE id=$1', [projectId])
    : undefined;
  const { text, reasons } = await buildCeoBrief(ctx, ceo, agent, wakes, purpose, localDate);
  const maxMinutes = purpose === 'review' ? CEO_REVIEW_MAX_MINUTES : CEO_WAKE_MAX_MINUTES;
  const handover = purpose === 'wake' && wakes.some((w) => isHandoverReason(String(w.reason)));
  const m = modelFor(ceo, purpose === 'review' ? 'review' : handover ? 'handover' : 'wake');
  const spec = await agentSpecFor(ctx, agent);
  const ceoShift: CeoShift = {
    purpose,
    batchId,
    wakeIds: wakes.map((w) => w.id),
    reasons,
    brief: text,
    ...(localDate ? { localDate } : {}),
  };
  const brief: ShiftBrief = {
    shift: {
      id: shiftId,
      kind: 'ceo',
      stage: 'ceo',
      stageLabel: purpose === 'review' ? 'Daily review' : 'Wake',
      doneCriteria: purpose === 'review' ? 'The daily report is written.' : 'Every reason is handled.',
      outcomes: ceoOutcomes(purpose),
      maxShiftMinutes: maxMinutes,
    },
    agent: { id: agent.id, name: agent.name, seniority: agent.seniority },
    card: {
      id: batchId,
      ref: 'CEO',
      title: purpose === 'review' ? 'Daily review' : 'Management wake',
      cardType: 'support',
      fields: {},
      riskTier: null,
      reworkRound: 0,
      completionAction: null,
      docsNeeded: false,
      dependencies: [],
    },
    project: {
      id: project?.id ?? '00000000-0000-4000-8000-000000000000',
      key: project?.key ?? 'ORG',
      name: project?.name ?? 'Organization',
      workingBranch: 'main',
      e2eGlobs: [],
      architecturalGlobs: [],
    },
    role: {
      key: role.definition.key,
      name: role.definition.name,
      instructions: role.definition.instructions,
      coreRules: role.definition.coreRules,
      skills: agent.skills,
    },
    handoffs: [],
    reviewComments: [],
    thread: [],
    standingOrders: [],
    ledger: [],
  };
  const vault = projectId ? await shiftVault(ctx, agent, projectId) : null;
  return {
    shiftId,
    claimId: randomUUID(),
    kind: 'ceo',
    agent: { ...spec, model: m.model, effort: m.effort },
    brief,
    worktree: null,
    prepare: { rebase: false },
    orgId: agent.org_id,
    maxShiftMinutes: maxMinutes,
    ceo: ceoShift,
    vault,
  };
}

/** Has a CEO shift run (started) since `since`? */
async function ceoShiftSince(ctx: Ctx, orgId: string, since: Date): Promise<boolean> {
  return !!(await one(
    ctx.pool,
    `SELECT 1 FROM shifts s JOIN agents a ON a.id = s.agent_id
      WHERE s.kind='ceo' AND a.org_id=$1 AND s.started_at > $2 AND COALESCE(s.outcome,'') NOT IN ('rejected','lost') LIMIT 1`,
    [orgId, since],
  ));
}

/** Is the CEO's workstation unreachable for a while with something urgent waiting? One e-mail and one notice. */
async function offlineNotice(
  ctx: Ctx,
  ceo: CeoState,
  block: { reason: string; unreachable: boolean } | null,
  now: Date,
): Promise<void> {
  const waiting = await one<{ at: Date }>(
    ctx.pool,
    `SELECT min(created_at) AS at FROM ceo_wakes WHERE org_id=$1 AND status='pending' AND urgency='urgent'`,
    [ceo.orgId],
  );
  const flag = await one<{ at: Date }>(
    ctx.pool,
    `SELECT at FROM ceo_flags WHERE org_id=$1 AND flag='offline_notice'`,
    [ceo.orgId],
  );
  if (!block || !waiting?.at) {
    // The episode ends only when a CEO shift has actually run since the notice: being reachable for a moment (or the urgent
    // wake being dropped) is not recovery, and clearing the flag then made the notice flap (33 times in production).
    if (flag && (await ceoShiftSince(ctx, ceo.orgId, new Date(flag.at))))
      await exec(ctx.pool, `DELETE FROM ceo_flags WHERE org_id=$1 AND flag='offline_notice'`, [ceo.orgId]);
    return;
  }
  if (flag || now.getTime() - new Date(waiting.at).getTime() < OFFLINE_NOTICE_MS) return;
  await exec(
    ctx.pool,
    `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,'offline_notice','1',$2) ON CONFLICT DO NOTHING`,
    [ceo.orgId, now],
  );
  await notifyOwner(ctx, ceo.orgId, {
    kind: 'urgent',
    title: block.unreachable
      ? `Your CEO is offline`
      : `Your CEO is not running: ${block.reason}`.slice(0, 200),
    text: block.unreachable
      ? `Something urgent is waiting for your CEO, but it cannot work right now (${block.reason}). Items still reach your desk unchanged. Bring the workstation back online, or sign in again if the login expired.`
      : `Something urgent has been waiting for your CEO for over 30 minutes and no shift was started: ${block.reason}. Items still reach your desk unchanged.`,
    subject: 'offline',
  });
}

/**
 * After `FAILURE_NOTICE_AT` failed CEO shifts in a row: one desk notice (and e-mail) naming the reason. The flag keeps it to
 * one per episode; it is cleared when a shift has run since.
 */
async function failureNotice(
  ctx: Ctx,
  orgId: string,
  streak: number,
  lastError: string | null,
  now: Date,
): Promise<void> {
  const flag = await one(ctx.pool, `SELECT 1 FROM ceo_flags WHERE org_id=$1 AND flag='start_failed'`, [
    orgId,
  ]);
  if (streak < FAILURE_NOTICE_AT) {
    if (flag && streak === 0)
      await exec(ctx.pool, `DELETE FROM ceo_flags WHERE org_id=$1 AND flag='start_failed'`, [orgId]);
    return;
  }
  if (flag) return;
  await exec(
    ctx.pool,
    `INSERT INTO ceo_flags (org_id, flag, value, at) VALUES ($1,'start_failed','1',$2) ON CONFLICT DO NOTHING`,
    [orgId, now],
  );
  const reason = lastError ?? 'unknown reason';
  await notifyOwner(ctx, orgId, {
    kind: 'urgent',
    title: `Your CEO cannot start: ${reason}`.slice(0, 200),
    text: `The last ${streak} shifts of your CEO failed, so nothing it was woken for has been handled. Reason: ${reason}. Items still reach your desk unchanged. The CEO tries again by itself; the Overview shows the last error.`,
    subject: 'start_failed',
  });
}

/** Ends CEO shifts the runner never reported on (a lost connection). */
async function endStale(ctx: Ctx, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - CEO_REVIEW_MAX_MINUTES * 60_000 - OVERRUN_SLACK_MS);
  const stale = await rows(
    ctx.pool,
    `SELECT id FROM shifts WHERE kind='ceo' AND status <> 'ended' AND started_at < $1`,
    [cutoff],
  );
  if (!stale.length) return;
  const { endCeoShift } = await import('./shift.ts');
  for (const s of stale)
    await withAppendTx(ctx.pool, async (tx) => {
      const shift = await one(tx, `SELECT * FROM shifts WHERE id=$1 AND status <> 'ended'`, [s.id]);
      if (shift)
        await ctx.store.append(
          await endCeoShift(tx, shift, 'lost', { error: 'the runner never reported on this shift', at: now }),
          { tx },
        );
    });
}

/**
 * The CEO dispatcher pass (the shape of `baTaskPass`): per organization with an active CEO, when its workstation is
 * reachable, take every pending wake into one shift (urgent ones at once, normal ones after the debounce window, the
 * daily review when due), at most one shift at a time and `maxWakesPerHour` shifts an hour. Unreachable: wakes wait, an
 * offline notice goes out after 30 minutes, and a review nobody wrote in time is posted from a template.
 */
export async function ceoPass(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  await endStale(ctx, now);
  const orgs = await rows<{ org_id: string }>(
    ctx.pool,
    `SELECT s.org_id FROM ceo_settings s JOIN organizations o ON o.id = s.org_id AND o.status IN ('trial','active')
      WHERE s.enabled AND NOT s.paused AND s.agent_id IS NOT NULL`,
  );
  let started = 0;
  for (const { org_id: orgId } of orgs) {
    const ceo = await loadCeo(ctx.pool, orgId);
    if (!ceo?.agentId) continue;
    // Old wakes are not worth a shift any more: the next report lists them as missed while offline.
    await exec(
      ctx.pool,
      `UPDATE ceo_wakes SET status='dropped' WHERE org_id=$1 AND status='pending' AND urgency <> 'scheduled' AND created_at < $2`,
      [orgId, new Date(now.getTime() - MISSED_DROP_MS)],
    );
    // Organization budget: 80% and 100% notices; at 100% minimal mode (only the daily report; the chat is not a wake).
    const { minimal } = await checkOrgBudget(ctx, ceo, now).catch(() => ({ minimal: false }));
    const reach = await ceoReachable(ctx.pool, orgId, now);
    // A review nobody took for two hours: the server writes it.
    const lateReview = await rows(
      ctx.pool,
      `SELECT id, local_date, attempts, created_at FROM ceo_wakes WHERE org_id=$1 AND status='pending' AND reason='daily_review'
          AND (created_at < $2 OR attempts >= $3)`,
      [orgId, new Date(now.getTime() - FALLBACK_REVIEW_MS), MAX_ATTEMPTS],
    );
    for (const r of lateReview)
      await postFallbackReview(ctx, orgId, r.local_date ?? '', [r.id]).catch((err) =>
        ctx.log.error({ err }, 'ceo fallback report failed'),
      );
    // A batch that can never finish must not hold its wakes (backlog #79).
    await releaseStuckBatches(ctx, orgId).catch((err) => ctx.log.error({ err }, 'ceo stuck batches failed'));
    // The CEO's shifts keep failing: tell the owner once, with the reason; the Overview shows it too.
    const failures = await ceoFailures(ctx.pool, orgId);
    await failureNotice(ctx, orgId, failures.streak, failures.lastError, now).catch((err) =>
      ctx.log.error({ err }, 'ceo failure notice failed'),
    );
    // Why nothing starts, if so: unreachable, backoff after shifts the runner never started, a running shift, the hourly limit.
    const gate = reach.ok
      ? await ceoGate(ctx.pool, orgId, ceo.policy.limits.maxWakesPerHour, failures, now)
      : null;
    const block = !reach.ok
      ? { reason: reach.reason ?? 'unreachable', unreachable: true }
      : gate && gate.code !== 'running'
        ? { reason: gate.text, unreachable: false }
        : null;
    await offlineNotice(ctx, ceo, block, now).catch((err) =>
      ctx.log.error({ err }, 'ceo offline notice failed'),
    );
    if (!reach.ok || gate) continue;

    const all = await rows(
      ctx.pool,
      `SELECT * FROM ceo_wakes WHERE org_id=$1 AND status='pending' ORDER BY created_at, id`,
      [orgId],
    );
    const pending = minimal ? all.filter((w) => w.reason === 'daily_review') : all;
    if (pending.length === 0) continue;
    const window = ceo.settings.wakeWindowMinutes * 60_000;
    const due = pending.some(
      (w) => w.urgency !== 'normal' || now.getTime() - new Date(w.created_at).getTime() >= window,
    );
    if (!due) continue;

    const conn = ctx.services.runners.get(reach.workstationId as string);
    if (!conn || !conn.reconciled) continue;
    const agent = await one(ctx.pool, 'SELECT * FROM agents WHERE id=$1', [ceo.agentId]);
    if (!agent) continue;
    const review = pending.find((w) => w.reason === 'daily_review');
    const purpose = review ? 'review' : 'wake';
    const batchId = randomUUID();
    const shiftId = randomUUID();
    const ok = await withAppendTx(ctx.pool, async (tx) => {
      const taken = await rows(
        tx,
        `UPDATE ceo_wakes SET status='taken', batch_id=$2, taken_at=$3 WHERE id = ANY($1::uuid[]) AND status='pending' RETURNING id`,
        [pending.map((w) => w.id), batchId, now],
      );
      if (taken.length === 0) return false;
      await exec(
        tx,
        `INSERT INTO ceo_batches (id, org_id, agent_id, shift_id, purpose, local_date, status, attempts, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,'running',$7,$8,$8)`,
        [
          batchId,
          orgId,
          agent.id,
          shiftId,
          purpose,
          review?.local_date ?? null,
          Math.max(0, ...pending.map((w) => Number(w.attempts))),
          now,
        ],
      );
      await ctx.store.append(
        [
          {
            streamId: streamId.ceo(orgId),
            event: {
              type: 'CeoShiftDispatched',
              payload: {
                orgId,
                batchId,
                shiftId,
                agentId: agent.id,
                workstationId: reach.workstationId as string,
                purpose,
                wakeCount: taken.length,
              },
            },
            actor: SYSTEM_ACTOR,
            scope: orgScope(orgId),
          },
        ],
        { tx },
      );
      return true;
    });
    if (!ok) continue;
    let built: ShiftStartPayload | null = null;
    try {
      built = await buildCeoShiftStart(
        ctx,
        ceo,
        agent,
        batchId,
        shiftId,
        pending,
        purpose,
        review?.local_date ?? undefined,
      );
    } catch (err) {
      ctx.log.error({ err }, 'ceo brief failed');
      await releaseBatch(ctx, batchId, `could not build the brief: ${(err as Error).message}`);
      continue;
    }
    if (!built) {
      await releaseBatch(ctx, batchId, 'could not build the brief (the CEO role is missing)');
      continue;
    }
    if (!ctx.services.runners.send(reach.workstationId as string, 'shift.start', built, now)) {
      await releaseBatch(ctx, batchId, 'the runner is not connected');
      continue;
    }
    started++;
  }
  return started;
}

/** Queues the day's review wake once the owner's clock passes the report time. Called from the reporter sweep. */
export async function queueCeoReviews(ctx: Ctx, now: Date): Promise<number> {
  const orgs = await rows<{ org_id: string }>(
    ctx.pool,
    `SELECT s.org_id FROM ceo_settings s JOIN organizations o ON o.id = s.org_id AND o.status IN ('trial','active')
       JOIN users u ON u.id = o.owner_user_id AND u.status='active'
      WHERE s.enabled AND NOT s.paused AND s.agent_id IS NOT NULL`,
  );
  let n = 0;
  for (const { org_id: orgId } of orgs) {
    const ceo = await loadCeo(ctx.pool, orgId);
    if (!ceo) continue;
    const prefs = await reportingOf(ctx.pool, orgId);
    const due = floorReportDue(
      now,
      prefs.timezone,
      ceo.settings.reportAt ?? prefs.dailyAt,
      ceo.reportDay,
      prefs.createdAt,
    );
    if (!due.due) continue;
    const exists = await one(
      ctx.pool,
      `SELECT 1 FROM ceo_wakes WHERE org_id=$1 AND reason='daily_review' AND local_date=$2 AND status <> 'dropped'`,
      [orgId, due.localDate],
    );
    if (exists) continue;
    // A day with nothing to say needs no report (the CEO's own activity counts).
    const digest = await buildFloorDigest(ctx.pool, orgId, now, due.localDate);
    const acts = await one(
      ctx.pool,
      `SELECT 1 FROM ceo_actions WHERE org_id=$1 AND created_at > $2 AND mode IN ('decided','recommended') LIMIT 1`,
      [orgId, new Date(now.getTime() - 86_400_000)],
    );
    if (floorDigestIsEmpty(digest) && !acts) continue;
    await enqueueWake(
      ctx.pool,
      orgId,
      {
        reason: 'daily_review',
        urgency: 'scheduled',
        subjectKind: 'review',
        subjectId: due.localDate,
        localDate: due.localDate,
      },
      now,
    );
    n++;
  }
  return n;
}

export { runnerActor };
