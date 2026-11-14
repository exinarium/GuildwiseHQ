import { randomUUID } from 'node:crypto';
import {
  applyFindingsCap,
  type FindingDisposition,
  type HeldBackFindingsResponse,
  type MergeInput,
  mergeFindings,
  type OrgRole,
  PR_REVIEW_TIMEOUT_MS,
  type PrReviewDto,
  type PrReviewer,
  type PrReviewFinding,
  type PrReviewManualAction,
  type PrReviewPostPayload,
  PrReviewPostResultSchema,
  PrReviewRunPayloadSchema,
  PrReviewRunResultSchema,
  type PrReviewRunState,
  type PrReviewState,
  type PrReviewTriggerRequest,
  prReviewMarker,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import { manualReviewAction } from '../review/manual-action.ts';
import { mayStart } from '../review/may-start.ts';
import { reviewerTokenStates } from '../review/reviewer-gate.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, SYSTEM_ACTOR } from './common.ts';
import { ownerPendingOf } from './owner-pending.ts';
import { applyReplayRunResult, timeOutReplayRun } from './pr-replays.ts';
import { prReviewQueue, requireSpendOwner } from './pr-review-cap.ts';
import { RUN_GRACE_MS, type StartResult, startPrReviewRound } from './pr-review-rounds.ts';
import { loadSizeContext, onPrReviewTimedOut, resolveTimedOutTwice, verdictOf } from './pr-size-check.ts';

/**
 * The first reviewer on PR-only pull requests. The server decides WHEN a run starts and is the only party that starts a
 * post, and only for a completed run. A run that times out or fails writes one event and nothing else: the pull request
 * stays `not_reviewed`, nothing is posted, nothing is restarted by itself, and no card, shift or transition is touched.
 */

export { RUN_GRACE_MS, type StartResult, startPrReviewRound };
/** A round whose post did not answer within this time is failed at the post stage. */
export const POST_WAIT_MS = 15 * 60_000;
/** GitHub refuses a review body over 65,536 characters. */
const BODY_LIMIT = 60_000;

const scopeOf = (orgId: string, projectId: string) => projectScope(orgId, projectId);

async function orgOf(db: Queryable, projectId: string): Promise<string | undefined> {
  return (await one(db, 'SELECT org_id FROM projects WHERE id=$1', [projectId]))?.org_id as
    | string
    | undefined;
}

// ---- dispatch ----------------------------------------------------------------------------------------------------

export { mayStart };

/**
 * The scheduler pass: for each active project with a PR-only repository, starts the first reviewer on the pull
 * requests of the project's queue that fall inside today's admission window (`prReviewQueue`: the oldest `cap - used`
 * that have a ready reviewer). Pull requests past the cap wait for a following day. One run per pull request: a
 * timed-out or model-error pull request is not started again by itself (the owner re-runs it by hand).
 */
export async function dispatchPrReviews(ctx: Ctx): Promise<number> {
  const projects = await rows(
    ctx.pool,
    `SELECT DISTINCT p.id FROM project_repos r JOIN projects p ON p.id = r.project_id
       JOIN organizations o ON o.id = p.org_id
      WHERE r.pr_only AND r.removed_at IS NULL AND p.status='active' AND NOT COALESCE(o.simulation, false)`,
  );
  let started = 0;
  for (const p of projects) {
    const targets = await dispatchProject(ctx, p.id as string).catch((err) => {
      ctx.log.error({ err, projectId: p.id }, 'starting pull request reviews failed');
      return [] as string[];
    });
    started += targets.length;
    for (const target of new Set(targets))
      void Promise.resolve(ctx.services.gateway.deliverPending(target)).catch(() => undefined);
  }
  return started;
}

/** One project, one transaction: the project row lock keeps two passes (or a pass and a manual trigger) from both using the last slot. */
async function dispatchProject(ctx: Ctx, projectId: string): Promise<string[]> {
  return withAppendTx(ctx.pool, async (tx) => {
    await one(tx, 'SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    const queue = await prReviewQueue(tx, ctx, projectId);
    const targets: string[] = [];
    for (const item of queue.items) {
      if (item.slot !== 'today') continue; // later and blocked ones never start: this is the cap
      const r = await startPrReviewRound(ctx, tx, {
        projectId,
        prReviewId: item.prReviewId,
        trigger: 'auto',
        requestedBy: null,
        enforceConcurrency: true,
      });
      if (r.started) targets.push(r.target); // not started (concurrency): keeps its place in the window
    }
    return targets;
  });
}

/**
 * The owner starts a review by hand. It goes past the daily cap and the concurrency limits and is never counted
 * toward the cap (the owner decides extra spend). Only the project Owner or an organization Owner/Admin.
 */
export async function triggerPrReview(
  ctx: Ctx,
  user: { id: string },
  org: { id: string; role: OrgRole | null },
  projectId: string,
  prReviewId: string,
  req: PrReviewTriggerRequest = {},
): Promise<PrReviewDto> {
  let target: string | undefined;
  await withAppendTx(ctx.pool, async (tx) => {
    await requireSpendOwner(tx, user, org, projectId);
    await one(tx, 'SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    const r = await startPrReviewRound(ctx, tx, {
      projectId,
      prReviewId,
      trigger: 'manual',
      requestedBy: user.id,
      enforceConcurrency: false,
      expectedPreviousRunId: req.previousRunId,
    });
    if (r.started) {
      target = r.target;
      // the owner acted on a "timed out twice" item by re-running: it stops waiting for them
      await resolveTimedOutTwice(ctx, tx, prReviewId, 'owner_acted', user.id);
      return;
    }
    if (r.reason === 'gone') throw notFound('pull request not found');
    if (r.reason === 'closed') throw conflict('pr_closed', 'this pull request is closed');
    if (r.reason === 'stale')
      throw conflict(
        'stale_action',
        'This pull request changed since the page loaded. Refresh and try again.',
      );
    if (r.reason === 'running') throw conflict('review_running', 'a review of this pull request is running');
    if (r.reason === 'not_ready')
      throw conflict('reviewer_not_ready', 'no reviewer workstation is ready for this repository', {
        reason: r.detail,
      });
    throw conflict('not_reviewable', 'this pull request cannot be reviewed now');
  });
  if (target) void Promise.resolve(ctx.services.gateway.deliverPending(target)).catch(() => undefined);
  const list = await listPrReviews(ctx.pool, projectId, ctx, { canTrigger: true });
  const dto = list.find((p) => p.id === prReviewId);
  if (!dto) throw notFound('pull request not found');
  return dto;
}

// ---- the findings the review posts -----------------------------------------------------------------------------

type StoredFinding = PrReviewFinding & {
  findingId: string;
  rank?: number;
  disposition?: FindingDisposition;
};

/** The findings that go to the pull request: the posted ones (no disposition counts as posted). Held back and merged ones stay out. */
export function selectFindingsToPost<T extends { disposition?: FindingDisposition }>(findings: T[]): T[] {
  return findings.filter((f) => f.disposition === undefined || f.disposition === 'posted');
}

/**
 * What the runner posts for a completed run: one review. A finding is sent as an inline comment only when its line is
 * in the diff; any other finding has no `line`, so the poster puts it in the review body and cannot trigger the host's
 * refusal of the whole review. The text never names the model or the reviewer slot.
 */
export function buildReviewPost(
  run: { runId: string; summary: string; headSha: string; baseSha: string },
  spec: {
    projectId: string;
    projectRepoId: string;
    remoteUrlNormalized: string;
    prNumber: number;
    baseRef: string;
  },
  findings: StoredFinding[],
): PrReviewPostPayload {
  const chosen = selectFindingsToPost(findings);
  const marker = prReviewMarker(run.runId);
  const text = (run.summary.trim() || (chosen.length ? '' : 'No findings.')).slice(0, BODY_LIMIT - 1000);
  return {
    runId: run.runId,
    spec: {
      runId: run.runId,
      projectId: spec.projectId,
      projectRepoId: spec.projectRepoId,
      remoteUrlNormalized: spec.remoteUrlNormalized,
      prNumber: spec.prNumber,
      headSha: run.headSha,
      baseSha: run.baseSha,
      baseRef: spec.baseRef,
    },
    summary: text ? `${text}\n\n${marker}` : marker,
    findings: chosen.map((f) => ({
      findingId: f.findingId,
      finding: {
        path: f.path,
        ...(f.anchored && f.line ? { line: f.line, side: 'RIGHT' as const } : {}),
        title: `[${f.severity}] ${f.title}`.slice(0, 200),
        body: (f.line && !f.anchored
          ? `Line ${f.line}, outside the changed lines.\n\n${f.body}`
          : f.body
        ).slice(0, 10_000),
      },
    })),
  };
}

// ---- results ---------------------------------------------------------------------------------------------------

/**
 * The only place a `pr_review.post` is enqueued. A replay run is offline and is never posted: this refuses it.
 */
export async function enqueueReviewPost(
  tx: Queryable,
  run: { replay_id?: unknown },
  workstationId: string,
  post: PrReviewPostPayload,
  expiresAt: Date,
): Promise<void> {
  if (run.replay_id) throw new Error('replay runs are never posted');
  await enqueueRunnerCommand(tx, workstationId, 'pr_review.post', post, expiresAt);
}

type Emit = (type: string, payload: Record<string, unknown>) => Promise<unknown>;

function emitterFor(ctx: Ctx, tx: Tx, projectId: string, orgId: string): Emit {
  return (type, payload) =>
    ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type, payload } as never,
          actor: SYSTEM_ACTOR,
          scope: scopeOf(orgId, projectId),
        },
      ],
      { tx },
    );
}

