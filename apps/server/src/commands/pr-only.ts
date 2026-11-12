import { randomUUID } from 'node:crypto';
import { PR_LIST_CAPABILITY, type PrReviewProblem, RepoListPrsResultSchema, streamId } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { forbidden, notFound } from '../errors.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { projectScope, SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * PR-only review. The owner marks a project repository PR-only: its open pull requests are recorded for review (state
 * `not_reviewed`) and no card is built for them. The pull requests come from a workstation that holds the clone and
 * lists them with its own git host login (`repo.list_prs`); the server never holds a forge credential.
 */

/** A PR-only repository is asked for its open pull requests at most this often. */
export const PR_POLL_MS = 5 * 60_000;
/** A request still waiting for an answer is not repeated within this time. */
export const PENDING_MS = 2 * 60_000;

/**
 * The owner turns PR-only review on or off for a repository. Only the project owner may; nothing is recorded when the
 * value does not change. Turning it on asks for the open pull requests right away, so the owner soon sees the status.
 */
export async function setRepoPrOnly(
  ctx: Ctx,
  user: AuthSession['user'],
  projectId: string,
  repoId: string,
  prOnly: boolean,
): Promise<void> {
  const changed = await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (p.my_role !== 'owner') throw forbidden('only the project owner can do this');
    const r = await one(
      tx,
      'SELECT id, pr_only FROM project_repos WHERE id=$1 AND project_id=$2 AND removed_at IS NULL',
      [repoId, projectId],
    );
    if (!r) throw notFound('repository not found');
    if ((r.pr_only ?? false) === prOnly) return false;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: {
            type: 'ProjectRepoPrOnlySet',
            payload: { projectId, repoId, prOnly, at: ctx.clock.now().toISOString(), by: user.id },
          },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
    return true;
  });
  if (changed && prOnly) await requestPrList(ctx, repoId, { userId: user.id }).catch(() => undefined);
}

export type RequestPrListOutcome =
  | { queued: true; requestId: string }
  | { queued: false; reason: 'skipped' | 'throttled' | 'no_clone' | 'old_runner' };

/**
 * Asks a workstation that holds the clone of a PR-only repository for its open pull requests (`repo.list_prs`,
 * read-only). Throttled: never while a request is pending (2 min) nor within 5 minutes of the last answer. Without a
 * capable workstation the reason is stored, so the owner sees why nothing is read.
 */
export async function requestPrList(
  ctx: Ctx,
  repoId: string,
  opts: { userId?: string } = {},
): Promise<RequestPrListOutcome> {
  const now = ctx.clock.now();
  const repo = await one(
    ctx.pool,
    `SELECT r.id, r.project_id, r.remote_url_normalized, r.forge_kind, p.org_id
       FROM project_repos r JOIN projects p ON p.id = r.project_id
      WHERE r.id=$1 AND r.removed_at IS NULL AND r.pr_only AND p.status='active'`,
    [repoId],
  );
  if (!repo) return { queued: false, reason: 'skipped' };
  const org = await one(ctx.pool, 'SELECT simulation FROM organizations WHERE id=$1', [repo.org_id]);
  if (org?.simulation) return { queued: false, reason: 'skipped' };

  const prior = await one(
    ctx.pool,
    'SELECT state, requested_at, checked_at FROM pr_review_polls WHERE project_repo_id=$1',
    [repoId],
  );
  if (prior?.state === 'pending' && now.getTime() - new Date(prior.requested_at).getTime() < PENDING_MS)
    return { queued: false, reason: 'throttled' };
  if (prior?.checked_at && now.getTime() - new Date(prior.checked_at).getTime() < PR_POLL_MS)
    return { queued: false, reason: 'throttled' };

  const ws = await one(
    ctx.pool,
    `SELECT w.id FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
       JOIN workstation_capabilities wc ON wc.workstation_id = w.id
      WHERE wr.project_repo_id=$1 AND w.status='active' AND $3 = ANY (wc.capabilities)
      ORDER BY w.connected DESC, (w.user_id = $2::uuid) DESC, w.last_seen_at DESC NULLS LAST LIMIT 1`,
    [repoId, opts.userId ?? null, PR_LIST_CAPABILITY],
  );
  const requestId = randomUUID();
  if (!ws) {
    const anyClone = await one(ctx.pool, 'SELECT 1 FROM workstation_repos WHERE project_repo_id=$1', [
      repoId,
    ]);
    const reason = anyClone ? 'old_runner' : 'no_clone';
    await exec(
      ctx.pool,
      `INSERT INTO pr_review_polls (project_repo_id, request_id, workstation_id, state, detail, requested_at, checked_at)
       VALUES ($1,$2,NULL,'failed',$3,$4,$4)
       ON CONFLICT (project_repo_id) DO UPDATE SET request_id=EXCLUDED.request_id, workstation_id=NULL,
         state='failed', detail=EXCLUDED.detail, requested_at=EXCLUDED.requested_at, checked_at=EXCLUDED.checked_at`,
      [repoId, requestId, reason, now],
    );
    return { queued: false, reason };
  }

  await exec(
    ctx.pool,
    `INSERT INTO pr_review_polls (project_repo_id, request_id, workstation_id, state, detail, requested_at, checked_at)
     VALUES ($1,$2,$3,'pending',NULL,$4,NULL)
     ON CONFLICT (project_repo_id) DO UPDATE SET request_id=EXCLUDED.request_id, workstation_id=EXCLUDED.workstation_id,
       state='pending', requested_at=EXCLUDED.requested_at`,
    [repoId, requestId, ws.id, now],
  );
  // Only the newest request counts (older answers are dropped), so a request still waiting on any workstation is
  // replaced, and each one expires with its pending window: an offline workstation never collects a backlog.
  await exec(
    ctx.pool,
    `UPDATE runner_commands SET status='failed', last_error='superseded'
      WHERE type='repo.list_prs' AND status IN ('pending','sent') AND payload->>'repoId' = $1`,
    [repoId],
  );
  await enqueueRunnerCommand(
    ctx.pool,
    ws.id,
    'repo.list_prs',
    {
      requestId,
      repoId,
      remoteUrlNormalized: repo.remote_url_normalized,
      ...(repo.forge_kind ? { forge: repo.forge_kind } : {}),
    },
    new Date(now.getTime() + PENDING_MS),
  );
  void Promise.resolve(ctx.services.gateway.deliverPending(ws.id)).catch(() => undefined);
  return { queued: true, requestId };
}

