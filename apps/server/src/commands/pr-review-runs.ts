import { randomUUID } from 'node:crypto';
import {
  applyFindingsCap,
  type FindingDisposition,
  GitRefSchema,
  type HeldBackFindingsResponse,
  type OrgRole,
  PR_REVIEW_CAPABILITY,
  PR_REVIEW_TIMEOUT_MS,
  type PrReviewDto,
  type PrReviewFinding,
  type PrReviewPostPayload,
  PrReviewPostResultSchema,
  PrReviewRunPayloadSchema,
  PrReviewRunResultSchema,
  prReviewMarker,
  REVIEWER_MODEL,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict, notFound } from '../errors.ts';
import { mayStart } from '../review/may-start.ts';
import {
  MAX_RUNNING_PER_WORKSTATION,
  pickReviewerWorkstation,
  reviewerGate,
  reviewerTokenStates,
} from '../review/reviewer-gate.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, SYSTEM_ACTOR } from './common.ts';
import { prReviewQueue, requireSpendOwner } from './pr-review-cap.ts';
import { applyReplayRunResult, timeOutReplayRun } from './pr-replays.ts';

/**
 * The first reviewer on PR-only pull requests. The server decides WHEN a run starts and is the only party that starts a
 * post, and only for a completed run. A run that times out or fails writes one event and nothing else: the pull request
 * stays `not_reviewed`, nothing is posted, nothing is restarted by itself, and no card, shift or transition is touched.
 */

