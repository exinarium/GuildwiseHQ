import { exemptionCovers, streamId } from '@aom/shared';
import { one, type Queryable } from '../db/sql.ts';
import type { Ctx } from '../context.ts';
import type { Tx } from '../db/tx.ts';
import { projectScope, SYSTEM_ACTOR } from './common.ts';

/**
 * The approved size exception of a pull request, read by the size check (and by the hard size check). Kept apart from
 * `size-exception.ts` so the size check can use it without a circular import.
 */
export interface SizeExemption {
  id: string;
  size: number;
  budget: number;
  unit: string;
  decidedAt: Date | null;
  projectId: string;
  orgId: string;
  state: 'approved';
}

/**
 * The latest approved exception that covers the pull request (as the pull request or as a member of its chain). With
 * `currentSize`, only an exception that covers that size is returned (an approval holds up to the approved size).
 */
export async function sizeExemptionOf(
  db: Queryable,
  prReviewId: string,
  currentSize?: number,
): Promise<SizeExemption | null> {
  const r = await one(
    db,
    `SELECT id, size, budget, unit, decided_at, project_id, org_id FROM pr_size_exceptions
      WHERE state='approved' AND (pr_review_id=$1 OR $1 = ANY(chain_pr_review_ids))
      ORDER BY decided_at DESC NULLS LAST LIMIT 1`,
    [prReviewId],
  );
  if (!r) return null;
  const e: SizeExemption = {
    id: r.id as string,
    size: Number(r.size),
    budget: Number(r.budget),
    unit: r.unit as string,
    decidedAt: r.decided_at ? new Date(r.decided_at as string) : null,
    projectId: r.project_id as string,
    orgId: r.org_id as string,
    state: 'approved',
  };
  if (currentSize !== undefined && !exemptionCovers(e, currentSize)) return null;
  return e;
}

/** The pull request grew past the approved size: the exception no longer covers it, and the normal size check applies. */
export async function supersedeSizeExemption(ctx: Ctx, tx: Tx, e: SizeExemption): Promise<void> {
  await ctx.store.append(
    [
      {
        streamId: streamId.project(e.projectId),
        event: {
          type: 'SizeExceptionWithdrawn',
          payload: { sizeExceptionId: e.id, cause: 'grew', at: ctx.clock.now().toISOString() },
        } as never,
        actor: SYSTEM_ACTOR,
        scope: projectScope(e.orgId, e.projectId),
      },
    ],
    { tx },
  );
}
