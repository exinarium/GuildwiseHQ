import { randomUUID } from 'node:crypto';
import {
  BLOG_AUTHOR,
  BLOG_LIMITS,
  type BlogContent,
  type BlogPost,
  type BlogSettings,
  type BlogShare,
  type BlogStatus,
  markdownLinks,
  type PublicBlogPost,
  type PublicBlogPostFull,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { sha256Hex } from '../crypto.ts';
import { exec, iso, one, type Row, rows } from '../db/sql.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import { SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * The platform blog (docs/design/blog-prd.md, owner decisions in docs/design/open-questions-2026-10-09.md): posts are
 * event-sourced (`BlogPost*`), the moderation mode and the kill switch are platform settings.
 *
 * Moderation: every post enters `in_review`. For the first two weeks (until `autoPublishFrom`) the owner reviews each
 * one; afterwards a post that raised no content warning publishes by itself once it has waited `holdHours` in review
 * (`blogTick`). The kill switch (`enabled = false`) stops creating (the API answers 503 `blog_disabled`) and
 * publishing (manual, auto, digest and social) alike; reading what is already published and unpublishing still work.
 */

export const DEFAULT_HOLD_HOURS = 3;
export const REVIEW_PERIOD_DAYS = 14;
const HOUR = 3600_000;

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
export const blogStream = (postId: string) => `blog-${postId}`;

// ---- settings

async function setting(ctx: Ctx, key: string): Promise<{ present: boolean; value: unknown }> {
  const r = await one(ctx.pool, 'SELECT value FROM platform_settings WHERE key=$1', [key]);
  return { present: !!r, value: r?.value };
}
async function putSetting(ctx: Ctx, by: string | null, key: string, value: unknown): Promise<void> {
  await exec(
    ctx.pool,
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, $4)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
    [key, JSON.stringify(value), by, ctx.clock.now()],
  );
}

/**
 * The effective moderation settings. `autoPublishFrom` that was never set is the first post's creation plus two weeks
 * (the owner's review period starts with the first post); explicitly `null` means "never auto-publish".
 */
export async function blogSettings(ctx: Ctx): Promise<BlogSettings> {
  const enabled = await setting(ctx, 'blog_enabled');
  const from = await setting(ctx, 'blog_auto_publish_from');
  const hold = await setting(ctx, 'blog_hold_hours');
  const digest = await setting(ctx, 'blog_digest_enabled');
  let autoPublishFrom: string | null = null;
  if (from.present) autoPublishFrom = typeof from.value === 'string' ? from.value : null;
  else {
    const first = await one(ctx.pool, 'SELECT min(created_at) AS t FROM blog_posts');
    if (first?.t)
      autoPublishFrom = new Date(new Date(first.t).getTime() + REVIEW_PERIOD_DAYS * 24 * HOUR).toISOString();
  }
  const reviewAll = !autoPublishFrom || ctx.clock.now() < new Date(autoPublishFrom);
  return {
    enabled: enabled.value !== false,
    autoPublishFrom,
    holdHours: typeof hold.value === 'number' ? hold.value : DEFAULT_HOLD_HOURS,
    digestEnabled: digest.value !== false,
    reviewAll,
  };
}

export const blogEnabled = async (ctx: Ctx): Promise<boolean> => (await blogSettings(ctx)).enabled;

export function assertBlogEnabled(enabled: boolean): void {
  if (!enabled) throw new HttpError(503, 'blog_disabled', 'the blog is switched off by the platform');
}

