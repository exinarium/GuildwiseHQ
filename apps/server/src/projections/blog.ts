import { type EventOf, readingMinutes, wordCount } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector } from '../eventstore/types.ts';

/** blog_posts: one row per post, the latest revision's content plus the moderation state. */

const stats = (body: string) => {
  const w = wordCount(body);
  return { words: w, minutes: readingMinutes(w) };
};

export const blogProjectors: Record<string, Projector> = {
  BlogPostSubmitted: async (tx, e) => {
    const p = (e.event as EventOf<'BlogPostSubmitted'>).payload;
    const s = stats(p.content.bodyMarkdown);
    await exec(
      tx,
      `INSERT INTO blog_posts (id, slug, content, title, summary, tags, status, content_hash, origin_key_id,
         origin_user_id, warnings, word_count, reading_minutes, review_since, created_at, updated_at, launch, origin_system)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17)
       ON CONFLICT (id) DO NOTHING`,
      [
        p.postId,
        p.content.slug,
        JSON.stringify(p.content),
        p.content.title,
        p.content.summary,
        p.content.tags,
        p.status,
        p.contentHash,
        p.origin.apiKeyId ?? null,
        p.origin.userId ?? null,
        JSON.stringify(p.warnings),
        s.words,
        s.minutes,
        p.status === 'in_review' ? e.createdAt : null,
        e.createdAt,
        p.launch ?? false,
        p.origin.system ?? null,
      ],
    );
    if (p.topicId)
      await exec(
        tx,
        `UPDATE blog_topics SET status='drafted', post_id=$2, updated_at=$3
          WHERE id=$1 AND status IN ('queued','writing')`,
        [p.topicId, p.postId, e.createdAt],
      );
  },
  BlogPostRevised: async (tx, e) => {
    const p = (e.event as EventOf<'BlogPostRevised'>).payload;
    const s = stats(p.content.bodyMarkdown);
    await exec(
      tx,
      `UPDATE blog_posts SET content=$2, title=$3, summary=$4, tags=$5, content_hash=$6, warnings=$7,
         word_count=$8, reading_minutes=$9, updated_at=$10,
         status = CASE WHEN $11::boolean AND status IN ('draft','rejected') THEN 'in_review' ELSE status END,
         review_since = CASE WHEN $11::boolean AND status IN ('draft','rejected') THEN $10 ELSE review_since END,
         rejection_reason = CASE WHEN $11::boolean AND status IN ('draft','rejected') THEN NULL ELSE rejection_reason END
       WHERE id=$1`,
      [
        p.postId,
        JSON.stringify(p.content),
        p.content.title,
        p.content.summary,
        p.content.tags,
        p.contentHash,
        JSON.stringify(p.warnings),
        s.words,
        s.minutes,
        e.createdAt,
        p.resubmit,
      ],
    );
  },
  BlogPostPublished: async (tx, e) => {
    const p = (e.event as EventOf<'BlogPostPublished'>).payload;
    await exec(
      tx,
      `UPDATE blog_posts SET status='published', published_at=COALESCE(published_at,$2), updated_at=$2,
         rejection_reason=NULL WHERE id=$1`,
      [p.postId, e.createdAt],
    );
    await exec(
      tx,
      `UPDATE blog_topics SET status='published', updated_at=$2 WHERE post_id=$1 AND status IN ('drafted','published')`,
      [p.postId, e.createdAt],
    );
  },
  BlogPostRejected: async (tx, e) => {
    const p = (e.event as EventOf<'BlogPostRejected'>).payload;
    await exec(
      tx,
      `UPDATE blog_posts SET status='rejected', rejection_reason=$2, updated_at=$3 WHERE id=$1`,
      [p.postId, p.reason, e.createdAt],
    );
    // The article for a queued topic was rejected: the topic gets one more attempt, then it is declined.
    await exec(
      tx,
      `UPDATE blog_topics SET status = CASE WHEN attempts >= 2 THEN 'declined' ELSE 'queued' END,
         reason = 'the article was rejected', post_id = NULL, updated_at=$2
       WHERE post_id=$1 AND status='drafted'`,
      [p.postId, e.createdAt],
    );
  },
  BlogPostUnpublished: async (tx, e) => {
    const p = (e.event as EventOf<'BlogPostUnpublished'>).payload;
    await exec(tx, `UPDATE blog_posts SET status='unpublished', updated_at=$2 WHERE id=$1`, [
      p.postId,
      e.createdAt,
    ]);
  },
  // ---- the research-topic queue (docs/design/ceo-blog-topics.md): no organization appears in any of these
  BlogTopicQueued: async (tx, e) => {
    const p = (e.event as EventOf<'BlogTopicQueued'>).payload;
    await exec(
      tx,
      `INSERT INTO blog_topics (id, question, area, origin, status, queued_at, sort_at, updated_at)
       VALUES ($1,$2,$3,$4,'queued',$5,$5,$5) ON CONFLICT (id) DO NOTHING`,
      [p.topicId, p.question, p.area, p.origin, e.createdAt],
    );
  },
  BlogTopicWriting: async (tx, e) => {
    const p = (e.event as EventOf<'BlogTopicWriting'>).payload;
    await exec(
      tx,
      `UPDATE blog_topics SET status='writing', attempts=attempts+1, run_id=$2, updated_at=$3
        WHERE id=$1 AND status='queued'`,
      [p.topicId, p.runId, e.createdAt],
    );
  },
  BlogTopicReleased: async (tx, e) => {
    const p = (e.event as EventOf<'BlogTopicReleased'>).payload;
    await exec(
      tx,
      `UPDATE blog_topics SET status = CASE WHEN attempts >= 2 THEN 'declined' ELSE 'queued' END,
         reason=$2, updated_at=$3
       WHERE id=$1 AND status='writing'`,
      [p.topicId, p.reason, e.createdAt],
    );
  },
  BlogTopicDeclined: async (tx, e) => {
    const p = (e.event as EventOf<'BlogTopicDeclined'>).payload;
    await exec(
      tx,
      `UPDATE blog_topics SET status='declined', reason=$2, updated_at=$3
        WHERE id=$1 AND status IN ('queued','writing')`,
      [p.topicId, p.reason, e.createdAt],
    );
  },
  BlogTopicRejected: async (tx, e) => {
    const p = (e.event as EventOf<'BlogTopicRejected'>).payload;
    await exec(
      tx,
      `UPDATE blog_topics SET status='rejected', reason=$2, updated_at=$3 WHERE id=$1 AND status='queued'`,
      [p.topicId, p.reason, e.createdAt],
    );
  },
  BlogTopicDuplicate: async (tx, e) => {
    const p = (e.event as EventOf<'BlogTopicDuplicate'>).payload;
    await exec(
      tx,
      `UPDATE blog_topics SET status='duplicate', post_id=$2, reason=$3, updated_at=$4 WHERE id=$1 AND status='queued'`,
      [
        p.topicId,
        p.postId ?? null,
        p.postId ? 'a published post already covers it' : 'a queued topic already covers it',
        e.createdAt,
      ],
    );
  },
  BlogTopicMoved: async (tx, e) => {
    const p = (e.event as EventOf<'BlogTopicMoved'>).payload;
    await exec(
      tx,
      `UPDATE blog_topics SET sort_at = COALESCE((SELECT min(sort_at) FROM blog_topics WHERE status='queued'), $2) - interval '1 second',
         updated_at=$2
       WHERE id=$1 AND status='queued'`,
      [p.topicId, e.createdAt],
    );
  },
};
