import { randomUUID } from 'node:crypto';
import {
  GitRefSchema,
  type OrgRole,
  PR_REVIEW_CAPABILITY,
  PR_REVIEW_PAIR_CAPABILITY,
  PR_REVIEW_TIMEOUT_MS,
  PrReviewRunPayloadSchema,
  type PrReviewRunState,
  REVIEWER_MODEL,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { postAsFieldFor } from './commit-as.ts';
import { one } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { conflict } from '../errors.ts';
import { latestRecordedReplay } from '../queries/pr-replays.ts';
import { manualReviewAction } from '../review/manual-action.ts';
import { mayStart } from '../review/may-start.ts';
import { pickReviewerWorkstation, reviewerGate } from '../review/reviewer-gate.ts';
import { reviewersFor } from '../review/reviewers-for.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, SYSTEM_ACTOR, userActor } from './common.ts';
import { requireSpendOwner } from './pr-review-cap.ts';

/**
 * Review rounds (GWP-204). A round is the unit one review is made of: one reviewer run (the first reviewer) or two (the
 * first and the second reviewer, Opus), started together on one workstation. The server waits for every run, merges
 * their findings and posts once; one timeout or failure ends the whole round with nothing posted.
 */

/** A run still waiting past its limit plus this grace is timed out by the server (the runner or its answer is lost). */
export const RUN_GRACE_MS = 5 * 60_000;
export const MAX_RUNNING_PER_REPO = 1;

export { reviewersFor };

// ---- the switch ------------------------------------------------------------------------------------------------

/**
 * The owner switches the second reviewer on or off for live PR-only pull requests. Switching it on needs a recorded
 * replay (409 `replay_required`) and a PR-only repository (409 `no_pr_only_repo`); switching it off is always allowed.
 * A round that is running keeps the reviewers it started with. No event when nothing changes.
 */
export async function setSecondReviewer(
  ctx: Ctx,
  user: { id: string },
  org: { id: string; role: OrgRole | null },
  projectId: string,
  enabled: boolean,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await requireSpendOwner(tx, user, org, projectId);
    const row = await one(tx, 'SELECT pr_review_second_reviewer FROM projects WHERE id=$1 FOR UPDATE', [
      projectId,
    ]);
    let replayId: string | null = null;
    if (enabled) {
      const repo = await one(
        tx,
        'SELECT 1 AS x FROM project_repos WHERE project_id=$1 AND pr_only AND removed_at IS NULL LIMIT 1',
        [projectId],
      );
      if (!repo)
        throw conflict(
          'no_pr_only_repo',
          'the second reviewer reviews PR-only repositories; this project has none',
        );
      const replay = await latestRecordedReplay(tx, projectId);
      if (!replay)
        throw conflict(
          'replay_required',
          'record a 20-PR replay for this project before switching on the second reviewer',
        );
      replayId = replay.id;
    }
    if (Boolean(row?.pr_review_second_reviewer) === enabled) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectSecondReviewerSet', payload: { projectId, enabled, by: user.id, replayId } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

// ---- starting a round ------------------------------------------------------------------------------------------

export type StartResult =
  | { started: true; target: string; roundId: string; runIds: string[] }
  | {
      started: false;
      reason: 'gone' | 'not_eligible' | 'running' | 'closed' | 'not_ready' | 'concurrency' | 'stale';
      detail?: string;
    };

/**
 * The only place a review starts. Inside the caller's transaction: locks the pull request row, appends
 * `PrReviewRoundStarted` and, per reviewer of the round, `PrReviewRunStarted` and a queued `pr_review.run` on ONE
 * workstation. `auto` (the dispatcher) checks `mayStart` and the concurrency limits; `manual` (the owner) checks neither
 * the cap nor the concurrency limits. A pair never falls back to one reviewer: a workstation without
 * `pr-review-pair:1` is `runner_outdated`. The caller delivers the commands after the commit.
 */
export async function startPrReviewRound(
  ctx: Ctx,
  tx: Tx,
  input: {
    projectId: string;
    prReviewId: string;
    trigger: 'auto' | 'manual';
    requestedBy: string | null;
    enforceConcurrency: boolean;
    /** Manual only: the timed-out review the page showed. A different latest review means the page is out of date. */
    expectedPreviousRunId?: string;
  },
): Promise<StartResult> {
  const now = ctx.clock.now();
  // the pull request row is the lock: two passes never start two rounds for it
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
  let rerunOfRunId: string | null = null;
  if (input.trigger === 'auto') {
    if (!(await mayStart(tx, input.prReviewId))) return { started: false, reason: 'not_eligible' };
  } else {
    const last = await one(
      tx,
      `SELECT id, state FROM pr_review_rounds WHERE pr_review_id=$1 ORDER BY started_at DESC LIMIT 1`,
      [input.prReviewId],
    );
    const action = manualReviewAction({
      reviewState: 'not_reviewed',
      closed: false,
      prOnly: true,
      lastRun: last
        ? {
            id: last.id as string,
            state: last.state === 'posting' ? 'completed' : (last.state as PrReviewRunState),
          }
        : null,
    });
    if ('refused' in action) return { started: false, reason: action.refused };
    if (input.expectedPreviousRunId && input.expectedPreviousRunId !== action.previousRunId)
      return { started: false, reason: 'stale' };
    rerunOfRunId = action.previousRunId;
  }
  const repoId = row.project_repo_id as string;
  const prNumber = Number(row.change_id);
  const baseRef = GitRefSchema.safeParse(row.base_branch);
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !baseRef.success)
    return { started: false, reason: 'not_eligible' };
  // the gate again, right before the round goes out
  const gate = await reviewerGate(tx, repoId);
  if (gate.state !== 'ready')
    return { started: false, reason: 'not_ready', detail: 'reviewer_token_missing' };
  const reviewers = await reviewersFor(tx, input.projectId);
  const pair = reviewers.length > 1;
  const pick = await pickReviewerWorkstation(tx, gate, {
    ignoreBusy: !input.enforceConcurrency,
    capabilities: pair ? [PR_REVIEW_CAPABILITY, PR_REVIEW_PAIR_CAPABILITY] : [PR_REVIEW_CAPABILITY],
    slots: reviewers.length,
  });
  if ('blocked' in pick) return { started: false, reason: 'not_ready', detail: pick.blocked };
  if ('busy' in pick) return { started: false, reason: 'concurrency' };
  if (input.enforceConcurrency) {
    const busyRepo = await one(
      tx,
      `SELECT count(*)::int AS n FROM pr_review_rounds x JOIN pr_reviews p2 ON p2.id = x.pr_review_id
        WHERE p2.project_repo_id=$1 AND x.state='running'
          AND EXISTS (SELECT 1 FROM pr_review_runs r WHERE r.round_id = x.id AND r.state='running')`,
      [repoId],
    );
    if (Number(busyRepo?.n ?? 0) >= MAX_RUNNING_PER_REPO) return { started: false, reason: 'concurrency' };
  }
  const org = await one(tx, 'SELECT org_id FROM projects WHERE id=$1', [input.projectId]);
  if (!org) return { started: false, reason: 'gone' };
  const scope = projectScope(org.org_id as string, input.projectId);
  const at = now.toISOString();
  // a round of one is its run: the posting id (and marker) is the run id, as before rounds. A pair gets an id of its own.
  const soloRunId = pair ? undefined : randomUUID();
  const roundId = soloRunId ?? randomUUID();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [
    {
      type: 'PrReviewRoundStarted',
      payload: {
        projectId: input.projectId,
        prReviewId: input.prReviewId,
        roundId,
        reviewers,
        trigger: input.trigger,
        requestedBy: input.requestedBy,
        workstationId: pick.id,
        at,
      },
    },
  ];
  const runs = reviewers.map((reviewer) => {
    const model = REVIEWER_MODEL[reviewer];
    const runId = soloRunId ?? randomUUID();
    events.push({
      type: 'PrReviewRunStarted',
      payload: {
        projectId: input.projectId,
        repoId,
        prReviewId: input.prReviewId,
        runId,
        roundId,
        reviewer,
        runtime: model.runtime,
        model: model.model,
        workstationId: pick.id,
        timeoutMs: PR_REVIEW_TIMEOUT_MS,
        trigger: input.trigger,
        requestedBy: input.requestedBy,
        rerunOfRunId,
        at,
      },
    });
    return {
      runId,
      payload: PrReviewRunPayloadSchema.parse({
        runId,
        projectId: input.projectId,
        prReviewId: input.prReviewId,
        projectRepoId: repoId,
        remoteUrlNormalized: row.remote_url_normalized,
        prNumber,
        baseRef: baseRef.data,
        title: String(row.title).slice(0, 300),
        reviewer,
        runtime: model.runtime,
        model: model.model,
        timeoutMs: PR_REVIEW_TIMEOUT_MS,
      }),
    };
  });
  await ctx.store.append(
    events.map((event) => ({
      streamId: streamId.project(input.projectId),
      event: event as never,
      actor: SYSTEM_ACTOR,
      scope,
    })),
    { tx },
  );
  const postAs = await postAsFieldFor(tx, input.projectId, pick.id, { write: false });
  for (const r of runs)
    await enqueueRunnerCommand(
      tx,
      pick.id,
      'pr_review.run',
      { ...r.payload, ...postAs },
      new Date(now.getTime() + PR_REVIEW_TIMEOUT_MS + RUN_GRACE_MS),
    );
  return { started: true, target: pick.id, roundId, runIds: runs.map((r) => r.runId) };
}