/**
 * Ends a round that cannot be posted: one run timed out or failed, the heads differ, or the post did not finish. Nothing
 * is posted. Every partner run still running is cancelled (its pending command is dropped and the runner is told to
 * stop it). Returns the workstation to deliver the cancels to.
 */
async function endRound(
  tx: Tx,
  emit: Emit,
  round: Record<string, unknown>,
  end: {
    outcome: 'timed_out' | 'failed';
    causeRunId: string | null;
    code: string | null;
    partnerReason: 'partner_timeout' | 'partner_failed';
    at: string;
    now: Date;
  },
): Promise<string | undefined> {
  const roundId = round.id as string;
  const base = { projectId: round.project_id as string, prReviewId: round.pr_review_id as string, roundId };
  // a round of one ends with its run's own event (the projection of `PrReviewRunTimedOut`/`PrReviewRunFailed`)
  if ((round.reviewers as string[]).length > 1)
    await emit('PrReviewRoundEnded', {
      ...base,
      outcome: end.outcome,
      causeRunId: end.causeRunId,
      code: end.code,
      at: end.at,
    });
  let target: string | undefined;
  const partners = await rows(
    tx,
    `SELECT id, workstation_id FROM pr_review_runs WHERE round_id=$1 AND state='running' ORDER BY id`,
    [roundId],
  );
  for (const partner of partners) {
    await emit('PrReviewRunCancelled', {
      ...base,
      runId: partner.id,
      reason: end.partnerReason,
      at: end.at,
    });
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', last_error='superseded'
        WHERE type='pr_review.run' AND status='pending' AND payload->>'runId' = $1`,
      [partner.id],
    );
    if (partner.workstation_id) {
      target = partner.workstation_id as string;
      await enqueueRunnerCommand(
        tx,
        target,
        'pr_review.cancel',
        { runId: partner.id as string, reason: end.partnerReason },
        new Date(end.now.getTime() + PR_REVIEW_TIMEOUT_MS),
      );
    }
  }
  return target;
}

interface RoundFinding extends MergeInput {
  runId: string;
}

/**
 * The last run of a round is in: the heads must agree, the findings of the runs are merged (duplicates combined), the
 * findings cap applies to the MERGED list, and one post goes out for the round (its id rides in the payload's `runId`).
 * A pair's review text is a neutral line written here, so neither model's summary shows who wrote what.
 * Returns the workstation to send the post to, or undefined when the round ended instead.
 */
async function mergeAndPostRound(
  ctx: Ctx,
  tx: Tx,
  emit: Emit,
  round: Record<string, unknown>,
  at: string,
  now: Date,
): Promise<string | undefined> {
  const roundId = round.id as string;
  const projectId = round.project_id as string;
  const prReviewId = round.pr_review_id as string;
  const runs = await rows(
    tx,
    `SELECT * FROM pr_review_runs WHERE round_id=$1 AND state='completed' ORDER BY reviewer, id`,
    [roundId],
  );
  const reviewers = round.reviewers as PrReviewer[];
  if (runs.length === 0 || runs.length !== reviewers.length) return undefined;
  if (new Set(runs.map((r) => r.head_sha)).size > 1) {
    await endRound(tx, emit, round, {
      outcome: 'failed',
      causeRunId: null,
      code: 'heads_differ',
      partnerReason: 'partner_failed',
      at,
      now,
    });
    return undefined;
  }
  const perRun: RoundFinding[][] = [];
  for (const run of runs) {
    const list = await rows(
      tx,
      `SELECT id, idx, path, line, anchored, severity, title, body FROM pr_review_findings WHERE run_id=$1 ORDER BY idx`,
      [run.id],
    );
    perRun.push(
      list.map((f) => ({
        id: f.id as string,
        runId: run.id as string,
        reviewer: run.reviewer as PrReviewer,
        idx: Number(f.idx),
        path: f.path as string,
        line: f.line === null ? null : Number(f.line),
        anchored: Boolean(f.anchored),
        severity: f.severity as 'high' | 'medium' | 'low',
        title: f.title as string,
        body: f.body as string,
      })),
    );
  }
  const merged = mergeFindings(perRun);
  const known = runs.map((r) => r.changed_lines).find((v) => v !== null && v !== undefined);
  let changedLines: number | null = known === undefined ? null : Number(known);
  if (changedLines === null && runs.length > 1) {
    const pr = await one(tx, 'SELECT changed_lines FROM pr_reviews WHERE id=$1', [prReviewId]);
    if (pr?.changed_lines !== null && pr?.changed_lines !== undefined)
      changedLines = Number(pr.changed_lines);
  }
  const { cap, ordered } = applyFindingsCap(
    merged.map((m) => ({ ...m.canonical, severity: m.severity })),
    changedLines,
  );
  await emit('PrReviewRoundMerged', {
    projectId,
    prReviewId,
    roundId,
    changedLines,
    findingsCap: cap,
    findings: [
      ...ordered.map((o) => ({
        findingId: o.id,
        disposition: o.disposition,
        rank: o.rank,
        mergedInto: null,
        severity: o.severity,
      })),
      ...merged.flatMap((m) =>
        m.duplicates.map((d) => ({
          findingId: d.id,
          disposition: 'merged' as const,
          rank: null,
          mergedInto: m.canonical.id,
          severity: d.severity,
        })),
      ),
    ],
    at,
  });
  const first = runs[0] as Record<string, unknown>;
  const chosen = ordered.filter((o) => o.disposition === 'posted');
  const summary =
    runs.length === 1
      ? (first.summary as string)
      : chosen.length === 0
        ? 'Automated review: no findings.'
        : `Automated review: ${chosen.length} finding${chosen.length === 1 ? '' : 's'} posted.`;
  const spec = await one(
    tx,
    `SELECT r.remote_url_normalized, r.id AS repo_id, pr.change_id, pr.base_branch
       FROM pr_reviews pr JOIN project_repos r ON r.id = pr.project_repo_id WHERE pr.id=$1`,
    [prReviewId],
  );
  if (!spec) return undefined;
  const post = buildReviewPost(
    {
      runId: roundId,
      summary,
      headSha: first.head_sha as string,
      baseSha: first.base_sha as string,
    },
    {
      projectId,
      projectRepoId: spec.repo_id as string,
      remoteUrlNormalized: spec.remote_url_normalized as string,
      prNumber: Number(spec.change_id),
      baseRef: spec.base_branch as string,
    },
    ordered.map((o) => ({
      findingId: o.id,
      path: o.path,
      line: o.line,
      anchored: o.anchored,
      severity: o.severity,
      title: o.title,
      body: o.body,
      rank: o.rank,
      disposition: o.disposition,
    })),
  );
  const postTo = round.workstation_id as string;
  await enqueueReviewPost(tx, first, postTo, post, new Date(now.getTime() + POST_WAIT_MS));
  return postTo;
}

/**
 * `command.result` of `pr_review.run`. A result for a run that is no longer `running` (a duplicate after a requeue, an
 * answer after the server gave the run up, or a run cancelled because its partner failed) is ignored. A `completed` run
 * stores its findings and waits for its partner; the last run of the round merges and sends the one post to the same
 * workstation (it holds the token). A timeout or a failure ends the whole round: the partner is cancelled and nothing is
 * posted (the pull request stays `not_reviewed`). Lock order everywhere: the round row, then the run row.
 */
export async function applyPrReviewRunResult(
  ctx: Ctx,
  commandPayload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const payload = PrReviewRunPayloadSchema.safeParse(commandPayload);
  if (!payload.success) return;
  const p = payload.data;
  const parsed = PrReviewRunResultSchema.safeParse(result);
  const now = ctx.clock.now();
  const deliver = new Set<string>();
  await withAppendTx(ctx.pool, async (tx) => {
    const peek = await one(tx, 'SELECT round_id, replay_id FROM pr_review_runs WHERE id=$1', [p.runId]);
    const round =
      peek?.round_id && !peek.replay_id
        ? await one(tx, 'SELECT * FROM pr_review_rounds WHERE id=$1 FOR UPDATE', [peek.round_id])
        : undefined;
    const run = await one(tx, 'SELECT * FROM pr_review_runs WHERE id=$1 FOR UPDATE', [p.runId]);
    if (!run || run.state !== 'running') {
      ctx.log.info({ runId: p.runId }, 'ignored a pull request review result for a run that is not running');
      return;
    }
    // a replay run is offline: its result goes to the replay and never reaches the post below
    if (run.replay_id) {
      await applyReplayRunResult(ctx, tx, run, ok, parsed.success ? parsed.data : undefined, error);
      return;
    }
    if (!round) {
      ctx.log.warn({ runId: p.runId }, 'a pull request review result for a run without a round');
      return;
    }
    const orgId = await orgOf(tx, p.projectId);
    if (!orgId) return;
    const at = now.toISOString();
    const base = { projectId: p.projectId, prReviewId: p.prReviewId, runId: p.runId, at };
    const emit = emitterFor(ctx, tx, p.projectId, orgId);
    const end = async (
      outcome: 'timed_out' | 'failed',
      code: string,
      reason: 'partner_timeout' | 'partner_failed',
    ) => {
      if (round.state !== 'running') return;
      const t = await endRound(tx, emit, round, {
        outcome,
        causeRunId: p.runId,
        code,
        partnerReason: reason,
        at,
        now,
      });
      if (t) deliver.add(t);
    };
    const r = ok && parsed.success ? parsed.data : undefined;
    if (!r) {
      await emit('PrReviewRunFailed', {
        ...base,
        stage: 'run',
        code: 'error',
        error: (error ?? 'the workstation did not answer the review properly').slice(0, 400),
        retryable: true,
      });
      await end('failed', 'error', 'partner_failed');
      return;
    }
    if (r.outcome === 'timeout') {
      await emit('PrReviewRunTimedOut', { ...base, durationMs: r.durationMs, phase: r.phase, by: 'runner' });
      await end('timed_out', 'timeout', 'partner_timeout');
      // the size check decides what a timeout leads to (never a replay run: it branched off above)
      await onPrReviewTimedOut(ctx, tx, { ...run, state: 'timed_out' });
      return;
    }
    if (r.outcome === 'failed') {
      await emit('PrReviewRunFailed', {
        ...base,
        stage: 'run',
        code: r.code,
        error: r.error,
        retryable: r.retryable,
        durationMs: r.durationMs,
      });
      await end('failed', r.code, 'partner_failed');
      return;
    }
    if (round.state !== 'running') return;
    // the cap is decided here, from the runner's line count (the round decides it again over the merged findings)
    const { cap, ordered } = applyFindingsCap(r.findings, r.changedLines);
    if (r.changedLines === undefined)
      ctx.log.info({ runId: p.runId }, 'no changed-line count from the runner; findings cap 5');
    const findings = ordered.map((f) => ({ ...f, findingId: randomUUID() }));
    await emit('PrReviewRunCompleted', {
      ...base,
      changedLines: r.changedLines ?? null,
      findingsCap: cap,
      headSha: r.headSha,
      baseSha: r.baseSha,
      durationMs: r.durationMs,
      summary: r.summary,
      findings,
    });
    const waiting = await one(
      tx,
      `SELECT count(*)::int AS n FROM pr_review_runs WHERE round_id=$1 AND state='running'`,
      [round.id],
    );
    if (Number(waiting?.n ?? 0) > 0) return; // the partner is still working
    const postTo = await mergeAndPostRound(ctx, tx, emit, round, at, now);
    if (postTo) deliver.add(postTo);
  });
  for (const target of deliver)
    void Promise.resolve(ctx.services.gateway.deliverPending(target)).catch(() => undefined);
}

/**
 * `command.result` of `pr_review.post`. The payload's `runId` is the round id. The pull request becomes `reviewed` only
 * now, when the comments exist on the git host: also when the round had already been given up at the post stage (the
 * review is there). A failed post keeps it `not_reviewed` and keeps the error for the owner.
 */
export async function applyPrReviewPostResult(
  ctx: Ctx,
  commandPayload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const roundId = typeof commandPayload.runId === 'string' ? commandPayload.runId : '';
  const ids = Array.isArray(commandPayload.findings)
    ? (commandPayload.findings as Array<{ findingId?: unknown }>).flatMap((f) =>
        typeof f.findingId === 'string' ? [f.findingId] : [],
      )
    : [];
  const parsed = PrReviewPostResultSchema.safeParse(result);
  const now = ctx.clock.now();
  const at = now.toISOString();
  await withAppendTx(ctx.pool, async (tx) => {
    const round = await one(tx, 'SELECT * FROM pr_review_rounds WHERE id=$1 FOR UPDATE', [roundId]);
    if (!round) {
      ctx.log.warn({ roundId }, 'ignored a post result for a run that is not in a live round');
      return;
    }
    if (round.state === 'posted') return;
    const runs = await rows(
      tx,
      'SELECT * FROM pr_review_runs WHERE round_id=$1 ORDER BY reviewer, id FOR UPDATE',
      [roundId],
    );
    const first = runs[0];
    if (!first) return;
    const projectId = round.project_id as string;
    const orgId = await orgOf(tx, projectId);
    if (!orgId) return;
    const prReviewId = round.pr_review_id as string;
    const emit = emitterFor(ctx, tx, projectId, orgId);
    const r = ok && parsed.success ? parsed.data : undefined;
    if (r?.ok) {
      const reviewers = round.reviewers as PrReviewer[];
      await emit('PrReviewPosted', {
        projectId,
        prReviewId,
        runId: first.id,
        roundId,
        reviewers,
        reviewer: reviewers[0] ?? first.reviewer,
        reviewUrl: r.reviewUrl,
        postedFindingIds: ids,
        at,
      });
      return;
    }
    if (round.state !== 'posting') return; // timed out or failed already: nothing more to say
    const code = r && !r.ok ? r.code : 'error';
    for (const run of runs.filter((x) => x.state === 'completed'))
      await emit('PrReviewRunFailed', {
        projectId,
        prReviewId,
        runId: run.id,
        at,
        stage: 'post',
        code,
        error: (r && !r.ok ? r.error : (error ?? 'the workstation did not answer the post properly')).slice(
          0,
          400,
        ),
        retryable: code === 'unreachable' || code === 'error',
      });
    if (runs.length > 1)
      await emit('PrReviewRoundEnded', {
        projectId,
        prReviewId,
        roundId,
        outcome: 'failed',
        causeRunId: null,
        code,
        at,
      });
  });
}

// ---- backstop --------------------------------------------------------------------------------------------------

/**
 * The scheduler pass that gives up on lost work: a run still `running` past its limit plus a grace is timed out by the
 * server (its late answer is then ignored, and its round ends); a round whose post never answered fails at the post
 * stage. A run waiting for its partner is normal, not stale: only the round's post wait counts.
 */
export async function sweepStalePrReviewRuns(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  const stale = await rows(
    ctx.pool,
    `SELECT id FROM pr_review_runs
      WHERE state='running' AND started_at + (timeout_ms + $1) * interval '1 millisecond' < $2
      ORDER BY replay_id NULLS LAST, started_at`,
    [RUN_GRACE_MS, now],
  );
  const deliver = new Set<string>();
  let n = 0;
  for (const s of stale) {
    const done = await withAppendTx(ctx.pool, async (tx) => {
      const peek = await one(tx, 'SELECT round_id, replay_id FROM pr_review_runs WHERE id=$1', [s.id]);
      const round =
        peek?.round_id && !peek.replay_id
          ? await one(tx, 'SELECT * FROM pr_review_rounds WHERE id=$1 FOR UPDATE', [peek.round_id])
          : undefined;
      const run = await one(tx, 'SELECT * FROM pr_review_runs WHERE id=$1 FOR UPDATE', [s.id]);
      if (!run || run.state !== 'running') return false;
      if (run.replay_id) {
        await timeOutReplayRun(ctx, tx, run);
        await exec(
          tx,
          `UPDATE runner_commands SET status='failed', last_error='superseded'
            WHERE type='pr_review.run' AND status IN ('pending','sent') AND payload->>'runId' = $1`,
          [run.id],
        );
        return true;
      }
      const projectId = run.project_id as string;
      const orgId = await orgOf(tx, projectId);
      if (!orgId) return false;
      const at = now.toISOString();
      const emit = emitterFor(ctx, tx, projectId, orgId);
      await emit('PrReviewRunTimedOut', {
        projectId,
        prReviewId: run.pr_review_id as string,
        runId: run.id as string,
        at,
        durationMs: Math.max(0, now.getTime() - new Date(run.started_at as string).getTime()),
        phase: 'review',
        by: 'server',
      });
      // the command may still wait for an offline workstation: it must not run later
      await exec(
        tx,
        `UPDATE runner_commands SET status='failed', last_error='superseded'
          WHERE type='pr_review.run' AND status IN ('pending','sent') AND payload->>'runId' = $1`,
        [run.id],
      );
      if (round && round.state === 'running') {
        const t = await endRound(tx, emit, round, {
          outcome: 'timed_out',
          causeRunId: run.id as string,
          code: 'timeout',
          partnerReason: 'partner_timeout',
          at,
          now,
        });
        if (t) deliver.add(t);
      }
      await onPrReviewTimedOut(ctx, tx, { ...run, state: 'timed_out' });
      return true;
    });
    if (done) n++;
  }
  const waiting = await rows(
    ctx.pool,
    `SELECT id FROM pr_review_rounds
      WHERE state='posting' AND posting_at + $1 * interval '1 millisecond' < $2`,
    [POST_WAIT_MS, now],
  );
  for (const w of waiting) {
    const done = await withAppendTx(ctx.pool, async (tx) => {
      const round = await one(tx, 'SELECT * FROM pr_review_rounds WHERE id=$1 FOR UPDATE', [w.id]);
      if (!round || round.state !== 'posting') return false;
      const projectId = round.project_id as string;
      const orgId = await orgOf(tx, projectId);
      if (!orgId) return false;
      const at = now.toISOString();
      const emit = emitterFor(ctx, tx, projectId, orgId);
      const runs = await rows(
        tx,
        `SELECT id FROM pr_review_runs WHERE round_id=$1 AND state='completed' ORDER BY reviewer, id FOR UPDATE`,
        [round.id],
      );
      for (const run of runs)
        await emit('PrReviewRunFailed', {
          projectId,
          prReviewId: round.pr_review_id as string,
          runId: run.id as string,
          at,
          stage: 'post',
          code: 'error',
          error: 'posting did not finish',
          retryable: false,
        });
      if (runs.length > 1)
        await emit('PrReviewRoundEnded', {
          projectId,
          prReviewId: round.pr_review_id as string,
          roundId: round.id as string,
          outcome: 'failed',
          causeRunId: null,
          code: 'post_unfinished',
          at,
        });
      // the post may still wait for an offline workstation: it must not run later
      await exec(
        tx,
        `UPDATE runner_commands SET status='failed', last_error='superseded'
          WHERE type='pr_review.post' AND status IN ('pending','sent') AND payload->>'runId' = $1`,
        [round.id],
      );
      return true;
    });
    if (done) n++;
  }
  for (const target of deliver)
    void Promise.resolve(ctx.services.gateway.deliverPending(target)).catch(() => undefined);
  return n;
}

// ---- what the owner sees ---------------------------------------------------------------------------------------

/**
 * Blind marking: the reviewer is withheld while the pull request has posted findings the owner has not marked. A pair
 * has no single reviewer: `reviewer` is null for it, and `reviewers` lists them once the owner may see them.
 */
function blindReviewer(l: Record<string, unknown>) {
  const unmarkedCount = Number(l.unmarked_count ?? 0);
  const reviewersHidden = unmarkedCount > 0;
  const all =
    (l.reviewed_by_all as PrReviewer[] | null) ?? (l.reviewed_by ? [l.reviewed_by as PrReviewer] : null);
  return {
    reviewer: reviewersHidden || (all?.length ?? 0) > 1 ? null : ((l.reviewed_by as 'first' | null) ?? null),
    reviewers: reviewersHidden ? null : all,
    reviewersHidden,
    unmarkedCount,
  };
}

function manualActionOf(l: Record<string, unknown>): PrReviewManualAction {
  const a = manualReviewAction({
    reviewState: l.review_state as PrReviewState,
    closed: Boolean(l.closed_at),
    prOnly: Boolean(l.pr_only),
    lastRun: l.round_id
      ? {
          id: l.round_id as string,
          state: l.round_state === 'posting' ? 'completed' : (l.round_state as PrReviewRunState),
        }
      : null,
  });
  return 'refused' in a ? null : a;
}

const ROUND_STATE: Record<string, 'running' | 'completed' | 'posted' | 'timed_out' | 'failed'> = {
  running: 'running',
  posting: 'completed',
  posted: 'posted',
  timed_out: 'timed_out',
  failed: 'failed',
};

/** The recorded pull requests of a project's live repositories with their latest review round, open ones first. */
export async function listPrReviews(
  db: Queryable,
  projectId: string,
  ctx?: Pick<Ctx, 'clock'>,
  viewer?: { canTrigger: boolean },
): Promise<PrReviewDto[]> {
  const queue = ctx ? await prReviewQueue(db, ctx, projectId) : undefined;
  const queued = new Map((queue?.items ?? []).map((q) => [q.prReviewId, q]));
  const list = await rows(
    db,
    `SELECT pr.id, pr.project_repo_id, pr.change_id, pr.url, pr.title, pr.author, pr.opened_at, pr.review_state,
            pr.reviewed_at, pr.reviewed_by, pr.reviewed_by_all, pr.closed_at, r.pr_only, r.remote_url_normalized, r.name,
            pr.attention, pr.split_reason, pr.split_at, pr.split_total, pr.split_budget, pr.split_unit, pr.split_members,
            nt.state AS notice_state, nt.posted_at AS notice_posted_at, nt.review_url AS notice_url, nt.error AS notice_error,
            rd.id AS round_id, rd.state AS round_state, rd.started_at, rd.finished_at, rd.end_code, rd.review_url,
            rd.trigger, rd.rerun_of_round_id, prev.started_at AS rerun_of_started_at, rd.held_back_count, rd.findings_cap, rd.changed_lines, rd.merged_count, rd.reviewers,
            (SELECT max(x.duration_ms) FROM pr_review_runs x WHERE x.round_id = rd.id) AS duration_ms,
            (SELECT max(x.timeout_ms) FROM pr_review_runs x WHERE x.round_id = rd.id) AS timeout_ms,
            (SELECT x.error FROM pr_review_runs x WHERE x.round_id = rd.id AND x.error IS NOT NULL
              ORDER BY x.finished_at DESC NULLS LAST LIMIT 1) AS error,
            (SELECT count(*)::int FROM pr_review_findings f JOIN pr_review_runs x ON x.id = f.run_id
              WHERE x.round_id = rd.id AND f.posted) AS posted_count,
            (SELECT count(*)::int FROM pr_review_findings f JOIN pr_review_runs x ON x.id = f.run_id
              WHERE x.round_id = rd.id AND f.disposition <> 'merged') AS findings_count,
            (SELECT count(*)::int FROM pr_review_findings f
               LEFT JOIN pr_review_finding_marks m ON m.finding_id = f.id
              WHERE f.pr_review_id = pr.id AND f.posted AND m.finding_id IS NULL) AS unmarked_count
       FROM pr_reviews pr
       JOIN project_repos r ON r.id = pr.project_repo_id AND r.removed_at IS NULL
       LEFT JOIN pr_review_rounds rd ON rd.id = (
              SELECT x.id FROM pr_review_rounds x WHERE x.pr_review_id = pr.id ORDER BY x.started_at DESC LIMIT 1)
       LEFT JOIN pr_review_rounds prev ON prev.id = rd.rerun_of_round_id
       LEFT JOIN pr_split_notices nt ON nt.id = (
              SELECT y.id FROM pr_split_notices y WHERE y.pr_review_id = pr.id ORDER BY y.created_at DESC LIMIT 1)
      WHERE pr.project_id=$1
      ORDER BY (pr.closed_at IS NULL) DESC, pr.opened_at DESC, pr.change_id DESC
      LIMIT 200`,
    [projectId],
  );
  const roundIds = list.flatMap((l) => (l.round_id ? [l.round_id as string] : []));
  const runList = roundIds.length
    ? await rows(
        db,
        `SELECT round_id, state, duration_ms, reviewer, model FROM pr_review_runs
          WHERE round_id = ANY($1::uuid[]) ORDER BY started_at, reviewer`,
        [roundIds],
      )
    : [];
  const tokens = await reviewerTokenStates(db, [...new Set(list.map((l) => l.project_repo_id as string))]);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  // the live size check result: one read of the stored open list per repository
  const sizes = new Map<string, Awaited<ReturnType<typeof loadSizeContext>>>();
  for (const repoId of new Set(list.filter((l) => !l.closed_at).map((l) => l.project_repo_id as string)))
    sizes.set(repoId, await loadSizeContext(db, projectId, repoId));
  const reminders = new Map<string, { dueAt: string; remindedAt: string | null }>();
  for (const l of list)
    if (l.attention === 'timed_out_twice') {
      const t = await ownerPendingOf(db, 'second_timeout', l.id as string);
      if (t?.status === 'open') reminders.set(l.id as string, { dueAt: t.dueAt, remindedAt: t.remindedAt });
    }
  const sizeOf = (l: Record<string, unknown>): PrReviewDto['size'] => {
    const ctx2 = sizes.get(l.project_repo_id as string);
    if (!ctx2 || l.closed_at || l.review_state === 'reviewed') return null;
    const v = verdictOf(ctx2, l.change_id as string);
    if (v.state === 'inactive') return { state: 'inactive', reason: v.reason };
    if (v.state === 'unknown') return { state: 'unknown', reason: v.reason };
    return {
      state: v.state,
      total: v.total,
      budget: v.budget,
      unit: v.unit,
      members: v.members,
      complete: v.complete,
    };
  };
  return list.map((l) => {
    const blind = blindReviewer(l);
    // nothing was posted by a round that timed out or failed: nothing is blind, the owner sees which run failed
    const open = l.round_state === 'timed_out' || l.round_state === 'failed';
    const hide = blind.reviewersHidden && !open;
    const runs = runList
      .filter((x) => x.round_id === l.round_id)
      .map((x) => ({
        state: x.state as PrReviewRunState,
        durationMs: x.duration_ms === null ? null : Number(x.duration_ms),
        reviewer: hide ? null : (x.reviewer as PrReviewer),
        model: hide ? null : (x.model as string),
      }));
    return {
      ...blind,
      id: l.id as string,
      repoId: l.project_repo_id as string,
      repoName: l.name as string,
      changeId: l.change_id as string,
      url: l.url as string,
      title: l.title as string,
      author: (l.author as string | null) ?? null,
      openedAt: iso(l.opened_at) as string,
      state: l.review_state as PrReviewState,
      reviewedAt: iso(l.reviewed_at),
      size: sizeOf(l),
      split:
        l.review_state === 'needs_split'
          ? {
              reason: (l.split_reason as string | null) ?? 'over_budget',
              total: l.split_total === null ? null : Number(l.split_total),
              budget: l.split_budget === null ? null : Number(l.split_budget),
              unit: (l.split_unit as 'changed_lines' | 'changed_files' | null) ?? null,
              members: (l.split_members as Array<{ changeId: string; size: number }> | null) ?? [],
              at: iso(l.split_at),
              notice: l.notice_state
                ? {
                    state: l.notice_state as 'pending' | 'queued' | 'posted' | 'failed',
                    postedAt: iso(l.notice_posted_at),
                    url: (l.notice_url as string | null) ?? null,
                    error: (l.notice_error as string | null) ?? null,
                  }
                : null,
            }
          : null,
      attention: l.attention === 'timed_out_twice' ? ('timed_out_twice' as const) : null,
      reminder: reminders.get(l.id as string) ?? null,
      reviewerToken: tokens.get(l.project_repo_id as string) ?? null,
      queuePosition: queued.get(l.id as string)?.position ?? null,
      queueSlot: queued.get(l.id as string)?.slot ?? null,
      manualAction: viewer?.canTrigger ? manualActionOf(l) : null,
      lastRun: l.round_state
        ? {
            state: ROUND_STATE[l.round_state as string] ?? 'failed',
            startedAt: iso(l.started_at) as string,
            finishedAt: iso(l.finished_at),
            durationMs: l.duration_ms === null ? null : Number(l.duration_ms),
            timeoutMs: Number(l.timeout_ms),
            error: (l.error as string | null) ?? null,
            code: (l.end_code as string | null) ?? null,
            postedCount: Number(l.posted_count ?? 0),
            reviewUrl: (l.review_url as string | null) ?? null,
            trigger: (l.trigger as 'auto' | 'manual' | null) ?? 'auto',
            rerunOf: l.rerun_of_round_id
              ? { runId: l.rerun_of_round_id as string, startedAt: iso(l.rerun_of_started_at) ?? '' }
              : null,
            findingsCount: Number(l.findings_count ?? 0),
            heldBackCount: Number(l.held_back_count ?? 0),
            findingsCap:
              l.findings_cap === null || l.findings_cap === undefined ? null : Number(l.findings_cap),
            changedLines:
              l.changed_lines === null || l.changed_lines === undefined ? null : Number(l.changed_lines),
            runCount: ((l.reviewers as string[] | null) ?? []).length || runs.length,
            mergedCount: hide ? null : Number(l.merged_count ?? 0),
            runs,
          }
        : null,
    };
  });
}

/**
 * The findings the cap held back for a pull request's latest review round (the round the Pull requests tab shows), most
 * important first. No reviewer name. Findings merged into another are never listed. `undefined`: no such pull request.
 */
export async function heldBackFindings(
  db: Queryable,
  prReviewId: string,
): Promise<HeldBackFindingsResponse | undefined> {
  if (!(await one(db, 'SELECT id FROM pr_reviews WHERE id=$1', [prReviewId]))) return undefined;
  const latest = await one(
    db,
    `SELECT id, round_id FROM pr_review_runs WHERE pr_review_id=$1 AND replay_id IS NULL
      ORDER BY started_at DESC, reviewer LIMIT 1`,
    [prReviewId],
  );
  if (!latest) return { runId: null, findings: [] };
  const runs = latest.round_id
    ? await rows(db, 'SELECT id FROM pr_review_runs WHERE round_id=$1 ORDER BY started_at, reviewer', [
        latest.round_id,
      ])
    : [{ id: latest.id }];
  const list = await rows(
    db,
    `SELECT id, rank, severity, path, line, title, body FROM pr_review_findings
      WHERE run_id = ANY($1::uuid[]) AND disposition='held_back' ORDER BY rank NULLS LAST, idx`,
    [runs.map((r) => r.id as string)],
  );
  return {
    runId: (runs[0]?.id ?? latest.id) as string,
    findings: list.map((f) => ({
      id: f.id as string,
      rank: f.rank === null ? null : Number(f.rank),
      severity: f.severity as 'high' | 'medium' | 'low',
      path: f.path as string,
      line: f.line === null ? null : Number(f.line),
      title: f.title as string,
      body: f.body as string,
    })),
  };
}
