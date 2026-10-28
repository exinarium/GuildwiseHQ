import type { EventOf } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** video_posts (one row per kind, ref and format) and video_topics. Replay-safe: every statement is idempotent. */
export const videoPostProjectors: Record<string, Projector> = {
  VideoPostSubmitted: async (tx, e) => {
    const p = (e.event as EventOf<'VideoPostSubmitted'>).payload;
    await exec(
      tx,
      `INSERT INTO video_posts (id, kind, format, ref, parent_id, script, meta, title, revision, status, origin_user_id, origin_system, review_since, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$13)
       ON CONFLICT DO NOTHING`,
      [
        p.postId,
        p.kind,
        p.format,
        p.ref,
        p.parentId ?? null,
        p.script ? JSON.stringify(p.script) : null,
        JSON.stringify(p.meta),
        p.meta.title,
        p.status,
        p.origin.userId ?? null,
        p.origin.system ?? null,
        p.status === 'in_review' ? e.createdAt : null,
        e.createdAt,
      ],
    );
    // a tutorial written for a topic: the topic is done (its ref is the topic id)
    if (p.kind === 'tutorial')
      await exec(
        tx,
        `UPDATE video_topics SET status='drafted', post_id=$2, updated_at=$3
          WHERE id::text=$1 AND status IN ('queued','writing')`,
        [p.ref, p.postId, e.createdAt],
      );
  },
  VideoPostRevised: async (tx, e) => {
    const p = (e.event as EventOf<'VideoPostRevised'>).payload;
    await exec(
      tx,
      `UPDATE video_posts SET script=$2, meta=$3, title=$4, revision=$5, updated_at=$6,
              status = CASE WHEN status='rejected' THEN 'in_review' ELSE status END,
              review_since = CASE WHEN status='rejected' THEN $6 ELSE review_since END,
              rejection_reason = NULL
        WHERE id=$1 AND status <> 'approved'`,
      [
        p.postId,
        p.script ? JSON.stringify(p.script) : null,
        JSON.stringify(p.meta),
        p.meta.title,
        p.revision,
        e.createdAt,
      ],
    );
  },
  VideoPostApproved: async (tx, e) => {
    const p = (e.event as EventOf<'VideoPostApproved'>).payload;
    await exec(
      tx,
      `UPDATE video_posts SET status='approved', approved_render_id=$2, approved_at=COALESCE(approved_at,$3),
              rejection_reason=NULL, updated_at=$3
        WHERE id=$1 AND status <> 'approved'`,
      [p.postId, p.renderId, e.createdAt],
    );
  },
  VideoPostRejected: async (tx, e) => {
    const p = (e.event as EventOf<'VideoPostRejected'>).payload;
    await exec(
      tx,
      `UPDATE video_posts SET status='rejected', rejection_reason=$2, updated_at=$3
        WHERE id=$1 AND status <> 'approved'`,
      [p.postId, p.reason, e.createdAt],
    );
  },
  VideoTopicQueued: async (tx, e) => {
    const p = (e.event as EventOf<'VideoTopicQueued'>).payload;
    await exec(
      tx,
      `INSERT INTO video_topics (id, title, brief, origin, status, queued_at, sort_at, updated_at)
       VALUES ($1,$2,$3,$4,'queued',$5,$5,$5) ON CONFLICT DO NOTHING`,
      [p.topicId, p.title, p.brief, p.origin, e.createdAt],
    );
  },
  VideoTopicTaken: async (tx, e) => {
    const p = (e.event as EventOf<'VideoTopicTaken'>).payload;
    await exec(
      tx,
      `UPDATE video_topics SET status='writing', attempts=attempts+1, updated_at=$2 WHERE id=$1 AND status='queued'`,
      [p.topicId, e.createdAt],
    );
  },
  VideoTopicReleased: async (tx, e) => {
    const p = (e.event as EventOf<'VideoTopicReleased'>).payload;
    await exec(
      tx,
      `UPDATE video_topics
          SET status = CASE WHEN attempts >= 2 THEN 'rejected' ELSE 'queued' END,
              reason = COALESCE($2, reason), updated_at=$3
        WHERE id=$1 AND status='writing'`,
      [p.topicId, p.reason ?? null, e.createdAt],
    );
  },
  VideoTopicRejected: async (tx, e) => {
    const p = (e.event as EventOf<'VideoTopicRejected'>).payload;
    await exec(
      tx,
      `UPDATE video_topics SET status='rejected', reason=$2, updated_at=$3 WHERE id=$1 AND status IN ('queued','writing')`,
      [p.topicId, p.reason, e.createdAt],
    );
  },
  VideoTopicMoved: async (tx, e) => {
    const p = (e.event as EventOf<'VideoTopicMoved'>).payload;
    await exec(
      tx,
      `UPDATE video_topics SET sort_at = (SELECT COALESCE(min(sort_at), $2) - interval '1 second' FROM video_topics WHERE status='queued'),
              updated_at=$2 WHERE id=$1 AND status='queued'`,
      [p.topicId, e.createdAt],
    );
  },
};