export async function patchBlogSettings(
  ctx: Ctx,
  by: AuthSession['user'],
  patch: {
    enabled?: boolean | undefined;
    autoPublishFrom?: string | null | undefined;
    holdHours?: number | undefined;
    digestEnabled?: boolean | undefined;
  },
): Promise<BlogSettings> {
  const change: Record<string, unknown> = {};
  if (patch.enabled !== undefined) {
    await putSetting(ctx, by.id, 'blog_enabled', patch.enabled);
    change.enabled = patch.enabled;
  }
  if (patch.autoPublishFrom !== undefined) {
    await putSetting(ctx, by.id, 'blog_auto_publish_from', patch.autoPublishFrom);
    change.autoPublishFrom = patch.autoPublishFrom;
  }
  if (patch.holdHours !== undefined) {
    await putSetting(ctx, by.id, 'blog_hold_hours', patch.holdHours);
    change.holdHours = patch.holdHours;
  }
  if (patch.digestEnabled !== undefined) {
    await putSetting(ctx, by.id, 'blog_digest_enabled', patch.digestEnabled);
    change.digestEnabled = patch.digestEnabled;
  }
  if (Object.keys(change).length)
    await ctx.store.append([
      {
        streamId: 'blog-settings',
        event: { type: 'BlogSettingsChanged', payload: { change, by: by.id } },
        actor: userActor(by.id),
        scope: adminScope,
      },
    ]);
  return blogSettings(ctx);
}

// ---- content checks

const SHORTENERS = [
  'bit.ly',
  't.co',
  'tinyurl.com',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
];
const INJECTION =
  /ignore (all |any )?(previous|prior|above) (instructions|prompts?)|disregard (the )?(previous|above)|you are now|system prompt/i;

const normUrl = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
};

/** Findings that keep a post from auto-publishing (the owner still sees it). */
export function contentWarnings(c: BlogContent): string[] {
  const out: string[] = [];
  const links = markdownLinks(c.bodyMarkdown).filter((l) => /^https?:/i.test(l));
  if (links.length > 15) out.push(`${links.length} links in the body (more than 15)`);
  const sources = new Set(c.sources.map((s) => normUrl(s.url)));
  const stray = links.filter((l) => !sources.has(normUrl(l)));
  if (stray.length)
    out.push(`${stray.length} link(s) not listed in sources: ${stray.slice(0, 3).join(', ')}`);
  for (const l of links) {
    try {
      const h = new URL(l).hostname.replace(/^www\./, '').toLowerCase();
      if (SHORTENERS.includes(h)) out.push(`link shortener: ${h}`);
    } catch {
      // not a URL
    }
  }
  const text = `${c.title}\n${c.summary}\n${c.bodyMarkdown}`;
  if (INJECTION.test(text)) out.push('text that looks like an instruction to an AI');
  if (/[A-Za-z0-9+/]{200,}={0,2}/.test(c.bodyMarkdown)) out.push('a large base64-like block');
  return [...new Set(out)];
}

/** Rules that reject a post outright (the agent can fix and retry). */
export function contentErrors(c: BlogContent): Array<{ field: string; message: string }> {
  const out: Array<{ field: string; message: string }> = [];
  if (c.tags.includes('industry-news') && c.sources.length < 2)
    out.push({ field: 'sources', message: 'posts tagged industry-news need at least 2 sources' });
  if (new Set(c.tags).size !== c.tags.length) out.push({ field: 'tags', message: 'duplicate tags' });
  return out;
}

export const contentHash = (c: BlogContent): string => sha256Hex(`${c.title}\n${c.bodyMarkdown}`);

// ---- reading

const SELECT_POST = `SELECT p.*, k.name AS key_name, u.display_name AS user_name FROM blog_posts p
  LEFT JOIN blog_api_keys k ON k.id = p.origin_key_id LEFT JOIN users u ON u.id = p.origin_user_id`;

async function sharesOf(ctx: Ctx, postIds: string[]): Promise<Map<string, BlogShare[]>> {
  const m = new Map<string, BlogShare[]>();
  if (!postIds.length) return m;
  const rs = await rows(
    ctx.pool,
    'SELECT * FROM social_shares WHERE post_id = ANY($1::uuid[]) ORDER BY network',
    [postIds],
  );
  for (const r of rs) {
    const list = m.get(r.post_id) ?? [];
    list.push({
      network: r.network,
      status: r.status === 'posting' ? 'pending' : r.status,
      attempts: r.attempts,
      externalId: r.external_id,
      url: r.url,
      error: r.error,
      nextAttemptAt: iso(r.next_attempt_at),
    });
    m.set(r.post_id, list);
  }
  return m;
}

