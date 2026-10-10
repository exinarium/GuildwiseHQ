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
  },
  BlogPostRejected: async (tx, e) => {
    const p = (e.event as EventOf<'BlogPostRejected'>).payload;
    await exec(
      tx,
      `UPDATE blog_posts SET status='rejected', rejection_reason=$2, updated_at=$3 WHERE id=$1`,
      [p.postId, p.reason, e.createdAt],
    );
  },
  BlogPostUnpublished: async (tx, e) => {
    const p = (e.event as EventOf<'BlogPostUnpublished'>).payload;
    await exec(tx, `UPDATE blog_posts SET status='unpublished', updated_at=$2 WHERE id=$1`, [
      p.postId,
      e.createdAt,
    ]);
  },
};
