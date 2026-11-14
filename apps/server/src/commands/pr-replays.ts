import { randomUUID } from 'node:crypto';
import {
  applyFindingsCap,
  type FindingDisposition,
  type FindingMark,
  GitRefSchema,
  type MarkFindingRequest,
  PR_LIST_CAPABILITY,
  PR_REVIEW_CAPABILITY,
  PR_REVIEW_TIMEOUT_MS,
  type PrReviewer,
  PrReviewRunPayloadSchema,
  type PrReviewRunResult,
  REPLAY_CAPABILITY,
  REPLAY_LIST_LIMIT,
  REPLAY_MAX_ATTEMPTS,
  REPLAY_PR_COUNT,
  REPLAY_REVIEWERS,
  type ReplayDto,
  type ReplayFailureReason,
  RepoListMergedPrsResultSchema,
  REVIEWER_MODEL,
  replayResult,
  type SetReviewTargetsRequest,
  streamId,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject, requireProjectMember } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import type { Tx } from '../db/tx.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { getReplayDto, replayFindingStep } from '../queries/pr-replays.ts';
import { listReviewablePrs } from '../review/reviewer-gate.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * The 20-PR replay. Nothing here ever posts: replay runs are answered through `applyReplayRunResult`, which has no
 * path to `pr_review.post`.
 */

const LIST_WAIT_MS = 5 * 60_000;
const RUN_GRACE_MS = 5 * 60_000;
const RETRY_AFTER_MS = 30 * 60_000;
const SHOWN_THROTTLE_MS = 5_000;

type Emit = (replayId: string, type: string, payload: Record<string, unknown>) => Promise<unknown>;

async function replayScope(db: Queryable, projectId: string) {
  const p = await one(db, 'SELECT org_id FROM projects WHERE id=$1', [projectId]);
  return projectScope(p?.org_id as string, projectId);
}

function emitter(
  ctx: Ctx,
  tx: Tx,
  scope: ReturnType<typeof projectScope>,
  actor: ReturnType<typeof userActor> | typeof SYSTEM_ACTOR = SYSTEM_ACTOR,
): Emit {
  return (replayId, type, payload) =>
    ctx.store.append(
      [
        {
          streamId: streamId.prReplay(replayId),
          event: { type, payload: { replayId, ...payload, at: ctx.clock.now().toISOString() } } as never,
          actor,
          scope,
        },
      ],
      { tx },
    );
}

// ---- start -------------------------------------------------------------------------------------------------------