export function postDto(r: Row, settings: BlogSettings, shares: BlogShare[] = []): BlogPost {
  const content = r.content as BlogContent;
  let autoPublishAt: string | null = null;
  if (
    r.status === 'in_review' &&
    settings.enabled &&
    settings.autoPublishFrom &&
    (r.warnings as string[]).length === 0 &&
    r.review_since &&
    new Date(r.review_since) >= new Date(settings.autoPublishFrom)
  )
    autoPublishAt = new Date(new Date(r.review_since).getTime() + settings.holdHours * HOUR).toISOString();
  return {
    ...content,
    id: r.id,
    status: r.status as BlogStatus,
    rejectionReason: r.rejection_reason ?? null,
    publishedAt: iso(r.published_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
    readingMinutes: r.reading_minutes,
    wordCount: r.word_count,
    warnings: r.warnings ?? [],
    origin: r.key_name ?? r.user_name ?? null,
    autoPublishAt,
    shares,
  };
}

export async function listPosts(
  ctx: Ctx,
  q: {
    status?: BlogStatus | undefined;
    keyId?: string | undefined;
    since?: string | undefined;
    tag?: string | undefined;
    q?: string | undefined;
    limit?: number | undefined;
  },
): Promise<BlogPost[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };
  if (q.status) add('p.status = ?', q.status);
  if (q.keyId) add(`(p.status = 'published' OR p.origin_key_id = ?)`, q.keyId);
  if (q.since) {
    const d = new Date(q.since);
    if (!Number.isNaN(d.getTime())) add('p.created_at >= ?', d);
  }
  if (q.tag) add('? = ANY(p.tags)', q.tag);
  if (q.q) add(`(p.title ILIKE ? OR p.summary ILIKE ?)`, `%${q.q.replace(/[%_]/g, '')}%`);
  const sql = `${SELECT_POST} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(p.published_at, p.created_at) DESC LIMIT ${Math.min(q.limit ?? 100, 200)}`;
  const rs = await rows(ctx.pool, sql, params);
  const settings = await blogSettings(ctx);
  const shares = await sharesOf(
    ctx,
    rs.map((r) => r.id),
  );
  return rs.map((r) => postDto(r, settings, shares.get(r.id) ?? []));
}

export async function getPostRow(ctx: Ctx, where: 'id' | 'slug', value: string): Promise<Row | undefined> {
  return one(ctx.pool, `${SELECT_POST} WHERE p.${where} = $1`, [value]);
}

export async function getPost(ctx: Ctx, where: 'id' | 'slug', value: string): Promise<BlogPost> {
  const r = await getPostRow(ctx, where, value);
  if (!r) throw notFound('post not found', 'post_not_found');
  const settings = await blogSettings(ctx);
  const sh = await sharesOf(ctx, [r.id]);
  return postDto(r, settings, sh.get(r.id) ?? []);
}

export async function pendingCount(ctx: Ctx): Promise<number> {
  const r = await one(ctx.pool, `SELECT count(*)::int AS n FROM blog_posts WHERE status='in_review'`);
  return r?.n ?? 0;
}

// ---- public reading (published posts only)

const postUrl = (ctx: Ctx, slug: string) => `${ctx.config.publicOrigin}/blog/${slug}`;

function publicDto(ctx: Ctx, r: Row): PublicBlogPost {
  const c = r.content as BlogContent;
  return {
    slug: r.slug,
    title: r.title,
    summary: r.summary,
    coverImage: c.coverImage,
    tags: r.tags,
    publishedAt: iso(r.published_at) as string,
    updatedAt: iso(r.updated_at) as string,
    readingMinutes: r.reading_minutes,
    url: postUrl(ctx, r.slug),
  };
}

