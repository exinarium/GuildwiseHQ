import {
  autoReviewsLeft,
  compareQueue,
  isOrgManager,
  type OrgRole,
  PR_REVIEW_DAILY_CAP_DEFAULT,
  type PrReviewBlockedReason,
  type PrReviewQueueDto,
  type PrReviewQueueItem,
  reviewDayOf,
  streamId,
} from '@aom/shared';
import { loadVisibleProject } from '../authz/scope.ts';
import { reportingOf } from '../ceo/prefs.ts';
import type { Ctx } from '../context.ts';
import { one, type Queryable, rows } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { forbidden } from '../errors.ts';
import { mayStart } from '../review/may-start.ts';
import { listQueueCandidates, pickReviewerWorkstation } from '../review/reviewer-gate.ts';
import { projectScope, userActor } from './common.ts';

/**
 * The daily cap on automatic PR reviews (PRD v22 F1.4). A day is the local calendar day in the organization's reporting
 * time zone (UTC when it is not set). One automatic review = one pull request that got an automatic run that day;
 * runs the owner starts by hand are never counted.
 */

/** The review day of `now` for a project's organization, with its time zone. */
export async function reviewDayFor(db: Queryable, orgId: string, now: Date) {
  const timeZone = (await reportingOf(db, orgId)).timezone ?? 'UTC';
  return { timeZone, ...reviewDayOf(now, timeZone) };
}

async function runsToday(
  db: Queryable,
  projectId: string,
  trigger: 'auto' | 'manual',
  window: { start: Date; next: Date },
): Promise<number> {
  const r = await one(
    db,
    `SELECT count(DISTINCT pr_review_id)::int AS n FROM pr_review_runs
      WHERE project_id=$1 AND trigger=$2 AND started_at >= $3 AND started_at < $4`,
    [projectId, trigger, window.start, window.next],
  );
  return Number(r?.n ?? 0);
}

export const autoReviewsUsed = (db: Queryable, projectId: string, window: { start: Date; next: Date }) =>
  runsToday(db, projectId, 'auto', window);
export const manualReviewsToday = (db: Queryable, projectId: string, window: { start: Date; next: Date }) =>
  runsToday(db, projectId, 'manual', window);

/**
 * THE queue of a project, in run order, used by the dispatcher and by the API. Candidates are the eligible pull
 * requests `mayStart` allows, sorted by `compareQueue`. A pull request whose repository has no ready reviewer
 * workstation is `blocked` and holds no slot; of the others the first `cap - used` are `today`, the rest `later`.
 */
export async function prReviewQueue(
  db: Queryable,
  ctx: Pick<Ctx, 'clock'>,
  projectId: string,
): Promise<PrReviewQueueDto> {
  const project = await one(db, 'SELECT org_id, pr_review_daily_cap FROM projects WHERE id=$1', [projectId]);
  const orgId = project?.org_id as string;
  const cap = Number(project?.pr_review_daily_cap ?? PR_REVIEW_DAILY_CAP_DEFAULT);
  const day = await reviewDayFor(db, orgId, ctx.clock.now());
  const used = await autoReviewsUsed(db, projectId, day);
  const manualToday = await manualReviewsToday(db, projectId, day);

  const candidates: Awaited<ReturnType<typeof listQueueCandidates>> = [];
  for (const c of await listQueueCandidates(db, projectId)) if (await mayStart(db, c.id)) candidates.push(c);
  candidates.sort(compareQueue(day.timeZone));

  const repoNames = new Map(
    (await rows(db, 'SELECT id, name FROM project_repos WHERE project_id=$1', [projectId])).map((r) => [
      r.id as string,
      r.name as string,
    ]),
  );
  // the reviewer workstation is looked up once per repository
  const blockedByRepo = new Map<string, { reason: PrReviewBlockedReason; problem: string | null } | null>();
  const blockedOf = async (c: (typeof candidates)[number]) => {
    if (blockedByRepo.has(c.repoId)) return blockedByRepo.get(c.repoId) ?? null;
    let b: { reason: PrReviewBlockedReason; problem: string | null } | null = null;
    if (c.gate.state !== 'ready')
      b = {
        reason: 'reviewer_token_missing',
        problem: c.gate.state === 'reviewer_token_missing' ? c.gate.problem : null,
      };
    else {
      const pick = await pickReviewerWorkstation(db, c.gate);
      if ('blocked' in pick) b = { reason: pick.blocked, problem: null };
    }
    blockedByRepo.set(c.repoId, b);
    return b;
  };

  let left = autoReviewsLeft(used, cap);
  const items: PrReviewQueueItem[] = [];
  for (const [i, c] of candidates.entries()) {
    const blocked = await blockedOf(c);
    let slot: PrReviewQueueItem['slot'] = 'later';
    if (blocked) slot = 'blocked';
    else if (left > 0) {
      slot = 'today';
      left--;
    }
    items.push({
      prReviewId: c.id,
      position: i + 1,
      repoId: c.repoId,
      repoName: repoNames.get(c.repoId) ?? '',
      changeId: c.changeId,
      title: c.title,
      url: c.url,
      author: c.author,
      openedAt: c.openedAt.toISOString(),
      openedDay: reviewDayOf(c.openedAt, day.timeZone).day,
      changedLines: c.changedLines,
      slot,
      blockedReason: blocked?.reason ?? null,
      blockedProblem: blocked?.problem ?? null,
    });
  }
  return {
    day: day.day,
    timeZone: day.timeZone,
    resetsAt: day.next.toISOString(),
    used,
    cap,
    manualToday,
    items,
  };
}

/** The project Owner or an organization Owner/Admin: the people who decide spend. */
export async function requireSpendOwner(
  db: Queryable,
  user: { id: string },
  org: { id: string; role: OrgRole | null },
  projectId: string,
) {
  const p = await loadVisibleProject(db, user.id, projectId);
  const orgAdmin = isOrgManager({ orgRole: org.role }) && org.id === p.org_id;
  if (p.my_role !== 'owner' && !orgAdmin)
    throw forbidden('only the project Owner or an organization Owner or Admin can do this');
  return p;
}

/** Sets the project's daily cap on automatic reviews. No event when it is unchanged. */
export async function setPrReviewDailyCap(
  ctx: Ctx,
  user: { id: string },
  org: { id: string; role: OrgRole | null },
  projectId: string,
  cap: number,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await requireSpendOwner(tx, user, org, projectId);
    if (Number(p.pr_review_daily_cap ?? PR_REVIEW_DAILY_CAP_DEFAULT) === cap) return;
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectPrReviewCapSet', payload: { projectId, cap, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}
