import { randomUUID } from 'node:crypto';
import {
  type BlogTopic,
  type BlogTopicList,
  type ScrubbedTopic,
  type TopicOrigin,
  topicWords,
} from '@aom/shared';
import { SYSTEM_ACTOR, userActor } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { conflict, notFound } from '../errors.ts';

/**
 * The blog writer's topic queue (docs/design/ceo-blog-topics.md, Phase 1). Platform side only: this module, like all of
 * `blog/**`, never reads organization data (`blog-writer-boundary.test.ts` enforces it). A topic is a question, an
 * area and a bucket (`platform` or `customer`); there is nothing in the queue that names an organization.
 */

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
export const TOPICS_STREAM = 'blog-topics';
const DAY = 86_400_000;
/** The share of the shorter question's words that another question or title must share to count as the same topic. */
const DUPLICATE_OVERLAP = 0.6;
const DUPLICATE_WINDOW_DAYS = 180;

function dto(r: Row): BlogTopic {
  return {
    id: r.id,
    question: r.question,
    area: r.area,
    origin: r.origin,
    status: r.status,
    reason: r.reason,
    postId: r.post_id,
    slug: r.slug ?? null,
    queuedAt: iso(r.queued_at) as string,
    updatedAt: iso(r.updated_at) as string,
  };
}

/** Queue first (in order), then what happened to the rest, newest first. */
export async function listTopics(ctx: Ctx, limit = 200): Promise<BlogTopicList> {
  const list = await rows(
    ctx.pool,
    `SELECT t.*, p.slug FROM blog_topics t LEFT JOIN blog_posts p ON p.id = t.post_id
      ORDER BY (t.status = 'queued') DESC,
               CASE WHEN t.status = 'queued' THEN t.sort_at END ASC,
               t.updated_at DESC, t.id
      LIMIT $1`,
    [limit],
  );
  const queued = await one(ctx.pool, `SELECT count(*)::int AS n FROM blog_topics WHERE status='queued'`);
  return { topics: list.map(dto), queued: queued?.n ?? 0 };
}

const overlap = (a: string[], b: string[]): number => {
  if (!a.length || !b.length) return 0;
  const set = new Set(b);
  const shared = a.filter((w) => set.has(w)).length;
  return shared / Math.min(a.length, b.length);
};

/** The post or topic that already covers this question (question text against questions and published titles only). */
async function findDuplicate(
  ctx: Ctx,
  question: string,
): Promise<{ postId?: string; ofTopicId?: string } | null> {
  const mine = topicWords(question);
  if (mine.length < 3) return null;
  const since = new Date(ctx.clock.now().getTime() - DUPLICATE_WINDOW_DAYS * DAY);
  for (const t of await rows(
    ctx.pool,
    `SELECT id, question FROM blog_topics
      WHERE status IN ('queued','writing','drafted','published') AND queued_at >= $1`,
    [since],
  ))
    if (overlap(mine, topicWords(t.question)) >= DUPLICATE_OVERLAP) return { ofTopicId: t.id };
  for (const p of await rows(
    ctx.pool,
    `SELECT id, title FROM blog_posts WHERE status='published' AND published_at >= $1`,
    [since],
  ))
    if (overlap(mine, topicWords(p.title)) >= DUPLICATE_OVERLAP) return { postId: p.id };
  return null;
}

/**
 * The only function that appends `BlogTopicQueued`. It takes a `ScrubbedTopic` (what `scrubTopic` returns), so a raw
 * string cannot get here. A question that an existing post or topic already covers is recorded as a `duplicate` (the
 * question text is kept for the platform's own list). `by` is a super admin typing his own question; a hand-off from an
 * organization passes none: the event then has the system actor and no causation id.
 */
export async function queueBlogTopic(
  ctx: Ctx,
  topic: ScrubbedTopic,
  origin: TopicOrigin,
  opts: { by?: string } = {},
): Promise<{ topicId: string; status: 'queued' | 'duplicate' }> {
  const topicId = randomUUID();
  const dup = await findDuplicate(ctx, topic.question);
  const actor = opts.by ? userActor(opts.by) : SYSTEM_ACTOR;
  const events = [
    {
      streamId: TOPICS_STREAM,
      event: {
        type: 'BlogTopicQueued' as const,
        payload: { topicId, question: topic.question, area: topic.area, origin },
      },
      actor,
      scope: adminScope,
    },
    ...(dup
      ? [
          {
            streamId: TOPICS_STREAM,
            event: { type: 'BlogTopicDuplicate' as const, payload: { topicId, ...dup } },
            actor: SYSTEM_ACTOR,
            scope: adminScope,
          },
        ]
      : []),
  ];
  await ctx.store.append(events);
  return { topicId, status: dup ? 'duplicate' : 'queued' };
}