export async function startReplay(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: { repoId: string },
): Promise<ReplayDto> {
  let deliverTo: string | undefined;
  const replayId = randomUUID();
  await withAppendTx(ctx.pool, async (tx) => {
    const project = await loadVisibleProject(tx, user.id, projectId);
    if (project.my_role !== 'owner') throw forbidden('only the project owner can start a replay');
    await one(tx, 'SELECT id FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
    const org = await one(tx, 'SELECT simulation FROM organizations WHERE id=$1', [project.org_id]);
    if (org?.simulation) throw conflict('simulation', 'a replay does not run in a simulation organization');
    const repo = await one(
      tx,
      `SELECT id, remote_url_normalized, forge_kind, pr_only FROM project_repos
        WHERE id=$1 AND project_id=$2 AND removed_at IS NULL`,
      [req.repoId, projectId],
    );
    if (!repo || !repo.pr_only)
      throw conflict('repo_not_pr_only', 'the replay needs a repository that is switched to PR-only');
    const active = await one(
      tx,
      `SELECT id FROM pr_replays WHERE project_id=$1 AND state IN ('listing','reviewing','marking')`,
      [projectId],
    );
    if (active) throw conflict('replay_active', 'a replay is already running for this project');
    const ws = await one(
      tx,
      `SELECT w.id FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
         JOIN workstation_capabilities wc ON wc.workstation_id = w.id
        WHERE wr.project_repo_id=$1 AND w.status='active'
          AND $2 = ANY (wc.capabilities) AND $3 = ANY (wc.capabilities) AND $4 = ANY (wc.capabilities)
        ORDER BY w.connected DESC, (w.user_id = $5::uuid) DESC, w.last_seen_at DESC NULLS LAST LIMIT 1`,
      [req.repoId, REPLAY_CAPABILITY, PR_REVIEW_CAPABILITY, PR_LIST_CAPABILITY, user.id],
    );
    const requestId = randomUUID();
    const emit = emitter(ctx, tx, projectScope(project.org_id as string, projectId), userActor(user.id));
    await emit(replayId, 'PrReplayStarted', {
      projectId,
      repoId: req.repoId,
      requestId,
      workstationId: ws?.id ?? null,
      by: user.id,
    });
    if (!ws) {
      await emit(replayId, 'PrReplayFailed', { reason: 'no_workstation' });
      return;
    }
    await enqueueRunnerCommand(
      tx,
      ws.id as string,
      'repo.list_merged_prs',
      {
        requestId,
        replayId,
        repoId: req.repoId,
        remoteUrlNormalized: repo.remote_url_normalized,
        ...(repo.forge_kind ? { forge: repo.forge_kind } : {}),
        limit: REPLAY_LIST_LIMIT,
      },
      new Date(ctx.clock.now().getTime() + LIST_WAIT_MS),
    );
    deliverTo = ws.id as string;
  });
  if (deliverTo) void Promise.resolve(ctx.services.gateway.deliverPending(deliverTo)).catch(() => undefined);
  const dto = await getReplayDto(ctx.pool, replayId, true);
  if (!dto) throw notFound('replay not found');
  return dto;
}

/** `command.result` of `repo.list_merged_prs`. */
export async function applyMergedPrList(
  ctx: Ctx,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const replayId = String(payload.replayId ?? '');
  const requestId = String(payload.requestId ?? '');
  const parsed = RepoListMergedPrsResultSchema.safeParse(result);
  await withAppendTx(ctx.pool, async (tx) => {
    const rp = await one(tx, 'SELECT * FROM pr_replays WHERE id=$1 FOR UPDATE', [replayId]);
    if (!rp || rp.state !== 'listing' || rp.request_id !== requestId) return;
    const projectId = rp.project_id as string;
    const emit = emitter(ctx, tx, await replayScope(tx, projectId));
    const fail = (reason: ReplayFailureReason, extra: Record<string, unknown> = {}) =>
      emit(replayId, 'PrReplayFailed', { reason, ...extra });
    if (!ok || !parsed.success) {
      await fail('error', { detail: (error ?? 'the workstation did not answer properly').slice(0, 400) });
      return;
    }
    const r = parsed.data;
    if (!r.ok) {
      await fail(r.reason === 'no_clone' ? 'no_workstation' : r.reason, r.error ? { detail: r.error } : {});
      return;
    }
    const cardBranches = new Set(
      (
        await rows(
          tx,
          'SELECT branch_name FROM cards WHERE project_id=$1 AND branch_name IS NOT NULL',
          [projectId],
        )
      ).map((c) => c.branch_name as string),
    );
    const seen = new Set<string>();
    const usable = r.changes
      .filter((c) => !cardBranches.has(c.head))
      .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
      .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
    if (usable.length < REPLAY_PR_COUNT) {
      await fail('not_enough_prs', { found: usable.length });
      return;
    }
    await emit(replayId, 'PrReplayPrsSelected', {
      prs: usable.slice(0, REPLAY_PR_COUNT).map((c, idx) => ({
        replayPrId: randomUUID(),
        idx,
        changeId: c.id,
        url: c.url,
        title: c.title,
        author: c.author,
        headBranch: c.head,
        baseBranch: c.base,
        headSha: c.headSha,
        mergeCommitSha: c.mergeCommitSha,
        mergedAt: c.mergedAt,
        additions: c.additions,
        deletions: c.deletions,
      })),
    });
  });
}

// ---- dispatch ----------------------------------------------------------------------------------------------------

type Slot = {
  prId: string;
  prIdx: number;
  reviewer: PrReviewer;
  last: Record<string, unknown> | undefined;
};

/** A slot is terminal when no further run will start for it. */
export function slotStatus(
  last: { state?: unknown; attempt?: unknown; retryable?: unknown; finished_at?: unknown } | undefined,
  now: Date,
): 'terminal' | 'running' | 'open' | 'waiting' {
  if (!last) return 'open';
  if (last.state === 'running') return 'running';
  if (last.state === 'offline_completed') return 'terminal';
  const attempt = Number(last.attempt ?? 1);
  if (last.state === 'timed_out') return attempt < 2 ? 'open' : 'terminal';
  if (last.state === 'failed' && last.retryable && attempt < REPLAY_MAX_ATTEMPTS) {
    const done = last.finished_at ? new Date(last.finished_at as string).getTime() : 0;
    return now.getTime() - done >= RETRY_AFTER_MS ? 'open' : 'waiting';
  }
  return 'terminal';
}

async function loadSlots(db: Queryable, replayId: string): Promise<Slot[]> {
  const prs = await rows(db, 'SELECT id, idx FROM pr_replay_prs WHERE replay_id=$1 ORDER BY idx', [replayId]);
  const runs = await rows(
    db,
    `SELECT DISTINCT ON (replay_pr_id, reviewer) replay_pr_id, reviewer, state, attempt, retryable, finished_at
       FROM pr_review_runs WHERE replay_id=$1 ORDER BY replay_pr_id, reviewer, started_at DESC, attempt DESC`,
    [replayId],
  );
  const out: Slot[] = [];
  for (const pr of prs)
    for (const reviewer of REPLAY_REVIEWERS)
      out.push({
        prId: pr.id as string,
        prIdx: Number(pr.idx),
        reviewer,
        last: runs.find((r) => r.replay_pr_id === pr.id && r.reviewer === reviewer),
      });
  return out;
}

/** Marking starts when every slot is terminal; a replay with nothing to mark finishes at once. */
async function settleReplay(ctx: Ctx, tx: Tx, replayId: string): Promise<void> {
  const rp = await one(tx, 'SELECT * FROM pr_replays WHERE id=$1 FOR UPDATE', [replayId]);
  if (!rp || rp.state !== 'reviewing') return;
  const slots = await loadSlots(tx, replayId);
  if (slots.length === 0 || slots.some((s) => slotStatus(s.last, ctx.clock.now()) !== 'terminal')) return;
  const emit = emitter(ctx, tx, await replayScope(tx, rp.project_id as string));
  await emit(replayId, 'PrReplayReviewsDone', {});
  const toMark = await one(
    tx,
    `SELECT count(*)::int AS n FROM pr_review_findings WHERE replay_id=$1 AND disposition='posted'`,
    [replayId],
  );
  if (Number(toMark?.n ?? 0) === 0) await emit(replayId, 'PrReplayMarkingFinished', { result: await buildResult(tx, replayId) });
}

/** The scheduler pass: one replay run per workstation at a time, live reviews first. */
export async function dispatchReplayRuns(ctx: Ctx): Promise<number> {
  const reps = await rows(ctx.pool, `SELECT id FROM pr_replays WHERE state='reviewing' ORDER BY started_at`);
  let started = 0;
  for (const rp of reps) {
    const ok = await dispatchOne(ctx, rp.id as string).catch((err) => {
      ctx.log.error({ err, replayId: rp.id }, 'starting a replay review failed');
      return false;
    });
    if (ok) started++;
  }
  return started;
}

async function dispatchOne(ctx: Ctx, replayId: string): Promise<boolean> {
  let target: string | undefined;
  const started = await withAppendTx(ctx.pool, async (tx) => {
    const rp = await one(tx, 'SELECT * FROM pr_replays WHERE id=$1 FOR UPDATE', [replayId]);
    if (!rp || rp.state !== 'reviewing') return false;
    const projectId = rp.project_id as string;
    const slots = await loadSlots(tx, replayId);
    const now = ctx.clock.now();
    const status = slots.map((s) => slotStatus(s.last, now));
    if (status.includes('running')) return false; // one replay run at a time
    const idx = status.indexOf('open');
    if (idx < 0) {
      await settleReplay(ctx, tx, replayId);
      return false;
    }
    const slot = slots[idx] as Slot;
    // live first: a waiting live pull request or a live run on the workstation goes before the replay
    if ((await listReviewablePrs(tx, projectId).catch(() => [])).length > 0) return false;
    const ws = await one(
      tx,
      `SELECT w.id,
              (SELECT count(*)::int FROM pr_review_runs x WHERE x.workstation_id = w.id AND x.state='running') AS busy
         FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
         JOIN workstation_capabilities wc ON wc.workstation_id = w.id
        WHERE wr.project_repo_id=$1 AND w.status='active' AND w.connected
          AND $2 = ANY (wc.capabilities) AND $3 = ANY (wc.capabilities)
        ORDER BY (w.id = $4::uuid) DESC, w.last_seen_at DESC NULLS LAST LIMIT 1`,
      [rp.project_repo_id, REPLAY_CAPABILITY, PR_REVIEW_CAPABILITY, rp.workstation_id],
    );
    if (!ws || Number(ws.busy) > 0) return false;
    const pr = await one(tx, 'SELECT * FROM pr_replay_prs WHERE id=$1', [slot.prId]);
    const repo = await one(tx, 'SELECT remote_url_normalized FROM project_repos WHERE id=$1', [
      rp.project_repo_id,
    ]);
    if (!pr || !repo) return false;
    const model = REVIEWER_MODEL[slot.reviewer];
    const runId = randomUUID();
    const attempt = slot.last ? Number(slot.last.attempt ?? 1) + 1 : 1;
    const emit = emitter(ctx, tx, await replayScope(tx, projectId));
    await emit(replayId, 'PrReplayRunStarted', {
      replayPrId: slot.prId,
      projectId,
      runId,
      reviewer: slot.reviewer,
      runtime: model.runtime,
      model: model.model,
      workstationId: ws.id,
      timeoutMs: PR_REVIEW_TIMEOUT_MS,
      attempt,
    });
    const baseRef = GitRefSchema.safeParse(pr.base_branch);
    const prNumber = Number(pr.change_id);
    if (!baseRef.success || !Number.isInteger(prNumber) || prNumber <= 0) {
      await emit(replayId, 'PrReplayRunFailed', {
        replayPrId: slot.prId,
        runId,
        code: 'error',
        error: 'the pull request cannot be reviewed',
        retryable: false,
      });
      return true;
    }
    const payload = PrReviewRunPayloadSchema.parse({
      runId,
      projectId,
      prReviewId: slot.prId,
      projectRepoId: rp.project_repo_id,
      remoteUrlNormalized: repo.remote_url_normalized,
      prNumber,
      baseRef: baseRef.data,
      title: String(pr.title).slice(0, 300),
      reviewer: slot.reviewer,
      runtime: model.runtime,
      model: model.model,
      timeoutMs: PR_REVIEW_TIMEOUT_MS,
      offline: true,
      replay: {
        replayId,
        replayPrId: slot.prId,
        headSha: pr.head_sha,
        mergeCommitSha: pr.merge_commit_sha,
      },
    });
    await enqueueRunnerCommand(
      tx,
      ws.id as string,
      'pr_review.run',
      payload,
      new Date(now.getTime() + PR_REVIEW_TIMEOUT_MS + RUN_GRACE_MS),
    );
    target = ws.id as string;
    return true;
  });
  if (started && target) void Promise.resolve(ctx.services.gateway.deliverPending(target)).catch(() => undefined);
  return started === true;
}

// ---- run results (called from applyPrReviewRunResult; never posts) -------------------------------------------------

export async function applyReplayRunResult(
  ctx: Ctx,
  tx: Tx,
  run: Record<string, unknown>,
  ok: boolean,
  r: PrReviewRunResult | undefined,
  error: string | undefined,
): Promise<void> {
  const replayId = run.replay_id as string;
  const replayPrId = run.replay_pr_id as string;
  const runId = run.id as string;
  const emit = emitter(ctx, tx, await replayScope(tx, run.project_id as string));
  const base = { replayPrId, runId };
  if (!ok || !r) {
    await emit(replayId, 'PrReplayRunFailed', {
      ...base,
      code: 'error',
      error: (error ?? 'the workstation did not answer the review properly').slice(0, 400),
      retryable: true,
    });
  } else if (r.outcome === 'timeout') {
    await emit(replayId, 'PrReplayRunTimedOut', { ...base, durationMs: r.durationMs, phase: r.phase, by: 'runner' });
  } else if (r.outcome === 'failed') {
    await emit(replayId, 'PrReplayRunFailed', {
      ...base,
      code: r.code,
      error: r.error,
      retryable: r.retryable,
      durationMs: r.durationMs,
    });
  } else {
    // the same cap as live: what would have been posted is what the cap lets through
    const { cap, ordered } = applyFindingsCap(r.findings, r.changedLines);
    await emit(replayId, 'PrReplayRunCompleted', {
      ...base,
      headSha: r.headSha,
      baseSha: r.baseSha,
      durationMs: r.durationMs,
      changedLines: r.changedLines ?? null,
      findingsCap: cap,
      summary: r.summary,
      findings: ordered.map((f, idx) => ({
        findingId: randomUUID(),
        idx,
        rank: f.rank,
        path: f.path,
        line: f.line,
        anchored: f.anchored,
        severity: f.severity,
        title: f.title,
        body: f.body,
        disposition: f.disposition,
      })),
    });
  }
  await settleReplay(ctx, tx, replayId);
}

/** The stale sweep's answer for a replay run that never reported back. */
export async function timeOutReplayRun(ctx: Ctx, tx: Tx, run: Record<string, unknown>): Promise<void> {
  const emit = emitter(ctx, tx, await replayScope(tx, run.project_id as string));
  await emit(run.replay_id as string, 'PrReplayRunTimedOut', {
    replayPrId: run.replay_pr_id,
    runId: run.id,
    durationMs: Math.max(0, ctx.clock.now().getTime() - new Date(run.started_at as string).getTime()),
    phase: 'review',
    by: 'server',
  });
  await settleReplay(ctx, tx, run.replay_id as string);
}

// ---- the result --------------------------------------------------------------------------------------------------

async function buildResult(db: Queryable, replayId: string) {
  const prs = await rows(db, 'SELECT id, merged_at FROM pr_replay_prs WHERE replay_id=$1', [replayId]);
  const runs = await rows(
    db,
    `SELECT replay_pr_id, reviewer, model, state FROM pr_review_runs WHERE replay_id=$1`,
    [replayId],
  );
  const findings = await rows(
    db,
    `SELECT f.id, run.reviewer, run.model, f.disposition, m.mark
       FROM pr_review_findings f JOIN pr_review_runs run ON run.id = f.run_id
       LEFT JOIN pr_review_finding_marks m ON m.finding_id = f.id
      WHERE f.replay_id=$1`,
    [replayId],
  );
  const views = await rows(
    db,
    `SELECT v.finding_id, v.last_shown_at, m.first_marked_at
       FROM pr_replay_finding_views v JOIN pr_review_finding_marks m ON m.finding_id = v.finding_id
      WHERE v.replay_id=$1`,
    [replayId],
  );
  const iso = (v: unknown) => new Date(v as string).toISOString();
  return replayResult({
    prs: prs.map((p) => ({ id: p.id as string, mergedAt: iso(p.merged_at) })),
    runs: runs.map((r) => ({
      replayPrId: r.replay_pr_id as string,
      reviewer: r.reviewer as PrReviewer,
      model: r.model as string,
      state: r.state as string,
    })),
    findings: findings.map((f) => ({
      id: f.id as string,
      reviewer: f.reviewer as PrReviewer,
      model: f.model as string,
      disposition: f.disposition as FindingDisposition,
      mark: (f.mark as FindingMark | null) ?? null,
    })),
    views: views.map((v) => ({
      findingId: v.finding_id as string,
      shownAt: iso(v.last_shown_at),
      markedAt: iso(v.first_marked_at),
    })),
  });
}

// ---- marking -----------------------------------------------------------------------------------------------------

async function ownerOf(tx: Queryable, user: AuthSession['user'], projectId: string, what: string) {
  const role = await requireProjectMember(tx, user.id, projectId);
  if (role !== 'owner') throw forbidden(`only the project owner ${what}`);
}

async function loadMarkable(tx: Tx, findingId: string) {
  const f = await one(
    tx,
    `SELECT f.id, f.run_id, f.replay_id, f.replay_pr_id, f.disposition, run.project_id
       FROM pr_review_findings f JOIN pr_review_runs run ON run.id = f.run_id
      WHERE f.id=$1 AND f.replay_id IS NOT NULL FOR UPDATE OF f`,
    [findingId],
  );
  if (!f) throw notFound('finding not found');
  return f;
}

/** The effort clock: the finding is on the owner's screen now. Throttled; ignored once marked. */
export async function recordFindingShown(
  ctx: Ctx,
  user: AuthSession['user'],
  findingId: string,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const f = await loadMarkable(tx, findingId);
    await ownerOf(tx, user, f.project_id as string, 'marks findings');
    const rp = await one(tx, 'SELECT state FROM pr_replays WHERE id=$1', [f.replay_id]);
    if (rp?.state !== 'marking') throw conflict('replay_not_marking', 'the replay is not in marking');
    if (f.disposition !== 'posted') throw conflict('finding_not_markable', 'this finding is not marked');
    if (await one(tx, 'SELECT 1 FROM pr_review_finding_marks WHERE finding_id=$1', [findingId])) return;
    const last = await one(tx, 'SELECT last_shown_at FROM pr_replay_finding_views WHERE finding_id=$1', [findingId]);
    if (last && ctx.clock.now().getTime() - new Date(last.last_shown_at as string).getTime() < SHOWN_THROTTLE_MS)
      return;
    await emitter(ctx, tx, await replayScope(tx, f.project_id as string))(f.replay_id as string, 'PrReplayFindingShown', {
      findingId,
    });
  });
}

