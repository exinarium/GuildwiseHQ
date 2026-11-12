import { randomUUID } from 'node:crypto';
import {
  GitRefSchema,
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
import { withAppendTx } from '../db/tx.ts';
import { listReviewablePrs, reviewerGate, reviewerTokenStates } from '../review/reviewer-gate.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, SYSTEM_ACTOR } from './common.ts';

/**
 * The first reviewer on PR-only pull requests. The server decides WHEN a run starts and is the only party that starts a
 * post, and only for a completed run. A run that times out or fails writes one event and nothing else: the pull request
 * stays `not_reviewed`, nothing is posted, nothing is restarted by itself, and no card, shift or transition is touched.
 */

/** A run still waiting past its limit plus this grace is timed out by the server (the runner or its answer is lost). */
export const RUN_GRACE_MS = 5 * 60_000;
/** A completed run whose post did not answer within this time is failed at the post stage. */
export const POST_WAIT_MS = 15 * 60_000;
/** A failed run that is retryable is started again by the dispatcher no sooner than this, at most MAX_RETRIES times. */
export const RETRY_AFTER_MS = 30 * 60_000;
export const MAX_RETRIES = 3;
const MAX_RUNNING_PER_REPO = 1;
const MAX_RUNNING_PER_WORKSTATION = 2;
/** GitHub refuses a review body over 65,536 characters. */
const BODY_LIMIT = 60_000;

const scopeOf = (orgId: string, projectId: string) => projectScope(orgId, projectId);

async function orgOf(db: Queryable, projectId: string): Promise<string | undefined> {
  return (await one(db, 'SELECT org_id FROM projects WHERE id=$1', [projectId]))?.org_id as
    | string
    | undefined;
}

// ---- dispatch ----------------------------------------------------------------------------------------------------

/**
 * The scheduler pass: for each active project with a PR-only repository, starts the first reviewer on the pull
 * requests `listReviewablePrs` returns (the gate: a comment-only token is held). One run per pull request: a timed-out
 * or model-error pull request is not started again by itself (the owner re-runs it by hand).
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
    const list = await listReviewablePrs(ctx.pool, p.id as string).catch((err) => {
      ctx.log.error({ err, projectId: p.id }, 'listing reviewable pull requests failed');
      return [];
    });
    for (const pr of list) {
      if (!(await mayStart(ctx.pool, pr.id, ctx.clock.now()))) continue;
      const ok = await startRun(ctx, p.id as string, pr).catch((err) => {
        ctx.log.error({ err, prReviewId: pr.id }, 'starting a pull request review failed');
        return false;
      });
      if (ok) started++;
    }
  }
  return started;
}

/** One run per pull request, except a failed run that may be repeated (see RETRY_AFTER_MS). */
async function mayStart(db: Queryable, prReviewId: string, now: Date): Promise<boolean> {
  const q = db;
  const runs = await rows(
    q,
    `SELECT state, error_code, retryable, finished_at FROM pr_review_runs
      WHERE pr_review_id=$1 AND reviewer='first' ORDER BY started_at DESC`,
    [prReviewId],
  );
  if (runs.length === 0) return true;
  const last = runs[0] as Record<string, unknown>;
  if (last.state !== 'failed') return false; // running, completed (posting), posted, timed out: never again by itself
  if (last.error_code === 'no_token') return true; // not an attempt: the gate decides when it is ready again
  const attempts = runs.filter(
    (r) => r.state === 'failed' && r.retryable && r.error_code !== 'no_token',
  ).length;
  if (!last.retryable || attempts >= MAX_RETRIES) return false;
  const at = last.finished_at ? new Date(last.finished_at as string).getTime() : 0;
  return now.getTime() - at >= RETRY_AFTER_MS;
}

async function startRun(
  ctx: Ctx,
  projectId: string,
  pr: {
    id: string;
    repoId: string;
    changeId: string;
    title: string;
    baseBranch: string;
    workstationIds: string[];
  },
): Promise<boolean> {
  const prNumber = Number(pr.changeId);
  const baseRef = GitRefSchema.safeParse(pr.baseBranch);
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !baseRef.success) return false;
  const model = REVIEWER_MODEL.first;
  const now = ctx.clock.now();
  let target: string | undefined;
  const started = await withAppendTx(ctx.pool, async (tx) => {
    // the pull request row is the lock: two passes never start two runs for it
    const row = await one(
      tx,
      `SELECT pr.id, pr.review_state, pr.closed_at, r.remote_url_normalized, r.pr_only
         FROM pr_reviews pr JOIN project_repos r ON r.id = pr.project_repo_id
        WHERE pr.id=$1 FOR UPDATE OF pr`,
      [pr.id],
    );
    if (!row || row.closed_at || row.review_state !== 'not_reviewed' || !row.pr_only) return false;
    if (!(await mayStart(tx, pr.id, now))) return false;
    // the gate again, right before the run goes out
    const gate = await reviewerGate(tx, pr.repoId);
    if (gate.state !== 'ready') return false;
    const capable = await rows(
      tx,
      `SELECT w.id, w.connected,
              (SELECT count(*)::int FROM pr_review_runs x WHERE x.workstation_id = w.id AND x.state='running') AS busy
         FROM workstations w JOIN workstation_capabilities wc ON wc.workstation_id = w.id
        WHERE w.id = ANY($1::uuid[]) AND $2 = ANY (wc.capabilities)`,
      [gate.workstationIds, PR_REVIEW_CAPABILITY],
    );
    const usable = gate.workstationIds.find((id) => {
      const w = capable.find((c) => c.id === id);
      return w?.connected && Number(w.busy) < MAX_RUNNING_PER_WORKSTATION;
    });
    if (!usable) return false;
    const busyRepo = await one(
      tx,
      `SELECT count(*)::int AS n FROM pr_review_runs x JOIN pr_reviews p2 ON p2.id = x.pr_review_id
        WHERE p2.project_repo_id=$1 AND x.state='running'`,
      [pr.repoId],
    );
    if (Number(busyRepo?.n ?? 0) >= MAX_RUNNING_PER_REPO) return false;
    const orgId = await orgOf(tx, projectId);
    if (!orgId) return false;
    const runId = randomUUID();
    const payload = PrReviewRunPayloadSchema.parse({
      runId,
      projectId,
      prReviewId: pr.id,
      projectRepoId: pr.repoId,
      remoteUrlNormalized: row.remote_url_normalized,
      prNumber,
      baseRef: baseRef.data,
      title: pr.title.slice(0, 300),
      reviewer: 'first',
      runtime: model.runtime,
      model: model.model,
      timeoutMs: PR_REVIEW_TIMEOUT_MS,
    });
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'PrReviewRunStarted' as const,
            payload: {
              projectId,
              repoId: pr.repoId,
              prReviewId: pr.id,
              runId,
              reviewer: 'first' as const,
              runtime: model.runtime,
              model: model.model,
              workstationId: usable,
              timeoutMs: PR_REVIEW_TIMEOUT_MS,
              at: now.toISOString(),
            },
          },
          actor: SYSTEM_ACTOR,
          scope: scopeOf(orgId, projectId),
        },
      ],
      { tx },
    );
    await enqueueRunnerCommand(
      tx,
      usable,
      'pr_review.run',
      payload,
      new Date(now.getTime() + PR_REVIEW_TIMEOUT_MS + RUN_GRACE_MS),
    );
    target = usable;
    return true;
  });
  if (started && target)
    void Promise.resolve(ctx.services.gateway.deliverPending(target)).catch(() => undefined);
  return started === true;
}

