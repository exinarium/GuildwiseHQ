import { randomUUID } from 'node:crypto';
import {
  type BlogShare,
  type Release,
  type ReleaseList,
  type SocialPost,
  type SocialPostContent,
  SocialPostContentSchema,
  type SocialPostKind,
  type SocialPostStatus,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { getRelease, loadReleases } from '../blog/releases.ts';
import type { Ctx } from '../context.ts';
import { iso, one, type Row, rows } from '../db/sql.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { assertBlogEnabled, blogEnabled, type Origin } from './blog.ts';
import { SYSTEM_ACTOR, userActor } from './common.ts';

/**
 * Social posts that are not articles: today the announcement of a release (`kind: 'release'`, `ref: <version>`).
 *
 * Event-sourced (`SocialPost*`, projection `social_posts`), one post per kind and ref. A post is drafted by the super admin
 * ("write by hand") or by a hosting business's drafter (`origin.system`), goes to `in_review` and is posted ONLY after the
 * super admin approves it: a release post never publishes by itself. The sweep in `social.ts` shares an approved post once
 * per connected network, like a blog post.
 */

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;
export const socialPostStream = (postId: string) => `social-post-${postId}`;

const SELECT = `SELECT p.*, u.display_name AS user_name FROM social_posts p LEFT JOIN users u ON u.id = p.origin_user_id`;

async function sharesOf(ctx: Ctx, postIds: string[]): Promise<Map<string, BlogShare[]>> {
  const m = new Map<string, BlogShare[]>();
  if (!postIds.length) return m;
  const rs = await rows(
    ctx.pool,
    `SELECT * FROM social_shares WHERE source='social' AND post_id = ANY($1::uuid[]) ORDER BY network`,
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

function dto(r: Row, shares: BlogShare[] = []): SocialPost {
  return {
    id: r.id,
    kind: r.kind as SocialPostKind,
    ref: r.ref,
    status: r.status as SocialPostStatus,
    title: r.title,
    content: r.content as SocialPostContent,
    rejectionReason: r.rejection_reason ?? null,
    origin: r.user_name ?? (r.origin_system === 'blog-writer' ? 'Blog writer' : null),
    reviewSince: iso(r.review_since),
    approvedAt: iso(r.approved_at),
    createdAt: iso(r.created_at) as string,
    updatedAt: iso(r.updated_at) as string,
    shares,
  };
}

async function row(
  ctx: Ctx,
  where: 'id' | 'ref',
  value: string,
  kind?: SocialPostKind,
): Promise<Row | undefined> {
  if (where === 'id') return one(ctx.pool, `${SELECT} WHERE p.id = $1`, [value]);
  return one(ctx.pool, `${SELECT} WHERE p.kind = $1 AND p.ref = $2`, [kind ?? 'release', value]);
}

export async function getSocialPost(ctx: Ctx, id: string): Promise<SocialPost> {
  const r = await row(ctx, 'id', id);
  if (!r) throw notFound('post not found', 'post_not_found');
  return dto(r, (await sharesOf(ctx, [r.id])).get(r.id) ?? []);
}

export async function pendingSocialPosts(ctx: Ctx): Promise<number> {
  return (
    (await one(ctx.pool, `SELECT count(*)::int AS n FROM social_posts WHERE status='in_review'`))?.n ?? 0
  );
}

/** The releases of the product, newest first, each with the post that announces it (if any). */
export async function listReleases(ctx: Ctx): Promise<ReleaseList> {
  const releases = loadReleases(ctx);
  const rs = await rows(ctx.pool, `${SELECT} WHERE p.kind='release'`);
  const shares = await sharesOf(
    ctx,
    rs.map((r) => r.id),
  );
  const byRef = new Map(rs.map((r) => [r.ref as string, dto(r, shares.get(r.id) ?? [])]));
  return {
    releases: releases.map((r) => ({ ...r, post: byRef.get(r.version) ?? null })),
    pending: await pendingSocialPosts(ctx),
  };
}

/**
 * The newest release that is at most `maxAgeDays` old (by its changelog date) and has no post of any status yet: a
 * rejected or deleted-by-hand announcement is never drafted again. Null when there is none.
 */
export async function newestUnannouncedRelease(ctx: Ctx, maxAgeDays: number): Promise<Release | null> {
  const now = ctx.clock.now().getTime();
  const taken = new Set(
    (await rows(ctx.pool, `SELECT ref FROM social_posts WHERE kind='release'`)).map((r) => r.ref as string),
  );
  const fresh = loadReleases(ctx)
    .filter((r) => !taken.has(r.version))
    .filter((r) => {
      const age = now - Date.parse(`${r.date}T00:00:00Z`);
      return Number.isFinite(age) && age <= maxAgeDays * 86400_000;
    })
    .sort(
      (a, b) =>
        b.date.localeCompare(a.date) || b.version.localeCompare(a.version, undefined, { numeric: true }),
    );
  return fresh[0] ?? null;
}

/**
 * Creates the post for a release. Idempotent: a release that already has a post returns it (`created: false`) whatever
 * the content. `status` is `draft` for the super admin's own start and `in_review` for a drafter's finished text.
 * Both the hosted drafter and the platform route come through here.
 */
export async function submitSocialPost(
  ctx: Ctx,
  input: { kind: SocialPostKind; ref: string; content: SocialPostContent },
  origin: Origin,
  status: 'draft' | 'in_review',
): Promise<{ post: SocialPost; created: boolean }> {
  assertBlogEnabled(await blogEnabled(ctx));
  const content = SocialPostContentSchema.parse(input.content);
  if (content.version !== input.ref)
    throw badRequest('validation_error', 'the post is for another version than its ref');
  const release = getRelease(input.ref, ctx);
  if (!release) throw badRequest('unknown_release', `there is no release ${input.ref} in the changelog`);
  // Two submits of the same release at once (a drafter and the super admin) must not both pass the check: the second event
  // would be stored but never projected (the (kind, ref) key is unique). A session lock on the key serializes them.
  const lock = await ctx.pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock(hashtext($1))', [`social-post:${input.kind}:${input.ref}`]);
    const existing = await row(ctx, 'ref', input.ref, input.kind);
    if (existing) return { post: await getSocialPost(ctx, existing.id), created: false };
    const postId = randomUUID();
    await ctx.store.append([
      {
        streamId: socialPostStream(postId),
        event: {
          type: 'SocialPostSubmitted',
          payload: { postId, kind: input.kind, ref: input.ref, content, origin, status },
        },
        actor: origin.userId ? userActor(origin.userId) : SYSTEM_ACTOR,
        scope: adminScope,
      },
    ]);
    return { post: await getSocialPost(ctx, postId), created: true };
  } finally {
    try {
      await lock.query('SELECT pg_advisory_unlock(hashtext($1))', [`social-post:${input.kind}:${input.ref}`]);
    } finally {
      lock.release();
    }
  }
}

/** Edits title, summary and captions. An approved post is final (it may already be on the networks). */
export async function reviseSocialPost(
  ctx: Ctx,
  postId: string,
  patch: Partial<Pick<SocialPostContent, 'title' | 'summary' | 'captions'>>,
  by: Origin,
): Promise<SocialPost> {
  const r = await row(ctx, 'id', postId);
  if (!r) throw notFound('post not found', 'post_not_found');
  if (r.status === 'approved') throw conflict('already_approved', 'an approved post cannot be edited');
  const content = SocialPostContentSchema.parse({ ...(r.content as SocialPostContent), ...patch });
  if (JSON.stringify(content) === JSON.stringify(r.content)) return getSocialPost(ctx, postId);
  await ctx.store.append([
    {
      streamId: socialPostStream(postId),
      event: { type: 'SocialPostRevised', payload: { postId, content, by } },
      actor: by.userId ? userActor(by.userId) : SYSTEM_ACTOR,
      scope: adminScope,
    },
  ]);
  return getSocialPost(ctx, postId);
}

/** draft or rejected -> in review. */
export async function requestSocialReview(
  ctx: Ctx,
  by: AuthSession['user'],
  postId: string,
): Promise<SocialPost> {
  const r = await row(ctx, 'id', postId);
  if (!r) throw notFound('post not found', 'post_not_found');
  if (r.status === 'in_review') return getSocialPost(ctx, postId);
  if (r.status === 'approved') throw conflict('already_approved', 'the post is already approved');
  await ctx.store.append([
    {
      streamId: socialPostStream(postId),
      event: { type: 'SocialPostReviewRequested', payload: { postId, by: by.id } },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
  return getSocialPost(ctx, postId);
}

/**
 * The super admin's go-ahead; the sweep shares the post within a few minutes. Needs a connected network (409 `no_channel`):
 * a post approved with nowhere to go would never be shared, because only networks connected before the approval count.
 */
export async function approveSocialPost(
  ctx: Ctx,
  by: AuthSession['user'],
  postId: string,
): Promise<SocialPost> {
  assertBlogEnabled(await blogEnabled(ctx));
  const r = await row(ctx, 'id', postId);
  if (!r) throw notFound('post not found', 'post_not_found');
  if (r.status === 'approved') return getSocialPost(ctx, postId);
  if (r.status === 'rejected')
    throw conflict('post_rejected', 'a rejected post must be sent to review again first');
  const have = await one(ctx.pool, `SELECT 1 AS x FROM social_channels WHERE status='ok' LIMIT 1`);
  if (!have) throw conflict('no_channel', 'connect a social network first: nothing would be posted');
  await ctx.store.append([
    {
      streamId: socialPostStream(postId),
      event: { type: 'SocialPostApproved', payload: { postId, by: by.id } },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
  return getSocialPost(ctx, postId);
}

export async function rejectSocialPost(
  ctx: Ctx,
  by: AuthSession['user'],
  postId: string,
  reason: string,
): Promise<SocialPost> {
  const r = await row(ctx, 'id', postId);
  if (!r) throw notFound('post not found', 'post_not_found');
  if (r.status === 'approved') throw conflict('already_approved', 'an approved post cannot be rejected');
  await ctx.store.append([
    {
      streamId: socialPostStream(postId),
      event: { type: 'SocialPostRejected', payload: { postId, reason, by: by.id } },
      actor: userActor(by.id),
      scope: adminScope,
    },
  ]);
  return getSocialPost(ctx, postId);
}