/** The scheduler pass: every PR-only repository of an active project is asked for its open pull requests when due. */
export async function pollPrOnlyRepos(ctx: Ctx): Promise<void> {
  const repos = await rows(
    ctx.pool,
    `SELECT r.id,
            (SELECT m.user_id FROM project_members m WHERE m.project_id = p.id AND m.role='owner' LIMIT 1) AS owner_id
       FROM project_repos r JOIN projects p ON p.id = r.project_id
      WHERE r.pr_only AND r.removed_at IS NULL AND p.status='active'`,
  );
  for (const r of repos) {
    await requestPrList(ctx, r.id as string, { userId: (r.owner_id as string | null) ?? undefined }).catch(
      (err) => ctx.log.error({ err, repoId: r.id }, 'PR list request failed'),
    );
  }
}

/**
 * `command.result` of `repo.list_prs`. In one transaction: drops an answer that a newer request replaced, stores the
 * poll status, and, only while the repository is still PR-only, records each pull request opened since PR-only was
 * turned on whose head is not a card branch of the project (`not_reviewed`). A complete list closes recorded pull
 * requests that are no longer open.
 */
export async function applyPrListResult(
  ctx: Ctx,
  payload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const requestId = String(payload.requestId ?? '');
  const repoId = String(payload.repoId ?? '');
  const parsed = RepoListPrsResultSchema.safeParse(result);
  const now = ctx.clock.now();
  await withAppendTx(ctx.pool, async (tx) => {
    const poll = await one(
      tx,
      'SELECT 1 FROM pr_review_polls WHERE project_repo_id=$1 AND request_id=$2 FOR UPDATE',
      [repoId, requestId],
    );
    if (!poll) return; // a newer request replaced this one
    const r = ok && parsed.success ? parsed.data : undefined;
    if (!r || !r.ok) {
      const state = r && !r.ok && r.reason === 'unsupported' ? 'unsupported' : 'failed';
      const detail = r && !r.ok ? r.reason : 'error';
      await exec(
        tx,
        `UPDATE pr_review_polls SET state=$3, detail=$4, checked_at=$5 WHERE project_repo_id=$1 AND request_id=$2`,
        [
          repoId,
          requestId,
          state,
          r?.ok === false && r.error ? `${detail}: ${r.error}` : (error ?? detail),
          now,
        ],
      );
      return;
    }
    await exec(
      tx,
      `UPDATE pr_review_polls SET state='ok', detail=NULL, checked_at=$3 WHERE project_repo_id=$1 AND request_id=$2`,
      [repoId, requestId, now],
    );
    const repo = await one(
      tx,
      `SELECT r.id, r.project_id, r.pr_only, r.pr_only_since, p.org_id
         FROM project_repos r JOIN projects p ON p.id = r.project_id
        WHERE r.id=$1 AND r.removed_at IS NULL FOR UPDATE OF r`,
      [repoId],
    );
    // Off means off: an answer that arrives after the switch was turned off records nothing.
    if (!repo?.pr_only || !repo.pr_only_since) return;
    const projectId = repo.project_id as string;
    const since = new Date(repo.pr_only_since).getTime();
    const cardBranches = new Set(
      (
        await rows(tx, 'SELECT branch_name FROM cards WHERE project_id=$1 AND branch_name IS NOT NULL', [
          projectId,
        ])
      ).map((c) => c.branch_name as string),
    );
    const known = new Map(
      (
        await rows(tx, 'SELECT id, change_id, closed_at FROM pr_reviews WHERE project_repo_id=$1', [repoId])
      ).map((k) => [k.change_id as string, k]),
    );
    const scope = projectScope(repo.org_id as string, projectId);
    const events = [];
    for (const c of r.changes) {
      if (known.has(c.id)) continue;
      if (new Date(c.createdAt).getTime() < since) continue;
      if (cardBranches.has(c.head)) continue;
      events.push({
        streamId: streamId.project(projectId),
        event: {
          type: 'PrReviewRecorded' as const,
          payload: {
            projectId,
            repoId,
            prReviewId: randomUUID(),
            changeId: c.id,
            url: c.url,
            title: c.title,
            author: c.author,
            headBranch: c.head,
            baseBranch: c.base,
            openedAt: new Date(c.createdAt).toISOString(),
            state: 'not_reviewed' as const,
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      });
    }
    if (r.complete) {
      const open = new Set(r.changes.map((c) => c.id));
      for (const [changeId, k] of known) {
        if (k.closed_at || open.has(changeId)) continue;
        events.push({
          streamId: streamId.project(projectId),
          event: {
            type: 'PrReviewClosed' as const,
            payload: { projectId, repoId, prReviewId: k.id as string },
          },
          actor: SYSTEM_ACTOR,
          scope,
        });
      }
    }
    if (events.length) await ctx.store.append(events, { tx });
  });
}

export type ReviewEligiblePr = {
  id: string;
  repoId: string;
  changeId: string;
  url: string;
  title: string;
  author: string | null;
  headBranch: string;
  baseBranch: string;
  openedAt: Date;
};

/**
 * The open pull requests that wait for review: recorded `not_reviewed`, not closed, on a repository that is PR-only
 * now. The single place reviewer work is picked from; a repository switched off contributes nothing.
 */
export async function listReviewEligiblePrs(db: Queryable, projectId: string): Promise<ReviewEligiblePr[]> {
  const list = await rows(
    db,
    `SELECT pr.id, pr.project_repo_id, pr.change_id, pr.url, pr.title, pr.author, pr.head_branch, pr.base_branch,
            pr.opened_at
       FROM pr_reviews pr JOIN project_repos r ON r.id = pr.project_repo_id
      WHERE pr.project_id=$1 AND pr.closed_at IS NULL AND pr.review_state='not_reviewed'
        AND r.pr_only AND r.removed_at IS NULL
      ORDER BY pr.opened_at, pr.change_id`,
    [projectId],
  );
  return list.map((p) => ({
    id: p.id as string,
    repoId: p.project_repo_id as string,
    changeId: p.change_id as string,
    url: p.url as string,
    title: p.title as string,
    author: (p.author as string | null) ?? null,
    headBranch: p.head_branch as string,
    baseBranch: p.base_branch as string,
    openedAt: new Date(p.opened_at),
  }));
}

/** The PR-only status per repository of a project, for the repository DTO (`prReview`). */
export async function loadPrReviewStatus(
  db: Queryable,
  projectId: string,
): Promise<Map<string, { waiting: number; checkedAt: string | null; problem: PrReviewProblem | null }>> {
  const list = await rows(
    db,
    `SELECT r.id,
            (SELECT count(*)::int FROM pr_reviews pr
              WHERE pr.project_repo_id = r.id AND pr.closed_at IS NULL AND pr.review_state='not_reviewed') AS waiting,
            pl.state, pl.detail, pl.checked_at
       FROM project_repos r LEFT JOIN pr_review_polls pl ON pl.project_repo_id = r.id
      WHERE r.project_id=$1 AND r.pr_only`,
    [projectId],
  );
  const out = new Map<
    string,
    { waiting: number; checkedAt: string | null; problem: PrReviewProblem | null }
  >();
  for (const r of list) {
    out.set(r.id as string, {
      waiting: Number(r.waiting ?? 0),
      checkedAt: r.checked_at ? new Date(r.checked_at).toISOString() : null,
      problem: pollProblem(r.state as string | null, r.detail as string | null),
    });
  }
  return out;
}

/** Why the open pull requests of a repository are not read, from the stored poll status; null when they are. */
export function pollProblem(state: string | null, detail: string | null): PrReviewProblem | null {
  if (state === 'unsupported') return 'unsupported';
  if (state !== 'failed') return null;
  const reason = (detail ?? '').split(':')[0];
  if (reason === 'no_clone' || reason === 'old_runner' || reason === 'not_connected') return reason;
  return 'error';
}