async function queuedOrThrow(ctx: Ctx, topicId: string): Promise<void> {
  const r = await one(ctx.pool, 'SELECT status FROM blog_topics WHERE id=$1', [topicId]);
  if (!r) throw notFound('topic not found', 'topic_not_found');
  if (r.status !== 'queued') throw conflict('not_queued', 'only a queued topic can be changed');
}

export async function rejectTopic(ctx: Ctx, topicId: string, reason: string, by: string): Promise<void> {
  await queuedOrThrow(ctx, topicId);
  await ctx.store.append([
    {
      streamId: TOPICS_STREAM,
      event: { type: 'BlogTopicRejected', payload: { topicId, reason, by } },
      actor: userActor(by),
      scope: adminScope,
    },
  ]);
}

export async function moveTopicUp(ctx: Ctx, topicId: string, by: string): Promise<void> {
  await queuedOrThrow(ctx, topicId);
  await ctx.store.append([
    {
      streamId: TOPICS_STREAM,
      event: { type: 'BlogTopicMoved', payload: { topicId, by } },
      actor: userActor(by),
      scope: adminScope,
    },
  ]);
}

/**
 * Withdraws topics that have not been taken by the writer yet (a customer switched sharing off). The caller passes
 * topic ids only; this module learns nothing about where they came from. Returns how many were withdrawn.
 */
export async function withdrawTopics(ctx: Ctx, topicIds: string[]): Promise<number> {
  if (!topicIds.length) return 0;
  const open = await rows(
    ctx.pool,
    `SELECT id FROM blog_topics WHERE id = ANY($1::uuid[]) AND status='queued'`,
    [topicIds],
  );
  if (!open.length) return 0;
  await ctx.store.append(
    open.map((t) => ({
      streamId: TOPICS_STREAM,
      event: {
        type: 'BlogTopicRejected' as const,
        payload: { topicId: t.id, reason: 'withdrawn', by: null },
      },
      actor: SYSTEM_ACTOR,
      scope: adminScope,
    })),
  );
  return open.length;
}

/** Queued topics the writer took today (UTC) or is taking now. */
export async function queuedWrittenToday(ctx: Ctx): Promise<number> {
  const now = ctx.clock.now();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const r = await one(
    ctx.pool,
    `SELECT count(*)::int AS n FROM blog_writer_runs
      WHERE topic_id IS NOT NULL AND status IN ('ok','running') AND started_at >= $1`,
    [start],
  );
  return r?.n ?? 0;
}

/** The oldest queued topic (in queue order), without taking it. */
export async function nextQueuedTopic(
  ctx: Ctx,
): Promise<{ id: string; question: string; area: string } | null> {
  const r = await one(
    ctx.pool,
    `SELECT id, question, area FROM blog_topics WHERE status='queued' ORDER BY sort_at, id LIMIT 1`,
  );
  return r ? { id: r.id, question: r.question, area: r.area } : null;
}

/** The writer takes a topic for a run (`BlogTopicWriting`: one attempt). */
export async function markTopicWriting(ctx: Ctx, topicId: string, runId: string): Promise<void> {
  await ctx.store.append([
    {
      streamId: TOPICS_STREAM,
      event: { type: 'BlogTopicWriting', payload: { topicId, runId } },
      actor: SYSTEM_ACTOR,
      scope: adminScope,
    },
  ]);
}

/** A technical failure: the topic is queued again (or declined after its second attempt). */
export async function releaseTopic(ctx: Ctx, topicId: string, runId: string, reason: string): Promise<void> {
  await ctx.store.append([
    {
      streamId: TOPICS_STREAM,
      event: { type: 'BlogTopicReleased', payload: { topicId, runId, reason: reason.slice(0, 500) } },
      actor: SYSTEM_ACTOR,
      scope: adminScope,
    },
  ]);
}

/** The writer found no public sources for the question. */
export async function declineTopic(ctx: Ctx, topicId: string, runId: string, reason: string): Promise<void> {
  await ctx.store.append([
    {
      streamId: TOPICS_STREAM,
      event: { type: 'BlogTopicDeclined', payload: { topicId, runId, reason: reason.slice(0, 500) } },
      actor: SYSTEM_ACTOR,
      scope: adminScope,
    },
  ]);
}
