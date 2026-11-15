import { randomUUID } from 'node:crypto';
import {
  type ChainCandidate,
  COMMIT_STATUS_CAPABILITY,
  COMMIT_STATUS_MAX_ATTEMPTS,
  prSizeVerdict,
  RepoCommitStatusPayloadSchema,
  RepoCommitStatusResultSchema,
  SIZE_STATUS_CONTEXT,
  sizeStatusFor,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { type Tx, withTx } from '../db/tx.ts';
import { reviewSettingsOf } from '../queries/misc.ts';
import { enqueueRunnerCommand } from '../runner-gateway/commands-queue.ts';
import { requestPrList } from './pr-only.ts';
import { sizeExemptionOf } from './size-exemption.ts';

/**
 * The hard size check. Every open pull request of a repository of a project with a size budget and unit gets a commit
 * status named `size-budget` (pass or fail against the budget, a stack of pull requests summed as one, an owner exception
 * passing). The server decides what each status is from the open pull request list the poll already stores; a workstation
 * with the size check status token posts it (`repo.commit_status`). Nothing here talks to the git host, and nothing here
 * changes branch protection: making the check required is the owner's step on the git host.
 */

/** A status posted from this workstation is tried again after this long (failed) or this long (never answered). */
const RETRY_FAILED_MS = 5 * 60_000;
const RETRY_REFUSED_MS = 15 * 60_000;
const QUEUED_EXPIRY_MS = 10 * 60_000;
/** Answers that will not change by trying again with the same data. */
const FINAL_CODES = ['invalid_sha', 'unsupported'];
/** Answers that change once the owner fixes the token: tried again every 15 minutes, with no limit. */
const TOKEN_CODES = ['no_token', 'forbidden', 'not_found'];

const SHA = /^[0-9a-f]{40}$/;

/** Only GitHub repositories get the status. An unset forge is read from the host in the repository address. */
const GITHUB_REPO_SQL = `(r.forge_kind = 'github' OR (r.forge_kind IS NULL AND r.remote_url_normalized LIKE '%github%'))`;

/**
 * The SQL for "this repository is polled for the hard size check": the project has a size budget and unit, or the
 * repository already had the check. `r` is project_repos, `p` projects.
 */
export const SIZE_POLL_SQL = `(${GITHUB_REPO_SQL} AND ((p.size_budget IS NOT NULL AND p.size_unit IS NOT NULL)
  OR EXISTS (SELECT 1 FROM pr_size_status_repos s WHERE s.project_repo_id = r.id)))`;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Works out the status of every open pull request of a repository from the stored list, inside the poll's
 * transaction. A status that differs from the stored one (another commit, another state or another message) is stored
 * as `pending` for delivery. No network call; missing data reads as "not measured yet", never an error.
 */
export async function evaluateSizeStatuses(
  _ctx: Ctx,
  tx: Tx,
  projectId: string,
  repoId: string,
  now: Date,
): Promise<void> {
  const repo = await one(
    tx,
    `SELECT r.id, ${GITHUB_REPO_SQL} AS github FROM project_repos r WHERE r.id=$1 AND r.removed_at IS NULL`,
    [repoId],
  );
  if (!repo?.github) return;
  const project = await one(tx, 'SELECT * FROM projects WHERE id=$1', [projectId]);
  if (!project) return;
  const settings = reviewSettingsOf(project);
  const hadStatus = Boolean(
    await one(tx, 'SELECT 1 FROM pr_size_status_repos WHERE project_repo_id=$1', [repoId]),
  );
  const list = await rows(
    tx,
    `SELECT change_id, head_branch, base_branch, cross_repo, head_sha, changed_lines, changed_files
       FROM pr_open_changes WHERE project_repo_id=$1`,
    [repoId],
  );
  const poll = await one(tx, 'SELECT complete FROM pr_review_polls WHERE project_repo_id=$1', [repoId]);
  const complete = poll?.complete !== false;
  // Card pull requests are checked too (excluded: false): once the check is required, cards land as pull requests.
  const open: ChainCandidate[] = list.map((c) => ({
    changeId: c.change_id as string,
    head: c.head_branch as string,
    base: c.base_branch as string,
    crossRepo: Boolean(c.cross_repo),
    size: { changedLines: num(c.changed_lines), changedFiles: num(c.changed_files) },
    excluded: false,
  }));
  const recorded = new Map(
    (
      await rows(tx, 'SELECT id, change_id FROM pr_reviews WHERE project_repo_id=$1 AND closed_at IS NULL', [
        repoId,
      ])
    ).map((r) => [r.change_id as string, r.id as string]),
  );
  const existing = new Map(
    (await rows(tx, 'SELECT * FROM pr_size_statuses WHERE project_repo_id=$1', [repoId])).map((r) => [
      r.change_id as string,
      r,
    ]),
  );

  for (const c of list) {
    const changeId = c.change_id as string;
    const sha = typeof c.head_sha === 'string' && SHA.test(c.head_sha) ? c.head_sha : null;
    if (!sha) continue;
    const verdict = prSizeVerdict({ settings, changeId, open, complete });
    const prReviewId = recorded.get(changeId);
    // read-only: an exception that no longer covers the size is withdrawn by the size check, not here
    const excepted =
      verdict.state === 'over' && prReviewId !== undefined
        ? (await sizeExemptionOf(tx, prReviewId, verdict.total)) !== null
        : false;
    const want = sizeStatusFor({ verdict, excepted, hadStatus });
    const have = existing.get(changeId);
    if (!want) {
      if (have)
        await exec(tx, 'DELETE FROM pr_size_statuses WHERE project_repo_id=$1 AND change_id=$2', [
          repoId,
          changeId,
        ]);
      continue;
    }
    if (have && have.head_sha === sha && have.state === want.state && have.description === want.description)
      continue;
    await exec(
      tx,
      `INSERT INTO pr_size_statuses (project_repo_id, change_id, head_sha, state, reason, description, total, budget,
                                     unit, post_state, status_id, attempts, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,0,$11)
       ON CONFLICT (project_repo_id, change_id) DO UPDATE SET head_sha=EXCLUDED.head_sha, state=EXCLUDED.state,
         reason=EXCLUDED.reason, description=EXCLUDED.description, total=EXCLUDED.total, budget=EXCLUDED.budget,
         unit=EXCLUDED.unit, post_state='pending', status_id=EXCLUDED.status_id, attempts=0, workstation_id=NULL,
         queued_at=NULL, error_code=NULL, error=NULL, retryable=true, updated_at=EXCLUDED.updated_at`,
      [
        repoId,
        changeId,
        sha,
        want.state,
        want.reason,
        want.description,
        want.total ?? null,
        want.budget ?? null,
        want.unit ?? null,
        randomUUID(),
        now,
      ],
    );
  }
  if (complete) {
    await exec(
      tx,
      'DELETE FROM pr_size_statuses WHERE project_repo_id=$1 AND NOT (change_id = ANY($2::text[]))',
      [repoId, list.map((c) => c.change_id as string)],
    );
  }
}

/** The host of a normalized remote (`github.com/o/r` -> `github.com`). */
const hostOfRemote = (normalized: string): string => normalized.split('/')[0]?.toLowerCase() ?? '';

/**
 * The SQL for "a workstation can post this status" (the same rule as `pickStatusWorkstation`: holds the clone, announces
 * the command, holds a status token for the host). `s` is pr_size_statuses, `r` project_repos. Parameter `$8` is the
 * capability.
 */
const DELIVERABLE_SQL = `EXISTS (SELECT 1 FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
    JOIN workstation_capabilities wc ON wc.workstation_id = w.id
   WHERE wr.project_repo_id = s.project_repo_id AND w.status='active' AND $8 = ANY (wc.capabilities)
     AND w.status_tokens ? ('github@' || lower(split_part(r.remote_url_normalized, '/', 1))))`;

/**
 * The scheduler pass: statuses that wait to be posted, whose post failed in a way that may pass, or that were queued and
 * never answered are sent to a workstation that holds the clone, can post and holds a status token for the host. With no
 * such workstation the status stays pending (the project settings say why) and is not selected at all, so statuses
 * nobody can post never take the place of statuses that can be posted. `projectId` limits the pass to one project.
 * Returns how many were sent.
 */
export async function deliverSizeStatuses(ctx: Ctx, scope: { projectId?: string } = {}): Promise<number> {
  const now = ctx.clock.now();
  const due = await rows(
    ctx.pool,
    `SELECT s.project_repo_id, s.change_id FROM pr_size_statuses s
       JOIN project_repos r ON r.id = s.project_repo_id
       JOIN projects p ON p.id = r.project_id
       JOIN organizations o ON o.id = p.org_id
      WHERE r.removed_at IS NULL AND p.status='active' AND NOT COALESCE(o.simulation, false)
        AND ($7::uuid IS NULL OR p.id = $7::uuid)
        AND ${DELIVERABLE_SQL}
        AND (s.post_state = 'pending'
          OR (s.post_state = 'failed' AND s.retryable AND s.error_code <> ALL($4::text[])
              AND ((s.error_code = ANY($5::text[]) AND s.queued_at < $3)
                OR (s.error_code <> ALL($5::text[]) AND s.attempts < $1 AND s.queued_at < $2)))
          OR (s.post_state = 'queued' AND s.queued_at < $6))
      ORDER BY s.updated_at LIMIT 200`,
    [
      COMMIT_STATUS_MAX_ATTEMPTS,
      new Date(now.getTime() - RETRY_FAILED_MS),
      new Date(now.getTime() - RETRY_REFUSED_MS),
      FINAL_CODES,
      TOKEN_CODES,
      new Date(now.getTime() - QUEUED_EXPIRY_MS),
      scope.projectId ?? null,
      COMMIT_STATUS_CAPABILITY,
    ],
  );
  const targets = new Set<string>();
  let sent = 0;
  for (const d of due) {
    const target = await withTx(ctx.pool, (tx) =>
      queueStatus(ctx, tx, d.project_repo_id as string, d.change_id as string, now),
    ).catch((err) => {
      ctx.log.error(
        { err, repoId: d.project_repo_id, changeId: d.change_id },
        'queueing a size status failed',
      );
      return undefined;
    });
    if (target) {
      targets.add(target);
      sent++;
    }
  }
  for (const t of targets)
    void Promise.resolve(ctx.services.gateway.deliverPending(t)).catch(() => undefined);
  return sent;
}

/** The workstation that can post for a repository: holds the clone, announces the command, holds a token for the host. */
export async function pickStatusWorkstation(
  db: Queryable,
  repoId: string,
  remoteUrlNormalized: string,
  preferred?: string | null,
  onlyConnected = false,
): Promise<string | null> {
  const key = `github@${hostOfRemote(remoteUrlNormalized)}`;
  const ws = await one(
    db,
    `SELECT w.id FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
       JOIN workstation_capabilities wc ON wc.workstation_id = w.id
      WHERE wr.project_repo_id=$1 AND w.status='active' AND $2 = ANY (wc.capabilities) AND w.status_tokens ? $3 AND ($5::boolean IS NOT TRUE OR w.connected)
      ORDER BY w.connected DESC, (w.id = $4::uuid) DESC, w.last_seen_at DESC NULLS LAST LIMIT 1`,
    [repoId, COMMIT_STATUS_CAPABILITY, key, preferred ?? null, onlyConnected],
  );
  return (ws?.id as string | undefined) ?? null;
}

async function queueStatus(
  ctx: Ctx,
  tx: Tx,
  repoId: string,
  changeId: string,
  now: Date,
): Promise<string | undefined> {
  const s = await one(
    tx,
    'SELECT * FROM pr_size_statuses WHERE project_repo_id=$1 AND change_id=$2 FOR UPDATE',
    [repoId, changeId],
  );
  if (!s || s.post_state === 'posted') return undefined;
  // A pass that raced another one (scheduler and a settings refresh) leaves a status queued by the other pass alone:
  // one POST per status, attempts counted once. A queued status that was never answered is sent again once it expired.
  if (
    s.post_state === 'queued' &&
    s.queued_at &&
    new Date(s.queued_at as string).getTime() > now.getTime() - QUEUED_EXPIRY_MS
  )
    return undefined;
  const repo = await one(
    tx,
    'SELECT remote_url_normalized, forge_kind FROM project_repos WHERE id=$1 AND removed_at IS NULL',
    [repoId],
  );
  if (!repo) return undefined;
  const poll = await one(tx, 'SELECT workstation_id FROM pr_review_polls WHERE project_repo_id=$1', [repoId]);
  const wsId = await pickStatusWorkstation(
    tx,
    repoId,
    repo.remote_url_normalized as string,
    (poll?.workstation_id as string | null) ?? null,
  );
  if (!wsId) return undefined;
  const payload = RepoCommitStatusPayloadSchema.parse({
    statusId: s.status_id,
    repoId,
    remoteUrlNormalized: repo.remote_url_normalized,
    forge: 'github',
    sha: s.head_sha,
    state: s.state,
    context: SIZE_STATUS_CONTEXT,
    description: s.description,
  });
  await exec(
    tx,
    `UPDATE pr_size_statuses SET post_state='queued', attempts=attempts+1, queued_at=$3, workstation_id=$4, updated_at=$3
      WHERE project_repo_id=$1 AND change_id=$2`,
    [repoId, changeId, now, wsId],
  );
  await enqueueRunnerCommand(
    tx,
    wsId,
    'repo.commit_status',
    payload,
    new Date(now.getTime() + QUEUED_EXPIRY_MS),
  );
  return wsId;
}

/** `command.result` of `repo.commit_status`: records that the status is on the commit, or why not. A stale answer is ignored. */
export async function applyCommitStatusResult(
  ctx: Ctx,
  commandPayload: Record<string, unknown>,
  ok: boolean,
  result: unknown,
  error: string | undefined,
): Promise<void> {
  const statusId = typeof commandPayload.statusId === 'string' ? commandPayload.statusId : '';
  if (!statusId) return;
  const parsed = RepoCommitStatusResultSchema.safeParse(result);
  const r = ok && parsed.success ? parsed.data : undefined;
  const now = ctx.clock.now();
  await withTx(ctx.pool, async (tx) => {
    const s = await one(
      tx,
      'SELECT project_repo_id, change_id FROM pr_size_statuses WHERE status_id=$1 FOR UPDATE',
      [statusId],
    );
    if (!s) return; // the pull request changed or closed since: a newer status replaced this one
    if (r?.ok) {
      await exec(
        tx,
        `UPDATE pr_size_statuses SET post_state='posted', posted_at=$2, error_code=NULL, error=NULL, updated_at=$2
          WHERE status_id=$1`,
        [statusId, now],
      );
      await exec(
        tx,
        `INSERT INTO pr_size_status_repos (project_repo_id, first_posted_at) VALUES ($1,$2)
         ON CONFLICT (project_repo_id) DO NOTHING`,
        [s.project_repo_id, now],
      );
      return;
    }
    const code = r && !r.ok ? r.code : 'error';
    const text = (r && !r.ok ? r.error : (error ?? 'the workstation did not answer properly')).slice(0, 400);
    await exec(
      tx,
      `UPDATE pr_size_statuses SET post_state='failed', error_code=$2, error=$3, retryable=$4, updated_at=$5
        WHERE status_id=$1`,
      [statusId, code, text, !FINAL_CODES.includes(code), now],
    );
  });
}

/**
 * Re-evaluates the statuses of a project from the stored open pull request lists and delivers what changed. Called after
 * the project's size settings changed and after an owner decision on a size exception. Own transaction; an error is
 * logged and never thrown to the caller.
 */
export async function refreshSizeStatuses(
  ctx: Ctx,
  at: { projectId: string; repoId?: string; poll?: boolean },
): Promise<void> {
  try {
    if (at.poll) {
      // a new budget: read the open pull requests now (a repository never listed has nothing stored yet)
      const polled = await rows(
        ctx.pool,
        `SELECT r.id FROM project_repos r JOIN projects p ON p.id = r.project_id
          WHERE r.project_id=$1 AND r.removed_at IS NULL AND (r.pr_only OR ${SIZE_POLL_SQL})`,
        [at.projectId],
      );
      for (const r of polled)
        await requestPrList(ctx, r.id as string, { force: true }).catch((err) =>
          ctx.log.error({ err, repoId: r.id }, 'PR list request failed'),
        );
    }
    const repos = at.repoId
      ? [{ id: at.repoId }]
      : await rows(
          ctx.pool,
          `SELECT r.id FROM project_repos r
            WHERE r.project_id=$1 AND r.removed_at IS NULL
              AND (EXISTS (SELECT 1 FROM pr_open_changes c WHERE c.project_repo_id = r.id)
                OR EXISTS (SELECT 1 FROM pr_size_statuses s WHERE s.project_repo_id = r.id))`,
          [at.projectId],
        );
    const now = ctx.clock.now();
    for (const r of repos)
      await withTx(ctx.pool, (tx) => evaluateSizeStatuses(ctx, tx, at.projectId, r.id as string, now));
    await deliverSizeStatuses(ctx, { projectId: at.projectId });
  } catch (err) {
    ctx.log.error({ err, projectId: at.projectId }, 'refreshing the size statuses failed');
  }
}

/**
 * The state of the hard size check for the project settings. `inactive`: no budget and unit and no repository that had the
 * check. `no_runner`: no workstation with a clone is online to post. `no_token`: a workstation is online but none holds
 * a status token for the host. Otherwise `active`.
 */
export async function sizeStatusDtoOf(
  db: Queryable,
  projectId: string,
): Promise<{
  context: string;
  state: 'inactive' | 'active' | 'no_token' | 'no_runner';
  failing: number;
  lastPostedAt: string | null;
}> {
  const repos = await rows(
    db,
    `SELECT r.id, r.remote_url_normalized FROM project_repos r JOIN projects p ON p.id = r.project_id
      WHERE r.project_id=$1 AND r.removed_at IS NULL AND ${SIZE_POLL_SQL}`,
    [projectId],
  );
  const base = { context: SIZE_STATUS_CONTEXT, failing: 0, lastPostedAt: null as string | null };
  if (repos.length === 0) return { ...base, state: 'inactive' };
  const ids = repos.map((r) => r.id as string);
  const agg = await one(
    db,
    `SELECT count(*) FILTER (WHERE state='failure')::int AS failing, max(posted_at) AS last_posted
       FROM pr_size_statuses WHERE project_repo_id = ANY($1::uuid[])`,
    [ids],
  );
  const out = {
    ...base,
    failing: Number(agg?.failing ?? 0),
    lastPostedAt: agg?.last_posted ? new Date(agg.last_posted as string).toISOString() : null,
  };
  // can a workstation post for every repository? (online with the clone, announcing the command)
  let anyOnline = false;
  for (const r of repos) {
    const online = await one(
      db,
      `SELECT 1 FROM workstation_repos wr JOIN workstations w ON w.id = wr.workstation_id
         JOIN workstation_capabilities wc ON wc.workstation_id = w.id
        WHERE wr.project_repo_id=$1 AND w.status='active' AND w.connected AND $2 = ANY (wc.capabilities) LIMIT 1`,
      [r.id, COMMIT_STATUS_CAPABILITY],
    );
    if (online) anyOnline = true;
    if (
      online &&
      (await pickStatusWorkstation(db, r.id as string, r.remote_url_normalized as string, null, true))
    )
      return { ...out, state: 'active' };
  }
  return { ...out, state: anyOnline ? 'no_token' : 'no_runner' };
}