/** A run still waiting past its limit plus this grace is timed out by the server (the runner or its answer is lost). */
export const RUN_GRACE_MS = 5 * 60_000;
/** A completed run whose post did not answer within this time is failed at the post stage. */
export const POST_WAIT_MS = 15 * 60_000;
const MAX_RUNNING_PER_REPO = 1;
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
      const r = await startPrReviewRun(ctx, tx, {
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

export type StartResult =
  | { started: true; target: string; runId: string }
  | {
      started: false;
      reason: 'gone' | 'not_eligible' | 'running' | 'closed' | 'not_ready' | 'concurrency';
      detail?: string;
    };

/**
 * The only place a reviewer run starts. Inside the caller's transaction: locks the pull request row, appends
 * `PrReviewRunStarted` and queues `pr_review.run` on the workstation. `auto` (the dispatcher) checks `mayStart` and the
 * concurrency limits; `manual` (the owner) checks neither the cap nor the concurrency limits. The caller delivers the
 * command after the commit.
 */
export async function startPrReviewRun(
  ctx: Ctx,
  tx: Tx,
  input: {
    projectId: string;
    prReviewId: string;
    trigger: 'auto' | 'manual';
    requestedBy: string | null;
    enforceConcurrency: boolean;
  },
): Promise<StartResult> {
  const model = REVIEWER_MODEL.first;
  const now = ctx.clock.now();
  // the pull request row is the lock: two passes never start two runs for it
  const row = await one(
    tx,
    `SELECT pr.id, pr.project_repo_id, pr.change_id, pr.title, pr.base_branch, pr.review_state, pr.closed_at,
            r.remote_url_normalized, r.pr_only
       FROM pr_reviews pr JOIN project_repos r ON r.id = pr.project_repo_id
      WHERE pr.id=$1 AND pr.project_id=$2 FOR UPDATE OF pr`,
    [input.prReviewId, input.projectId],
  );
  if (!row) return { started: false, reason: 'gone' };
  if (row.closed_at) return { started: false, reason: 'closed' };
  if (row.review_state !== 'not_reviewed' || !row.pr_only) return { started: false, reason: 'not_eligible' };
  if (input.trigger === 'auto') {
    if (!(await mayStart(tx, input.prReviewId))) return { started: false, reason: 'not_eligible' };
  } else {
    const live = await one(
      tx,
      `SELECT 1 AS x FROM pr_review_runs WHERE pr_review_id=$1 AND state IN ('running','completed')`,
      [input.prReviewId],
    );
    if (live) return { started: false, reason: 'running' };
  }
  const repoId = row.project_repo_id as string;
  const prNumber = Number(row.change_id);
  const baseRef = GitRefSchema.safeParse(row.base_branch);
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !baseRef.success)
    return { started: false, reason: 'not_eligible' };
  // the gate again, right before the run goes out
  const gate = await reviewerGate(tx, repoId);
  if (gate.state !== 'ready')
    return { started: false, reason: 'not_ready', detail: 'reviewer_token_missing' };
  const pick = await pickReviewerWorkstation(tx, gate, { ignoreBusy: !input.enforceConcurrency });
  if ('blocked' in pick) return { started: false, reason: 'not_ready', detail: pick.blocked };
  if ('busy' in pick) return { started: false, reason: 'concurrency' };
  if (input.enforceConcurrency) {
    const busyRepo = await one(
      tx,
      `SELECT count(*)::int AS n FROM pr_review_runs x JOIN pr_reviews p2 ON p2.id = x.pr_review_id
        WHERE p2.project_repo_id=$1 AND x.state='running'`,
      [repoId],
    );
    if (Number(busyRepo?.n ?? 0) >= MAX_RUNNING_PER_REPO) return { started: false, reason: 'concurrency' };
  }
  const orgId = await orgOf(tx, input.projectId);
  if (!orgId) return { started: false, reason: 'gone' };
  const runId = randomUUID();
  const payload = PrReviewRunPayloadSchema.parse({
    runId,
    projectId: input.projectId,
    prReviewId: input.prReviewId,
    projectRepoId: repoId,
    remoteUrlNormalized: row.remote_url_normalized,
    prNumber,
    baseRef: baseRef.data,
    title: String(row.title).slice(0, 300),
    reviewer: 'first',
    runtime: model.runtime,
    model: model.model,
    timeoutMs: PR_REVIEW_TIMEOUT_MS,
  });
  await ctx.store.append(
    [
      {
        streamId: streamId.project(input.projectId),
        event: {
          type: 'PrReviewRunStarted' as const,
          payload: {
            projectId: input.projectId,
            repoId,
            prReviewId: input.prReviewId,
            runId,
            reviewer: 'first' as const,
            runtime: model.runtime,
            model: model.model,
            workstationId: pick.id,
            timeoutMs: PR_REVIEW_TIMEOUT_MS,
            trigger: input.trigger,
            requestedBy: input.requestedBy,
            at: now.toISOString(),
          },
        },
        actor: SYSTEM_ACTOR,
        scope: scopeOf(orgId, input.projectId),
      },
    ],
    { tx },
  );
  await enqueueRunnerCommand(
    tx,
    pick.id,
    'pr_review.run',
    payload,
    new Date(now.getTime() + PR_REVIEW_TIMEOUT_MS + RUN_GRACE_MS),
  );
  return { started: true, target: pick.id, runId };
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
): Promise<PrReviewDto> {
  let target: string | undefined;
  await withAppendTx(ctx.pool, async (tx) => {
    await requireSpendOwner(tx, user, org, projectId);
    await one(tx, 'SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    const r = await startPrReviewRun(ctx, tx, {
      projectId,
      prReviewId,
      trigger: 'manual',
      requestedBy: user.id,
      enforceConcurrency: false,
    });
    if (r.started) {
      target = r.target;
      return;
    }
    if (r.reason === 'gone') throw notFound('pull request not found');
    if (r.reason === 'closed') throw conflict('pr_closed', 'this pull request is closed');
    if (r.reason === 'running') throw conflict('review_running', 'a review of this pull request is running');
    if (r.reason === 'not_ready')
      throw conflict('reviewer_not_ready', 'no reviewer workstation is ready for this repository', {
        reason: r.detail,
      });
    throw conflict('not_reviewable', 'this pull request cannot be reviewed now');
  });
  if (target) void Promise.resolve(ctx.services.gateway.deliverPending(target)).catch(() => undefined);
  const list = await listPrReviews(ctx.pool, projectId, ctx);
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

/** The findings that go to the pull request: everything the cap did not hold back (no disposition counts as posted). */
export function selectFindingsToPost<T extends { disposition?: FindingDisposition }>(findings: T[]): T[] {
  return findings.filter((f) => f.disposition !== 'held_back');
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

/**
 * `command.result` of `pr_review.run`. A result for a run that is no longer `running` (a duplicate after a requeue, or an
 * answer after the server gave the run up) is ignored. `completed` stores the findings and sends the post to the same
 * workstation (it holds the token). A timeout or a failure records one event and does nothing else.
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
  let postTo: string | undefined;
  await withAppendTx(ctx.pool, async (tx) => {
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
    const orgId = await orgOf(tx, p.projectId);
    if (!orgId) return;
    const scope = scopeOf(orgId, p.projectId);
    const at = now.toISOString();
    const base = { projectId: p.projectId, prReviewId: p.prReviewId, runId: p.runId, at };
    const emit = (type: string, payload2: Record<string, unknown>) =>
      ctx.store.append(
        [
          {
            streamId: streamId.project(p.projectId),
            event: { type, payload: payload2 } as never,
            actor: SYSTEM_ACTOR,
            scope,
          },
        ],
        { tx },
      );
    const r = ok && parsed.success ? parsed.data : undefined;
    if (!r) {
      await emit('PrReviewRunFailed', {
        ...base,
        stage: 'run',
        code: 'error',
        error: (error ?? 'the workstation did not answer the review properly').slice(0, 400),
        retryable: true,
      });
      return;
    }
    if (r.outcome === 'timeout') {
      await emit('PrReviewRunTimedOut', { ...base, durationMs: r.durationMs, phase: r.phase, by: 'runner' });
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
      return;
    }
    // the cap is decided here, from the runner's line count; held-back findings are stored and never sent to the poster
    const { cap, ordered } = applyFindingsCap(r.findings, r.changedLines);
    if (r.changedLines === undefined)
      ctx.log.info({ runId: p.runId }, 'no changed-line count from the runner; findings cap 5');
    const findings: StoredFinding[] = ordered.map((f) => ({ ...f, findingId: randomUUID() }));
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
    const post = buildReviewPost(
      { runId: p.runId, summary: r.summary, headSha: r.headSha, baseSha: r.baseSha },
      {
        projectId: p.projectId,
        projectRepoId: p.projectRepoId,
        remoteUrlNormalized: p.remoteUrlNormalized,
        prNumber: p.prNumber,
        baseRef: p.baseRef,
      },
      findings,
    );
    postTo = run.workstation_id as string;
    await enqueueReviewPost(tx, run, postTo, post, new Date(now.getTime() + POST_WAIT_MS));
  });
  if (postTo) void Promise.resolve(ctx.services.gateway.deliverPending(postTo)).catch(() => undefined);
}

/**
 * `command.result` of `pr_review.post`. The pull request becomes `reviewed` only now, when the comments exist on the git
 * host: also when the run had already been given up at the post stage (the review is there). A failed post keeps it
 * `not_reviewed` and keeps the error for the owner.
 */
export async function applyPrReviewPostResult(
  ctx: Ctx,
  commandPayload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const runId = typeof commandPayload.runId === 'string' ? commandPayload.runId : '';
  const ids = Array.isArray(commandPayload.findings)
    ? (commandPayload.findings as Array<{ findingId?: unknown }>).flatMap((f) =>
        typeof f.findingId === 'string' ? [f.findingId] : [],
      )
    : [];
  const parsed = PrReviewPostResultSchema.safeParse(result);
  const at = ctx.clock.now().toISOString();
  await withAppendTx(ctx.pool, async (tx) => {
    const run = await one(tx, 'SELECT * FROM pr_review_runs WHERE id=$1 FOR UPDATE', [runId]);
    if (!run || run.state === 'posted') return;
    if (run.replay_id) {
      ctx.log.warn({ runId }, 'ignored a post result for a replay run');
      return;
    }
    const projectId = run.project_id as string;
    const orgId = await orgOf(tx, projectId);
    if (!orgId) return;
    const base = { projectId, prReviewId: run.pr_review_id as string, runId, at };
    const r = ok && parsed.success ? parsed.data : undefined;
    const emit = (type: string, payload: Record<string, unknown>) =>
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
    if (r?.ok) {
      await emit('PrReviewPosted', {
        ...base,
        reviewer: run.reviewer,
        reviewUrl: r.reviewUrl,
        postedFindingIds: ids,
      });
      return;
    }
    if (run.state !== 'completed') return; // timed out or failed already: nothing more to say
    const code = r && !r.ok ? r.code : 'error';
    await emit('PrReviewRunFailed', {
      ...base,
      stage: 'post',
      code,
      error: (r && !r.ok ? r.error : (error ?? 'the workstation did not answer the post properly')).slice(
        0,
        400,
      ),
      retryable: code === 'unreachable' || code === 'error',
    });
  });
}

// ---- backstop --------------------------------------------------------------------------------------------------

/**
 * The scheduler pass that gives up on lost work: a run still `running` past its limit plus a grace is timed out by the
 * server (its late answer is then ignored); a completed run whose post never answered fails at the post stage.
 */
export async function sweepStalePrReviewRuns(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  const stale = await rows(
    ctx.pool,
    `SELECT id, state FROM pr_review_runs
      WHERE (state='running' AND started_at + (timeout_ms + $1) * interval '1 millisecond' < $3)
         OR (state='completed' AND replay_id IS NULL AND finished_at + $2 * interval '1 millisecond' < $3)`,
    [RUN_GRACE_MS, POST_WAIT_MS, now],
  );
  let n = 0;
  for (const s of stale) {
    const done = await withAppendTx(ctx.pool, async (tx) => {
      const run = await one(tx, 'SELECT * FROM pr_review_runs WHERE id=$1 FOR UPDATE', [s.id]);
      if (!run || run.state !== s.state) return false;
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
      const base = {
        projectId,
        prReviewId: run.pr_review_id as string,
        runId: run.id as string,
        at: now.toISOString(),
      };
      const event =
        run.state === 'running'
          ? {
              type: 'PrReviewRunTimedOut',
              payload: {
                ...base,
                durationMs: Math.max(0, now.getTime() - new Date(run.started_at as string).getTime()),
                phase: 'review',
                by: 'server',
              },
            }
          : {
              type: 'PrReviewRunFailed',
              payload: {
                ...base,
                stage: 'post',
                code: 'error',
                error: 'posting did not finish',
                retryable: false,
              },
            };
      await ctx.store.append(
        [
          {
            streamId: streamId.project(projectId),
            event: event as never,
            actor: SYSTEM_ACTOR,
            scope: scopeOf(orgId, projectId),
          },
        ],
        { tx },
      );
      // the command may still wait for an offline workstation: it must not run later
      await exec(
        tx,
        `UPDATE runner_commands SET status='failed', last_error='superseded'
          WHERE type = ANY ($2::text[]) AND status IN ('pending','sent') AND payload->>'runId' = $1`,
        [run.id, ['pr_review.run', 'pr_review.post']],
      );
      return true;
    });
    if (done) n++;
  }
  return n;
}

// ---- what the owner sees ---------------------------------------------------------------------------------------

/** Blind marking: the reviewer is withheld while the pull request has posted findings the owner has not marked. */
function blindReviewer(l: Record<string, unknown>) {
  const unmarkedCount = Number(l.unmarked_count ?? 0);
  const reviewersHidden = unmarkedCount > 0;
  return {
    reviewer: reviewersHidden ? null : ((l.reviewed_by as 'first' | null) ?? null),
    reviewersHidden,
    unmarkedCount,
  };
}

/** The recorded pull requests of a project's live repositories with their latest run, open ones first. */
export async function listPrReviews(
  db: Queryable,
  projectId: string,
  ctx?: Pick<Ctx, 'clock'>,
): Promise<PrReviewDto[]> {
  const queue = ctx ? await prReviewQueue(db, ctx, projectId) : undefined;
  const queued = new Map((queue?.items ?? []).map((q) => [q.prReviewId, q]));
  const list = await rows(
    db,
    `SELECT pr.id, pr.project_repo_id, pr.change_id, pr.url, pr.title, pr.author, pr.opened_at, pr.review_state,
            pr.reviewed_at, pr.reviewed_by, pr.closed_at, r.remote_url_normalized, r.name,
            run.state AS run_state, run.started_at, run.finished_at, run.duration_ms, run.timeout_ms, run.error,
            run.error_code, run.review_url, run.trigger,
            (SELECT count(*)::int FROM pr_review_findings f WHERE f.run_id = run.id AND f.posted) AS posted_count,
            (SELECT count(*)::int FROM pr_review_findings f WHERE f.run_id = run.id) AS findings_count,
            run.held_back_count, run.findings_cap, run.changed_lines,
            (SELECT count(*)::int FROM pr_review_findings f
               LEFT JOIN pr_review_finding_marks m ON m.finding_id = f.id
              WHERE f.pr_review_id = pr.id AND f.posted AND m.finding_id IS NULL) AS unmarked_count
       FROM pr_reviews pr
       JOIN project_repos r ON r.id = pr.project_repo_id AND r.removed_at IS NULL
       LEFT JOIN pr_review_runs run ON run.id = (
              SELECT x.id FROM pr_review_runs x WHERE x.pr_review_id = pr.id ORDER BY x.started_at DESC LIMIT 1)
      WHERE pr.project_id=$1
      ORDER BY (pr.closed_at IS NULL) DESC, pr.opened_at DESC, pr.change_id DESC
      LIMIT 200`,
    [projectId],
  );
  const tokens = await reviewerTokenStates(db, [...new Set(list.map((l) => l.project_repo_id as string))]);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return list.map((l) => ({
    ...blindReviewer(l),
    id: l.id as string,
    repoId: l.project_repo_id as string,
    repoName: l.name as string,
    changeId: l.change_id as string,
    url: l.url as string,
    title: l.title as string,
    author: (l.author as string | null) ?? null,
    openedAt: iso(l.opened_at) as string,
    state: l.review_state as 'not_reviewed' | 'reviewed',
    reviewedAt: iso(l.reviewed_at),
    reviewerToken: tokens.get(l.project_repo_id as string) ?? null,
    queuePosition: queued.get(l.id as string)?.position ?? null,
    queueSlot: queued.get(l.id as string)?.slot ?? null,
    lastRun: l.run_state
      ? {
          state: l.run_state as 'running' | 'completed' | 'posted' | 'timed_out' | 'failed',
          startedAt: iso(l.started_at) as string,
          finishedAt: iso(l.finished_at),
          durationMs: l.duration_ms === null ? null : Number(l.duration_ms),
          timeoutMs: Number(l.timeout_ms),
          error: (l.error as string | null) ?? null,
          code: (l.error_code as string | null) ?? null,
          postedCount: Number(l.posted_count ?? 0),
          reviewUrl: (l.review_url as string | null) ?? null,
          trigger: (l.trigger as 'auto' | 'manual' | null) ?? 'auto',
          findingsCount: Number(l.findings_count ?? 0),
          heldBackCount: Number(l.held_back_count ?? 0),
          findingsCap:
            l.findings_cap === null || l.findings_cap === undefined ? null : Number(l.findings_cap),
          changedLines:
            l.changed_lines === null || l.changed_lines === undefined ? null : Number(l.changed_lines),
        }
      : null,
  }));
}

/**
 * The findings the cap held back for a pull request's latest run (the run the Pull requests tab shows), most important
 * first. No reviewer name. `undefined`: no such pull request.
 */
export async function heldBackFindings(
  db: Queryable,
  prReviewId: string,
): Promise<HeldBackFindingsResponse | undefined> {
  if (!(await one(db, 'SELECT id FROM pr_reviews WHERE id=$1', [prReviewId]))) return undefined;
  const run = await one(
    db,
    'SELECT id FROM pr_review_runs WHERE pr_review_id=$1 ORDER BY started_at DESC LIMIT 1',
    [prReviewId],
  );
  if (!run) return { runId: null, findings: [] };
  const list = await rows(
    db,
    `SELECT id, rank, severity, path, line, title, body FROM pr_review_findings
      WHERE run_id=$1 AND disposition='held_back' ORDER BY rank NULLS LAST, idx`,
    [run.id],
  );
  return {
    runId: run.id as string,
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