export async function markReplayFinding(
  ctx: Ctx,
  user: AuthSession['user'],
  findingId: string,
  req: MarkFindingRequest,
) {
  const replayId = await withAppendTx(ctx.pool, async (tx) => {
    const f = await loadMarkable(tx, findingId);
    const projectId = f.project_id as string;
    await ownerOf(tx, user, projectId, 'marks findings');
    const rp = await one(tx, 'SELECT * FROM pr_replays WHERE id=$1 FOR UPDATE', [f.replay_id]);
    if (rp?.state !== 'marking') throw conflict('replay_not_marking', 'the replay is not in marking');
    if (f.disposition !== 'posted') throw conflict('finding_not_markable', 'held-back findings are not marked');
    const prev = await one(tx, 'SELECT mark FROM pr_review_finding_marks WHERE finding_id=$1', [findingId]);
    if (prev?.mark !== req.mark) {
      const scope = await replayScope(tx, projectId);
      await ctx.store.append(
        [
          {
            streamId: streamId.prReplay(f.replay_id as string),
            event: {
              type: 'PrReviewFindingMarked',
              payload: {
                projectId,
                prReviewId: f.replay_pr_id as string,
                runId: f.run_id as string,
                findingId,
                mark: req.mark,
                previousMark: (prev?.mark as FindingMark | undefined) ?? null,
                markedBy: user.id,
                at: ctx.clock.now().toISOString(),
              },
            },
            actor: userActor(user.id),
            scope,
          },
        ],
        { tx },
      );
    }
    const left = await one(
      tx,
      `SELECT count(*)::int AS n FROM pr_review_findings f
        WHERE f.replay_id=$1 AND f.disposition='posted'
          AND NOT EXISTS (SELECT 1 FROM pr_review_finding_marks m WHERE m.finding_id = f.id)`,
      [f.replay_id],
    );
    if (Number(left?.n ?? 0) === 0)
      await emitter(ctx, tx, await replayScope(tx, projectId))(f.replay_id as string, 'PrReplayMarkingFinished', {
        result: await buildResult(tx, f.replay_id as string),
      });
    return f.replay_id as string;
  });
  const dto = await getReplayDto(ctx.pool, replayId, true);
  const finding = await replayFindingStep(ctx.pool, replayId, findingId, true);
  if (!dto || !finding) throw notFound('finding not found');
  return { finding, replay: dto };
}