// ---- the findings the review posts -----------------------------------------------------------------------------

type StoredFinding = PrReviewFinding & { findingId: string };

/** GWP-198 replaces this: which of the run's findings are posted. Today: all of them. */
export function selectFindingsToPost<T>(findings: T[]): T[] {
  return findings;
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
    const findings: StoredFinding[] = r.findings.map((f) => ({ ...f, findingId: randomUUID() }));
    await emit('PrReviewRunCompleted', {
      ...base,
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
    await enqueueRunnerCommand(tx, postTo, 'pr_review.post', post, new Date(now.getTime() + POST_WAIT_MS));
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
         OR (state='completed' AND finished_at + $2 * interval '1 millisecond' < $3)`,
    [RUN_GRACE_MS, POST_WAIT_MS, now],
  );
  let n = 0;
  for (const s of stale) {
    const done = await withAppendTx(ctx.pool, async (tx) => {
      const run = await one(tx, 'SELECT * FROM pr_review_runs WHERE id=$1 FOR UPDATE', [s.id]);
      if (!run || run.state !== s.state) return false;
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

/** The recorded pull requests of a project's live repositories with their latest run, open ones first. */
export async function listPrReviews(db: Queryable, projectId: string): Promise<PrReviewDto[]> {
  const list = await rows(
    db,
    `SELECT pr.id, pr.project_repo_id, pr.change_id, pr.url, pr.title, pr.author, pr.opened_at, pr.review_state,
            pr.reviewed_at, pr.reviewed_by, pr.closed_at, r.remote_url_normalized, r.name,
            run.state AS run_state, run.started_at, run.finished_at, run.duration_ms, run.timeout_ms, run.error,
            run.error_code, run.review_url,
            (SELECT count(*)::int FROM pr_review_findings f WHERE f.run_id = run.id AND f.posted) AS posted_count
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
    reviewer: (l.reviewed_by as 'first' | null) ?? null,
    reviewerToken: tokens.get(l.project_repo_id as string) ?? null,
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
        }
      : null,
  }));
}