export async function listPublished(
  ctx: Ctx,
  o: { tag?: string | undefined; limit?: number; offset?: number; q?: string | undefined } = {},
): Promise<{ posts: PublicBlogPost[]; total: number }> {
  const params: unknown[] = [];
  let where = `status='published'`;
  if (o.tag) {
    params.push(o.tag);
    where += ` AND $${params.length} = ANY(tags)`;
  }
  if (o.q) {
    params.push(`%${o.q.replace(/[%_]/g, '')}%`);
    where += ` AND (title ILIKE $${params.length} OR summary ILIKE $${params.length})`;
  }
  const total =
    (await one(ctx.pool, `SELECT count(*)::int AS n FROM blog_posts WHERE ${where}`, params))?.n ?? 0;
  params.push(o.limit ?? 12, o.offset ?? 0);
  const rs = await rows(
    ctx.pool,
    `SELECT * FROM blog_posts WHERE ${where} ORDER BY published_at DESC, id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { posts: rs.map((r) => publicDto(ctx, r)), total };
}

/** `gone` for a post that was published once and then taken down (410), `null` for an unknown slug (404). */
export async function getPublished(
  ctx: Ctx,
  slug: string,
): Promise<{ post: PublicBlogPostFull; row: Row } | 'gone' | null> {
  const r = await one(ctx.pool, 'SELECT * FROM blog_posts WHERE slug=$1', [slug]);
  if (!r) return null;
  if (r.status === 'unpublished') return 'gone';
  if (r.status !== 'published') return null;
  const c = r.content as BlogContent;
  return {
    row: r,
    post: { ...publicDto(ctx, r), bodyMarkdown: c.bodyMarkdown, sources: c.sources, author: BLOG_AUTHOR },
  };
}

export async function publishedTags(ctx: Ctx): Promise<Array<{ tag: string; count: number }>> {
  return rows(
    ctx.pool,
    `SELECT t AS tag, count(*)::int AS count FROM blog_posts, unnest(tags) t WHERE status='published' GROUP BY t ORDER BY count DESC, t`,
  );
}

export async function postsCount(ctx: Ctx): Promise<number> {
  return (await one(ctx.pool, 'SELECT count(*)::int AS n FROM blog_posts'))?.n ?? 0;
}

export async function lastPublishedChange(ctx: Ctx): Promise<Date | null> {
  const r = await one(
    ctx.pool,
    `SELECT max(updated_at) AS t FROM blog_posts WHERE status IN ('published','unpublished')`,
  );
  return r?.t ? new Date(r.t) : null;
}

// ---- writing

export type Origin = { apiKeyId?: string; userId?: string };

/** Creates a post. API submissions enter review; a super admin's own first save is a draft. */
export async function submitPost(
  ctx: Ctx,
  content: BlogContent,
  origin: Origin,
  status: 'draft' | 'in_review',
): Promise<{ post: BlogPost; created: boolean }> {
  assertBlogEnabled(await blogEnabled(ctx));
  const errs = contentErrors(content);
  if (errs.length) throw badRequest('validation_error', 'the post breaks a content rule', errs);
  const hash = contentHash(content);
  const existing = await getPostRow(ctx, 'slug', content.slug);
  if (existing) {
    if (existing.content_hash === hash)
      return { post: await getPost(ctx, 'slug', content.slug), created: false };
    throw conflict(
      'slug_taken',
      'a post with this slug exists with different content; PATCH it or choose another slug',
    );
  }
  const postId = randomUUID();
  await ctx.store.append([
    {
      streamId: blogStream(postId),
      event: {
        type: 'BlogPostSubmitted',
        payload: { postId, content, contentHash: hash, origin, status, warnings: contentWarnings(content) },
      },
      actor: origin.userId ? userActor(origin.userId) : SYSTEM_ACTOR,
      scope: adminScope,
    },
  ]);
  return { post: await getPost(ctx, 'id', postId), created: true };
}

export async function revisePost(
  ctx: Ctx,
  postId: string,
  patch: Partial<Omit<BlogContent, 'slug'>>,
  by: Origin,
  opts: { ownKeyOnly?: boolean } = {},
): Promise<BlogPost> {
  const r = await getPostRow(ctx, 'id', postId);
  if (!r) throw notFound('post not found', 'post_not_found');
  if (opts.ownKeyOnly) {
    if (r.origin_key_id !== by.apiKeyId) throw notFound('post not found', 'post_not_found');
    if (!['in_review', 'rejected', 'draft'].includes(r.status))
      throw conflict('not_editable', 'only a post in review or rejected can be changed through the API');
    assertBlogEnabled(await blogEnabled(ctx));
  }
  const content: BlogContent = { ...(r.content as BlogContent), ...patch };
  const errs = contentErrors(content);
  if (errs.length) throw badRequest('validation_error', 'the post breaks a content rule', errs);
  const hash = contentHash(content);
  if (hash === r.content_hash && JSON.stringify(content) === JSON.stringify(r.content))
    return getPost(ctx, 'id', postId);
  await ctx.store.append([
    {
      streamId: blogStream(postId),
      event: {
        type: 'BlogPostRevised',
        payload: {
          postId,
          content,
          contentHash: hash,
          by,
          // an API revision resubmits (a rejected post returns to the queue); a super admin's edit keeps the state
          resubmit: !!by.apiKeyId,
          warnings: contentWarnings(content),
        },
      },
      actor: by.userId ? userActor(by.userId) : SYSTEM_ACTOR,
      scope: adminScope,
    },
  ]);
  return getPost(ctx, 'id', postId);
}

export async function publishPost(
  ctx: Ctx,
  postId: string,
  who: { userId?: string; apiKeyId?: string; auto?: boolean },
): Promise<BlogPost> {
  assertBlogEnabled(await blogEnabled(ctx));
  const r = await getPostRow(ctx, 'id', postId);
  if (!r) throw notFound('post not found', 'post_not_found');
  if (r.status === 'published') return getPost(ctx, 'id', postId);
  if (r.status === 'rejected') throw conflict('post_rejected', 'a rejected post must be revised first');
  await ctx.store.append([
    {
      streamId: blogStream(postId),
      event: {
        type: 'BlogPostPublished',
        payload: {
          postId,
          auto: !!who.auto,
          by: {
            ...(who.userId ? { userId: who.userId } : {}),
            ...(who.apiKeyId ? { apiKeyId: who.apiKeyId } : {}),
          },
        },
      },
      actor: who.userId ? userActor(who.userId) : SYSTEM_ACTOR,
      scope: adminScope,
    },
  ]);
  return getPost(ctx, 'id', postId);
}

export async function rejectPost(
  ctx: Ctx,
  by: AuthSession['user'],
  postId: string,
  reason: string,
): Promise<BlogPost> {
  const r = await getPostRow(ctx, 'id', postId);
  if (!r) throw notFound('post not found', 'post_not_found');
  if (r.status === 'published') throw conflict('already_published', 'unpublish the post instead');
  await ctx.store.append([
    {
      streamId: blogStream(postId),
      event: { type: 'BlogPostRejected', payload: { postId, reason, by: by.id } },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
  return getPost(ctx, 'id', postId);
}

export async function unpublishPost(ctx: Ctx, by: AuthSession['user'], postId: string): Promise<BlogPost> {
  const r = await getPostRow(ctx, 'id', postId);
  if (!r) throw notFound('post not found', 'post_not_found');
  if (r.status !== 'published') throw conflict('not_published', 'the post is not published');
  await ctx.store.append([
    {
      streamId: blogStream(postId),
      event: { type: 'BlogPostUnpublished', payload: { postId, by: by.id } },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
  return getPost(ctx, 'id', postId);
}

// ---- the tick: auto-publish after the hold

/** Publishes the posts whose hold has passed. Does nothing while the blog is switched off. */
export async function autoPublishDue(ctx: Ctx): Promise<number> {
  const s = await blogSettings(ctx);
  if (!s.enabled || !s.autoPublishFrom) return 0;
  const now = ctx.clock.now();
  if (now < new Date(s.autoPublishFrom)) return 0;
  const due = await rows(
    ctx.pool,
    `SELECT id FROM blog_posts WHERE status='in_review' AND warnings = '[]'::jsonb
        AND review_since >= $1 AND review_since <= $2 ORDER BY review_since`,
    [new Date(s.autoPublishFrom), new Date(now.getTime() - s.holdHours * HOUR)],
  );
  let n = 0;
  for (const d of due) {
    try {
      await publishPost(ctx, d.id, { auto: true });
      n++;
    } catch (err) {
      ctx.log.error({ err, postId: d.id }, 'auto-publish failed');
    }
  }
  return n;
}

export { BLOG_LIMITS };
