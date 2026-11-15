import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/**
 * Size exception requests (projection of the `SizeException*` events): `pr_size_exceptions`, and the review state of the
 * pull requests the request covers. Every `pr_reviews` update is guarded by the state it expects, so this never fights
 * the size check's own projection.
 */
const backToNeedsSplit = `UPDATE pr_reviews SET review_state='needs_split'
   WHERE review_state='size_exception_pending'
     AND id IN (SELECT unnest(chain_pr_review_ids) FROM pr_size_exceptions WHERE id=$1)`;

export const sizeExceptionProjectors: Record<string, Projector> = {
  SizeExceptionRequested: async (tx, e) => {
    const p = (e.event as EventOf<'SizeExceptionRequested'>).payload;
    await exec(
      tx,
      `INSERT INTO pr_size_exceptions (id, org_id, project_id, project_repo_id, pr_review_id, chain_pr_review_ids, size,
                                       budget, unit, members, reason, state, owner_user_id, requested_by_agent_id,
                                       desk_item_id, requested_at, due_at)
       VALUES ($1,$2,$3,$4,$5,$6::uuid[],$7,$8,$9,$10::jsonb,$11,'pending',$12,$13,$14,$15,$16)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.sizeExceptionId,
        p.orgId,
        p.projectId,
        p.repoId,
        p.prReviewId,
        p.chainPrReviewIds,
        p.size,
        p.budget,
        p.unit,
        JSON.stringify(p.members),
        p.reason,
        p.ownerUserId,
        p.agentId ?? p.requestedBy.agentId ?? null,
        p.deskItemId,
        p.at,
        p.dueAt,
      ],
    );
    await exec(
      tx,
      `UPDATE pr_reviews SET review_state='size_exception_pending'
        WHERE id = ANY($1::uuid[]) AND review_state='needs_split'`,
      [p.chainPrReviewIds],
    );
  },
  SizeExceptionApproved: async (tx, e) => {
    const p = (e.event as EventOf<'SizeExceptionApproved'>).payload;
    await exec(
      tx,
      `UPDATE pr_reviews SET review_state='not_reviewed', split_reason=NULL, split_at=NULL, split_total=NULL,
              split_budget=NULL, split_unit=NULL, split_members=NULL
        WHERE review_state='size_exception_pending'
          AND id IN (SELECT unnest(chain_pr_review_ids) FROM pr_size_exceptions WHERE id=$1)`,
      [p.sizeExceptionId],
    );
    await exec(
      tx,
      `UPDATE pr_size_exceptions SET state='approved', decided_at=$2, decided_by=$3, note=$4
        WHERE id=$1 AND state='pending'`,
      [p.sizeExceptionId, p.at, p.by, p.note ?? null],
    );
  },
  SizeExceptionRejected: async (tx, e) => {
    const p = (e.event as EventOf<'SizeExceptionRejected'>).payload;
    await exec(tx, backToNeedsSplit, [p.sizeExceptionId]);
    await exec(
      tx,
      `UPDATE pr_size_exceptions SET state='rejected', decided_at=$2, decided_by=$3, note=$4
        WHERE id=$1 AND state='pending'`,
      [p.sizeExceptionId, p.at, p.by, p.note ?? null],
    );
  },
  SizeExceptionLapsed: async (tx, e) => {
    const p = (e.event as EventOf<'SizeExceptionLapsed'>).payload;
    await exec(tx, backToNeedsSplit, [p.sizeExceptionId]);
    await exec(
      tx,
      `UPDATE pr_size_exceptions SET state='lapsed', decided_at=$2 WHERE id=$1 AND state='pending'`,
      [p.sizeExceptionId, p.at],
    );
  },
  SizeExceptionWithdrawn: async (tx, e) => {
    const p = (e.event as EventOf<'SizeExceptionWithdrawn'>).payload;
    if (p.cause === 'grew') {
      await exec(
        tx,
        `UPDATE pr_size_exceptions SET state='superseded', decided_at=COALESCE(decided_at, $2)
          WHERE id=$1 AND state='approved'`,
        [p.sizeExceptionId, p.at],
      );
      return;
    }
    await exec(tx, backToNeedsSplit, [p.sizeExceptionId]);
    await exec(
      tx,
      `UPDATE pr_size_exceptions SET state='withdrawn', decided_at=$2 WHERE id=$1 AND state='pending'`,
      [p.sizeExceptionId, p.at],
    );
  },
};
