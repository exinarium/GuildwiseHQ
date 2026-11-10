import { createHash, randomUUID } from 'node:crypto';
import {
  BLOG_IMAGE,
  type BlogContent,
  type BlogImageUploaded,
  type BlogPost,
  type ManualPostRequest,
  slugifyTitle,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';

import { exec, one, type Row } from '../db/sql.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import { blogStream, contentErrors, contentHash, getPost, getPostRow } from './blog.ts';
import { userActor } from './common.ts';

/**
 * Hand-written articles: a super admin writes a post in the platform UI. It is stored in the same `blog_posts`
 * table as the writer's posts (origin kind `manual`) and goes through the same public pages. The writer's own
 * pipeline (`submitPost`, `revisePost` and the API routes) is not involved.
 */

const adminScope = { orgId: null, projectId: null, audience: 'admin' } as const;

const SLUG_TAKEN = 'That slug is already used by another post. Choose a different one.';

const slugTaken = () =>
  new HttpError(409, 'slug_taken', SLUG_TAKEN, [{ field: 'slug', message: SLUG_TAKEN }]);

/** The full stored content of a manual article: the writer's shape with empty sources, seo, social and disclosure. */
function manualContent(req: ManualPostRequest, slug: string): BlogContent {
  const title = req.title.trim();
  const key = (req.tags[0] ?? 'ai-agents') as BlogContent['coverImage']['defaultKey'];
  const alt = req.coverImage?.alt ?? (title.length >= 5 ? title : `${title} cover`.padEnd(5, '.'));
  return {
    slug,
    title,
    summary: req.summary.trim(),
    bodyMarkdown: req.bodyMarkdown,
    coverImage: { defaultKey: req.coverImage?.defaultKey ?? key, alt: alt.slice(0, 200) },
    tags: req.tags,
    sources: [],
    seo: {},
    social: {},
    aiDisclosure: {},
  };
}

function checkContent(c: BlogContent): void {
  const errs = contentErrors(c);
  if (errs.length) throw badRequest('validation_error', 'the post breaks a content rule', errs);
}

export async function createManualPost(
  ctx: Ctx,
  user: AuthSession['user'],
  req: ManualPostRequest,
): Promise<BlogPost> {
  const slug = req.slug ?? slugifyTitle(req.title);
  if (await one(ctx.pool, 'SELECT 1 AS x FROM blog_posts WHERE slug=$1', [slug])) throw slugTaken();
  const content = manualContent(req, slug);
  checkContent(content);
  const postId = randomUUID();
  await ctx.store.append([
    {
      streamId: blogStream(postId),
      event: {
        type: 'BlogPostSubmitted',
        payload: {
          postId,
          content,
          contentHash: contentHash(content),
          origin: { userId: user.id },
          status: 'draft',
          // the writer's link and source heuristics only gate auto-publish, which never applies to a person's article
          warnings: [],
          manual: { authorName: (req.authorName ?? user.displayName).slice(0, 80) },
        },
      },
      actor: userActor(user.id),
      scope: adminScope,
    },
  ]);
  return getPost(ctx, 'id', postId);
}

export async function updateManualPost(
  ctx: Ctx,
  user: AuthSession['user'],
  postId: string,
  req: ManualPostRequest,
): Promise<BlogPost> {
  const r = await getPostRow(ctx, 'id', postId);
  if (!r || r.origin_kind !== 'manual') throw notFound('post not found', 'post_not_found');
  const old = r.content as BlogContent;
  const wantsSlug = req.slug ?? old.slug;
  let slug = old.slug;
  if (wantsSlug !== old.slug) {
    if (r.published_at)
      throw new HttpError(409, 'slug_locked', 'The address of a published article cannot change.', [
        { field: 'slug', message: 'The address of a published article cannot change.' },
      ]);
    if (await one(ctx.pool, 'SELECT 1 AS x FROM blog_posts WHERE slug=$1 AND id<>$2', [wantsSlug, postId]))
      throw slugTaken();
    slug = wantsSlug;
  }
  const content = manualContent(req, slug);
  checkContent(content);
  const authorName = (req.authorName ?? r.author_name ?? user.displayName).slice(0, 80);
  const hash = contentHash(content);
  if (
    hash === r.content_hash &&
    slug === r.slug &&
    authorName === r.author_name &&
    JSON.stringify(content) === JSON.stringify(old)
  )
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
          by: { userId: user.id },
          // a draft stays a draft and a published article stays published (its public page updates in place)
          resubmit: false,
          warnings: [],
          authorName,
          ...(slug !== old.slug ? { slug } : {}),
        },
      },
      actor: userActor(user.id),
      scope: adminScope,
    },
  ]);
  return getPost(ctx, 'id', postId);
}

// ---- images

type Detected = { ext: keyof typeof BLOG_IMAGE.types; contentType: string };

/** The type of an image from its first bytes: never from the request header or a file name. */
export function detectImage(b: Buffer): Detected | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return { ext: 'png', contentType: 'image/png' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { ext: 'jpg', contentType: 'image/jpeg' };
  const head = b.subarray(0, 6).toString('latin1');
  if (head === 'GIF87a' || head === 'GIF89a') return { ext: 'gif', contentType: 'image/gif' };
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return { ext: 'webp', contentType: 'image/webp' };
  return null;
}

export async function uploadBlogImage(
  ctx: Ctx,
  user: AuthSession['user'],
  postId: string,
  bytes: Buffer,
): Promise<BlogImageUploaded> {
  const r = await getPostRow(ctx, 'id', postId);
  if (!r || r.origin_kind !== 'manual') throw notFound('post not found', 'post_not_found');
  if (bytes.length === 0) throw badRequest('file_required', 'Choose an image to upload.');
  if (bytes.length > BLOG_IMAGE.maxBytes)
    throw new HttpError(413, 'image_too_large', 'Images can be at most 5 MB.');
  const kind = detectImage(bytes);
  if (!kind)
    throw new HttpError(415, 'unsupported_image', 'Only PNG, JPEG, WebP and GIF images can be uploaded.');
  const count = (await one(ctx.pool, 'SELECT count(*)::int AS n FROM blog_images WHERE post_id=$1', [postId]))
    ?.n;
  if ((count ?? 0) >= BLOG_IMAGE.perPost)
    throw conflict('too_many_images', `An article can have at most ${BLOG_IMAGE.perPost} images.`);
  const id = randomUUID();
  await exec(
    ctx.pool,
    `INSERT INTO blog_images (id, post_id, content_type, ext, size, sha256, data, created_by, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      postId,
      kind.contentType,
      kind.ext,
      bytes.length,
      createHash('sha256').update(bytes).digest('hex'),
      bytes,
      user.id,
      ctx.clock.now(),
    ],
  );
  const url = `/blog/media/${id}.${kind.ext}`;
  return { id, url, markdown: `![](${url})`, contentType: kind.contentType, size: bytes.length };
}

/** An image with the status of its post (null status: the post is gone). */
export async function readBlogImage(
  ctx: Ctx,
  id: string,
  ext: string,
): Promise<{ row: Row; postStatus: string | null } | null> {
  const row = await one(
    ctx.pool,
    `SELECT i.*, p.status AS post_status FROM blog_images i LEFT JOIN blog_posts p ON p.id = i.post_id
      WHERE i.id=$1 AND i.ext=$2`,
    [id, ext],
  );
  return row ? { row, postStatus: row.post_status ?? null } : null;
}