// ---- cancel, retry, targets ---------------------------------------------------------------------------------------

async function ownedReplay(tx: Tx, user: AuthSession['user'], replayId: string) {
  const rp = await one(tx, 'SELECT * FROM pr_replays WHERE id=$1 FOR UPDATE', [replayId]);
  if (!rp) throw notFound('replay not found');
  await ownerOf(tx, user, rp.project_id as string, 'manages the replay');
  return rp;
}

export async function cancelReplay(ctx: Ctx, user: AuthSession['user'], replayId: string) {
  await withAppendTx(ctx.pool, async (tx) => {
    const rp = await ownedReplay(tx, user, replayId);
    if (!['listing', 'reviewing', 'marking'].includes(rp.state as string))
      throw conflict('replay_not_active', 'the replay is not active');
    const emit = emitter(ctx, tx, await replayScope(tx, rp.project_id as string), userActor(user.id));
    const running = await rows(tx, `SELECT id, replay_pr_id FROM pr_review_runs WHERE replay_id=$1 AND state='running'`, [replayId]);
    for (const r of running)
      await emit(replayId, 'PrReplayRunFailed', {
        replayPrId: r.replay_pr_id,
        runId: r.id,
        code: 'cancelled',
        error: 'the replay was cancelled',
        retryable: false,
      });
    await exec(
      tx,
      `UPDATE runner_commands SET status='failed', last_error='superseded'
        WHERE type = ANY ($2::text[]) AND status IN ('pending','sent') AND payload->'replay'->>'replayId' = $1`,
      [replayId, ['pr_review.run']],
    );
    await emit(replayId, 'PrReplayCancelled', { by: user.id });
  });
  const dto = await getReplayDto(ctx.pool, replayId, true);
  if (!dto) throw notFound('replay not found');
  return dto;
}

