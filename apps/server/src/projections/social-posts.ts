import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** social_posts: one row per (kind, ref), the latest revision's content plus the approval state. */
export const socialPostProjectors: Record<string, Projector> = {
  SocialPostSubmitted: async (tx, e) => {
    const p = (e.event as EventOf<'SocialPostSubmitted'>).payload;
    await exec(
      tx,
      `INSERT INTO social_posts (id, kind, ref, content, title, status, origin_user_id, origin_system, review_since, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
       ON CONFLICT DO NOTHING`,
      [
        p.postId,
        p.kind,
        p.ref,
        JSON.stringify(p.content),
        p.content.title,
        p.status,
        p.origin.userId ?? null,
        p.origin.system ?? null,
        p.status === 'in_review' ? e.createdAt : null,
        e.createdAt,
      ],
    );
  },
  SocialPostRevised: async (tx, e) => {
    const p = (e.event as EventOf<'SocialPostRevised'>).payload;
    await exec(
      tx,
      `UPDATE social_posts SET content=$2, title=$3, updated_at=$4
        WHERE id=$1 AND status <> 'approved'`,
      [p.postId, JSON.stringify(p.content), p.content.title, e.createdAt],
    );
  },
  SocialPostReviewRequested: async (tx, e) => {
    const p = (e.event as EventOf<'SocialPostReviewRequested'>).payload;
    await exec(
      tx,
      `UPDATE social_posts SET status='in_review', review_since=$2, rejection_reason=NULL, updated_at=$2
        WHERE id=$1 AND status IN ('draft','rejected')`,
      [p.postId, e.createdAt],
    );
  },
  SocialPostApproved: async (tx, e) => {
    const p = (e.event as EventOf<'SocialPostApproved'>).payload;
    await exec(
      tx,
      `UPDATE social_posts SET status='approved', approved_at=COALESCE(approved_at,$2), rejection_reason=NULL, updated_at=$2
        WHERE id=$1 AND status <> 'approved'`,
      [p.postId, e.createdAt],
    );
  },
  SocialPostRejected: async (tx, e) => {
    const p = (e.event as EventOf<'SocialPostRejected'>).payload;
    await exec(
      tx,
      `UPDATE social_posts SET status='rejected', rejection_reason=$2, updated_at=$3
        WHERE id=$1 AND status <> 'approved'`,
      [p.postId, p.reason, e.createdAt],
    );
  },
};
