import { randomUUID } from 'node:crypto';
import {
  addWorkingDays,
  type DeskActor,
  type DeskResolution,
  prChain,
  SIZE_EXCEPTION_LAPSE_WORKING_DAYS,
  SIZE_EXCEPTION_SUBKIND,
  type SizeExceptionDto,
  SizeExceptionReason,
  type SizeExceptionState,
  sizeExceptionDeskText,
  sizeExceptionDue,
  streamId,
} from '@aom/shared';
import type { Ctx } from '../context.ts';
import { one, type Queryable, type Row, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { userTimezone } from './owner-pending.ts';
import { loadSizeContext, sendPrBackToAuthorIn, verdictOf } from './pr-size-check.ts';
import { agentActor, projectScope, SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * Size exception requests. The CEO agent asks, with a reason, to let an over-budget pull request stay as one; the owner
 * approves or rejects it on the Desk. Rejected, or no answer within 2 working days: the pull request goes back to its
 * author to split. A lapse never reminds the owner: this is not an owner-pending timer and its desk item is skipped by the
 * follow-up chase.
 */

export { sizeExemptionOf } from './size-exemption.ts';

const ev = (orgId: string, projectId: string, type: string, payload: Record<string, unknown>, actor: object) => ({
  streamId: streamId.project(projectId),
  event: { type, payload } as never,
  actor: actor as never,
  scope: projectScope(orgId, projectId),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The CEO's request. Refuses (400/409/404) a reason under the minimum, a pull request that is not found, closed or not
 * sent back for its size, a request already open or already decided at this size, and a project without an owner.
 */
export async function requestSizeExceptionIn(
  ctx: Ctx,
  tx: Tx,
  req: { orgId: string; prRef: string; reason: string; by: DeskActor; agentId?: string },
): Promise<{ sizeExceptionId: string; deskItemId: string; dueAt: Date }> {
  const reason = SizeExceptionReason.safeParse(req.reason);
  if (!reason.success)
    throw badRequest('reason_required', reason.error.issues[0]?.message ?? 'a reason is required');
  const pr = await one(
    tx,
    `SELECT pr.id, pr.project_id, pr.project_repo_id, pr.change_id, pr.url, pr.review_state, pr.closed_at,
            r.name AS repo_name, p.org_id, p.key
       FROM pr_reviews pr JOIN projects p ON p.id = pr.project_id
       JOIN project_repos r ON r.id = pr.project_repo_id
      WHERE p.org_id=$1 AND ${UUID.test(req.prRef) ? 'pr.id=$2::uuid' : 'pr.url=$2'}
      ORDER BY (pr.closed_at IS NULL) DESC LIMIT 1
      FOR UPDATE OF pr`,
    [req.orgId, req.prRef],
  );
  if (!pr) throw notFound('pull request not found in this organization', 'pr_not_found');
  if (pr.closed_at) throw conflict('pr_closed', 'the pull request is closed');
  if (pr.review_state === 'size_exception_pending')
    throw conflict('already_pending', 'a size exception request for this pull request is already open');
  if (pr.review_state !== 'needs_split')
    throw conflict('not_over_budget', 'only a pull request sent back for its size can have a size exception');
  const projectId = pr.project_id as string;
  const repoId = pr.project_repo_id as string;
  const size = await loadSizeContext(tx, projectId, repoId);
  const v = verdictOf(size, pr.change_id as string);
  if (v.state !== 'over') throw conflict('not_over_budget', 'the pull request is not over its size budget');
  const chainChanges = new Set(prChain(pr.change_id as string, size.open).map((c) => c.changeId));
  const chain = (
    await rows(
      tx,
      `SELECT id, change_id FROM pr_reviews
        WHERE project_repo_id=$1 AND closed_at IS NULL AND review_state='needs_split' ORDER BY change_id FOR UPDATE`,
      [repoId],
    )
  )
    .filter((m) => chainChanges.has(m.change_id as string))
    .map((m) => m.id as string);
  if (!chain.includes(pr.id as string)) chain.push(pr.id as string);
  const open = await one(
    tx,
    `SELECT id FROM pr_size_exceptions WHERE state='pending' AND (pr_review_id = ANY($1::uuid[]) OR chain_pr_review_ids && $1::uuid[]) LIMIT 1`,
    [chain],
  );
  if (open) throw conflict('already_pending', 'a size exception request for this pull request is already open');
  const decided = await one(
    tx,
    `SELECT id FROM pr_size_exceptions
      WHERE state IN ('rejected','lapsed') AND size >= $2 AND (pr_review_id = ANY($1::uuid[]) OR chain_pr_review_ids && $1::uuid[]) LIMIT 1`,
    [chain, v.total],
  );
  if (decided)
    throw conflict('already_decided', 'a size exception for this pull request was already refused at this size');
  const owner = await one(
    tx,
    `SELECT user_id FROM project_members WHERE project_id=$1 AND role='owner' ORDER BY (status='active') DESC LIMIT 1`,
    [projectId],
  );
  if (!owner) throw conflict('no_owner', 'the project has no owner to decide');
  const ownerUserId = owner.user_id as string;
  const now = ctx.clock.now();
  const tz = await userTimezone(tx, ownerUserId);
  const dueAt = addWorkingDays(now, SIZE_EXCEPTION_LAPSE_WORKING_DAYS, tz);
  const sizeExceptionId = randomUUID();
  const deskItemId = randomUUID();
  const text = sizeExceptionDeskText({
    changeId: pr.change_id as string,
    repoName: pr.repo_name as string,
    size: v.total,
    budget: v.budget,
    unit: v.unit,
    reason: reason.data,
    dueAt,
  });
  const orgId = pr.org_id as string;
  const prReviewId = pr.id as string;
  await ctx.store.append(
    [
      ev(
        orgId,
        projectId,
        'SizeExceptionRequested',
        {
          sizeExceptionId,
          orgId,
          projectId,
          repoId,
          prReviewId,
          chainPrReviewIds: chain,
          size: v.total,
          budget: v.budget,
          unit: v.unit,
          members: v.members,
          reason: reason.data,
          dueAt: dueAt.toISOString(),
          at: now.toISOString(),
          deskItemId,
          ownerUserId,
          requestedBy: req.by,
          ...(req.agentId ? { agentId: req.agentId } : {}),
        },
        req.agentId ? agentActor(req.agentId) : SYSTEM_ACTOR,
      ),
      {
        streamId: streamId.desk(deskItemId),
        event: {
          type: 'DeskItemCreated' as const,
          payload: {
            deskItemId,
            kind: 'approval' as const,
            subkind: SIZE_EXCEPTION_SUBKIND,
            title: text.title,
            body: text.body,
            options: [],
            blocking: false,
            pinned: false,
            projectId,
            affectedCardIds: [],
            askedBy: req.by,
            addresseeUserId: ownerUserId,
            subjectKey: `size_exception:${prReviewId}`,
            data: {
              sizeExceptionId,
              prReviewId,
              url: pr.url,
              changeId: pr.change_id,
              repoName: pr.repo_name,
              size: v.total,
              budget: v.budget,
              unit: v.unit,
              members: v.members,
              reason: reason.data,
              dueAt: dueAt.toISOString(),
            },
          },
        },
        actor: req.agentId ? agentActor(req.agentId) : SYSTEM_ACTOR,
        scope: projectScope(orgId, projectId),
      },
    ],
    { tx },
  );
  return { sizeExceptionId, deskItemId, dueAt };
}

/**
 * The shared end of reject and lapse, run after the `Rejected` / `Lapsed` event (the projection has put the pull requests
 * back to `needs_split`). The size is read again: still over budget sends each member back to its author with the new
 * reason (that creates the author's notice); a pull request split meanwhile gets no notice and is cleared by the next poll.
 */
async function sendBackIfStillOver(
  ctx: Ctx,
  tx: Tx,
  row: Row,
  reason: 'size_exception_rejected' | 'size_exception_lapsed',
): Promise<void> {
  const projectId = row.project_id as string;
  const repoId = row.project_repo_id as string;
  const size = await loadSizeContext(tx, projectId, repoId);
  const checkId = randomUUID();
  const prs = await rows(
    tx,
    `SELECT id, change_id, review_state FROM pr_reviews
      WHERE id = ANY($1::uuid[]) AND closed_at IS NULL AND review_state='needs_split' ORDER BY change_id FOR UPDATE`,
    [row.chain_pr_review_ids],
  );
  for (const pr of prs) {
    const v = verdictOf(size, pr.change_id as string);
    if (v.state !== 'over') continue;
    await sendPrBackToAuthorIn(
      ctx,
      tx,
      { projectId, orgId: row.org_id as string, repoId },
      { id: pr.id as string, changeId: pr.change_id as string, state: 'needs_split' },
      v,
      checkId,
      reason,
    );
  }
}

async function closeDeskItem(ctx: Ctx, tx: Tx, row: Row, note: string): Promise<void> {
  const item = await one(tx, `SELECT id, status FROM desk_items WHERE id=$1 FOR UPDATE`, [row.desk_item_id]);
  if (!item || item.status !== 'open') return;
  await ctx.store.append(
    [
      {
        streamId: streamId.desk(item.id as string),
        event: {
          type: 'DeskItemResolved' as const,
          payload: {
            deskItemId: item.id as string,
            resolution: 'dismissed' as const,
            note,
            by: { kind: 'system' as const },
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(row.org_id as string, row.project_id as string),
      },
    ],
    { tx },
  );
}

/**
 * The owner resolves the desk item (called by `closeItem` in the same transaction). Approved: the pull request is an
 * approved exception and goes ahead. Rejected: it goes back to its author. The item itself is closed by the caller.
 */
export async function resolveSizeExceptionIn(
  ctx: Ctx,
  tx: Tx,
  user: { id: string },
  item: Row,
  resolution: DeskResolution,
  note?: string,
): Promise<void> {
  if (resolution !== 'approved' && resolution !== 'rejected')
    throw badRequest('wrong_resolution', 'a size exception is approved or rejected');
  const id = (item.data as { sizeExceptionId?: string } | null)?.sizeExceptionId;
  const row = id ? await one(tx, 'SELECT * FROM pr_size_exceptions WHERE id=$1 FOR UPDATE', [id]) : undefined;
  if (!row) throw notFound('size exception not found');
  if (row.state !== 'pending') throw conflict('not_pending', `this size exception is already ${row.state}`);
  const orgId = row.org_id as string;
  const projectId = row.project_id as string;
  const at = ctx.clock.now().toISOString();
  const pr = await one(tx, 'SELECT closed_at FROM pr_reviews WHERE id=$1', [row.pr_review_id]);
  if (pr?.closed_at) {
    await ctx.store.append(
      [
        ev(orgId, projectId, 'SizeExceptionWithdrawn', { sizeExceptionId: id, cause: 'pr_closed', at }, SYSTEM_ACTOR),
      ],
      { tx },
    );
    return;
  }
  const cleanNote = note?.trim() ? note.trim().slice(0, 2000) : undefined;
  await ctx.store.append(
    [
      ev(
        orgId,
        projectId,
        resolution === 'approved' ? 'SizeExceptionApproved' : 'SizeExceptionRejected',
        { sizeExceptionId: id, by: user.id, ...(cleanNote ? { note: cleanNote } : {}), at },
        userActor(user.id),
      ),
    ],
    { tx },
  );
  if (resolution === 'rejected') await sendBackIfStillOver(ctx, tx, row, 'size_exception_rejected');
}

/** A pull request closed while its request waits: the request is withdrawn and the owner's item closed. */
export async function withdrawSizeExceptionOnClose(ctx: Ctx, tx: Tx, prReviewId: string): Promise<void> {
  const row = await one(
    tx,
    `SELECT * FROM pr_size_exceptions WHERE state='pending' AND pr_review_id=$1 FOR UPDATE`,
    [prReviewId],
  );
  if (!row) return;
  await ctx.store.append(
    [
      ev(
        row.org_id as string,
        row.project_id as string,
        'SizeExceptionWithdrawn',
        { sizeExceptionId: row.id, cause: 'pr_closed', at: ctx.clock.now().toISOString() },
        SYSTEM_ACTOR,
      ),
    ],
    { tx },
  );
  await closeDeskItem(ctx, tx, row, 'The pull request was closed');
}

const SWEEP_LIMIT = 500;

/**
 * The scheduler pass: a request with no owner answer by its due time lapses. The pull request goes back to its author
 * (the notice is queued by `deliverSplitNotices`) and the owner's item is closed. NEVER a reminder to the owner: there is
 * no push, no nudge and no owner-pending timer here.
 */
export async function sizeExceptionSweep(ctx: Ctx): Promise<{ lapsed: number; withdrawn: number }> {
  const now = ctx.clock.now();
  const due = await rows(
    ctx.pool,
    `SELECT id FROM pr_size_exceptions WHERE state='pending' AND due_at <= $1 ORDER BY due_at LIMIT ${SWEEP_LIMIT}`,
    [now],
  );
  const closed = await rows(
    ctx.pool,
    `SELECT e.id FROM pr_size_exceptions e JOIN pr_reviews pr ON pr.id = e.pr_review_id
      WHERE e.state='pending' AND pr.closed_at IS NOT NULL LIMIT ${SWEEP_LIMIT}`,
  );
  let lapsed = 0;
  let withdrawn = 0;
  for (const c of [...new Map([...due, ...closed].map((d) => [d.id as string, d])).values()]) {
    const r = await withAppendTx(ctx.pool, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`size-exception:${c.id}`]);
      const row = await one(tx, `SELECT * FROM pr_size_exceptions WHERE id=$1 FOR UPDATE`, [c.id]);
      if (!row) return null;
      const pr = await one(tx, 'SELECT closed_at FROM pr_reviews WHERE id=$1', [row.pr_review_id]);
      const action = sizeExceptionDue(
        { state: row.state as string, dueAt: new Date(row.due_at as string), prClosed: Boolean(pr?.closed_at) },
        ctx.clock.now(),
      );
      if (!action) return null;
      const at = ctx.clock.now().toISOString();
      const orgId = row.org_id as string;
      const projectId = row.project_id as string;
      if (action === 'withdraw') {
        await ctx.store.append(
          [ev(orgId, projectId, 'SizeExceptionWithdrawn', { sizeExceptionId: row.id, cause: 'pr_closed', at }, SYSTEM_ACTOR)],
          { tx },
        );
        await closeDeskItem(ctx, tx, row, 'The pull request was closed');
        return 'withdrawn' as const;
      }
      await ctx.store.append(
        [ev(orgId, projectId, 'SizeExceptionLapsed', { sizeExceptionId: row.id, at }, SYSTEM_ACTOR)],
        { tx },
      );
      await closeDeskItem(
        ctx,
        tx,
        row,
        'Lapsed: no answer within 2 working days; sent back to the author to split',
      );
      await sendBackIfStillOver(ctx, tx, row, 'size_exception_lapsed');
      return 'lapsed' as const;
    }).catch((err) => {
      ctx.log.error({ err, sizeExceptionId: c.id }, 'a size exception could not be lapsed');
      return null;
    });
    if (r === 'lapsed') lapsed++;
    if (r === 'withdrawn') withdrawn++;
  }
  return { lapsed, withdrawn };
}

/** The requests of a project, newest first, for the owner's history on the Pull requests page. */
export async function listSizeExceptions(
  db: Queryable,
  projectId: string,
  filter: { state?: SizeExceptionState } = {},
): Promise<SizeExceptionDto[]> {
  const list = await rows(
    db,
    `SELECT e.*, pr.change_id, pr.url, r.name AS repo_name
       FROM pr_size_exceptions e
       LEFT JOIN pr_reviews pr ON pr.id = e.pr_review_id
       LEFT JOIN project_repos r ON r.id = e.project_repo_id
      WHERE e.project_id=$1 AND ($2::text IS NULL OR e.state=$2)
      ORDER BY e.requested_at DESC LIMIT 200`,
    [projectId, filter.state ?? null],
  );
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return list.map((e) => ({
    id: e.id as string,
    prReviewId: e.pr_review_id as string,
    prUrl: (e.url as string | null) ?? '',
    changeId: (e.change_id as string | null) ?? '',
    repoName: (e.repo_name as string | null) ?? '',
    chainPrReviewIds: e.chain_pr_review_ids as string[],
    size: Number(e.size),
    budget: Number(e.budget),
    unit: e.unit as 'changed_lines' | 'changed_files',
    reason: e.reason as string,
    state: e.state as SizeExceptionState,
    requestedAt: iso(e.requested_at) as string,
    dueAt: iso(e.due_at) as string,
    decidedAt: iso(e.decided_at),
    decidedBy: (e.decided_by as string | null) ?? null,
    note: (e.note as string | null) ?? null,
  }));
}