/** Reopens the reviews that did not finish (a failed or timed-out slot gets another attempt). */
export async function retryFailedReplayRuns(ctx: Ctx, user: AuthSession['user'], replayId: string) {
  await withAppendTx(ctx.pool, async (tx) => {
    const rp = await ownedReplay(tx, user, replayId);
    if (rp.state !== 'marking') throw conflict('replay_not_marking', 'only a replay in marking can retry reviews');
    const slots = await loadSlots(tx, replayId);
    if (!slots.some((s) => s.last?.state !== 'offline_completed'))
      throw conflict('nothing_to_retry', 'every review finished');
    await emitter(ctx, tx, await replayScope(tx, rp.project_id as string), userActor(user.id))(
      replayId,
      'PrReplayRetryRequested',
      { by: user.id },
    );
  });
  const dto = await getReplayDto(ctx.pool, replayId, true);
  if (!dto) throw notFound('replay not found');
  return dto;
}

export async function setReviewTargets(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  req: SetReviewTargetsRequest,
) {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner sets the targets');
    const rp = await one(
      tx,
      `SELECT id FROM pr_replays WHERE project_id=$1 AND state='finished' ORDER BY finished_at DESC LIMIT 1`,
      [projectId],
    );
    if (!rp) throw conflict('no_finished_replay', 'the targets are set from a finished replay');
    if (
      p.review_precision_target !== null &&
      p.review_precision_target !== undefined &&
      Number(p.review_precision_target) === req.precisionTarget &&
      Number(p.review_effort_target_hours) === req.effortTargetHoursPerWeek
    )
      return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectReviewTargetsSet',
            payload: {
              projectId,
              precisionTarget: req.precisionTarget,
              effortTargetHoursPerWeek: req.effortTargetHoursPerWeek,
              replayId: rp.id as string,
              by: user.id,
              at: ctx.clock.now().toISOString(),
            },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id as string, projectId),
        },
      ],
      { tx },
    );
  });
}
