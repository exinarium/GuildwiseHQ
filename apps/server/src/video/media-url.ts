import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { signingKey } from '../auth/secrets.ts';
import { artifactPath } from '../commands/video-posts.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { sendRangedFile } from './serve.ts';

/**
 * The signed temporary media URL: TikTok pulls the video from a URL we serve (`PULL_FROM_URL`).
 *   GET /api/public/video-media/:renderId/:exp/:sig/video.mp4
 * `sig` = base64url(HMAC-SHA256(key derived from AOM_SECRET_KEY, "video-media|<renderId>|<exp>")), `exp` = unix seconds,
 * at most 2 hours ahead. 404 (never a redirect, never a hint why) when the signature is wrong or the link expired, the
 * render is purged, or its post is not approved. Range, no-store, noindex, every fetch logged.
 */

export const MEDIA_URL_MAX_TTL_S = 2 * 3600;
const PURPOSE = 'video-media';

async function signature(ctx: Ctx, renderId: string, exp: number): Promise<string> {
  return createHmac('sha256', await signingKey(ctx, PURPOSE))
    .update(`video-media|${renderId}|${exp}`)
    .digest('base64url');
}

/** A link valid for `ttlSeconds` (default 90 minutes; TikTok downloads within the hour). */
export async function signedMediaUrl(ctx: Ctx, renderId: string, ttlSeconds = 90 * 60): Promise<string> {
  const ttl = Math.min(ttlSeconds, MEDIA_URL_MAX_TTL_S);
  const exp = Math.floor(ctx.clock.now().getTime() / 1000) + ttl;
  return `${ctx.config.publicOrigin}/api/public/video-media/${renderId}/${exp}/${await signature(ctx, renderId, exp)}/video.mp4`;
}

export async function verifyMediaSignature(
  ctx: Ctx,
  renderId: string,
  exp: number,
  sig: string,
): Promise<boolean> {
  const now = Math.floor(ctx.clock.now().getTime() / 1000);
  if (!Number.isInteger(exp) || exp <= now || exp > now + MEDIA_URL_MAX_TTL_S) return false;
  const want = Buffer.from(await signature(ctx, renderId, exp));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function videoMediaRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const handler = async (
      req: import('fastify').FastifyRequest<{ Params: { renderId: string; exp: string; sig: string } }>,
      reply: import('fastify').FastifyReply,
    ) => {
      const { renderId, exp, sig } = req.params;
      const log = (outcome: string) =>
        ctx.log.info(
          { renderId, outcome, ip: req.ip, ua: req.headers['user-agent'], range: req.headers.range },
          'video media fetch',
        );
      reply.header('x-robots-tag', 'noindex, nofollow');
      reply.header('cache-control', 'no-store');
      const miss = (why: string) => {
        log(why);
        return notFound('not found');
      };
      if (
        !/^[0-9a-f-]{36}$/i.test(renderId) ||
        !/^\d{1,12}$/.test(exp) ||
        !/^[A-Za-z0-9_-]{20,64}$/.test(sig)
      )
        throw miss('malformed');
      if (!(await verifyMediaSignature(ctx, renderId, Number(exp), sig)))
        throw miss('bad signature or expired');
      const r = await one(
        ctx.pool,
        `SELECT r.artifacts, r.status, r.purged_at, r.library, r.revision, p.status AS post_status, p.revision AS post_revision,
                p.approved_render_id
           FROM video_renders r JOIN video_posts p ON p.id = r.post_id WHERE r.id = $1`,
        [renderId],
      );
      if (
        !r ||
        r.library ||
        r.status !== 'rendered' ||
        r.purged_at ||
        r.post_status !== 'approved' ||
        !(r.approved_render_id === renderId || (!r.approved_render_id && r.revision === r.post_revision))
      )
        throw miss('not available');
      const file = artifactPath(ctx, r.artifacts ?? {}, 'video');
      if (!file || !existsSync(file)) throw miss('file missing');
      log('served');
      return sendRangedFile(req, reply, file, 'video/mp4');
    };
    fastify.get('/api/public/video-media/:renderId/:exp/:sig/video.mp4', handler);
  };
}
