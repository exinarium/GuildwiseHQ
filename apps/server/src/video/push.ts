import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { artifactKeyOf, renderDir } from '../commands/video-posts.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';

/**
 * The artifact push: a render worker on another machine (one that can render) PUTs each finished file to the machine
 * that owns the video volume. One route plugin, mounted in two places: the app (when its volume is writable) and the
 * publish worker's own small server (video-worker.ts), because the app mounts the volume read-only.
 *
 *   PUT /api/worker/video/renders/:renderId/files/:name
 *     Authorization: Bearer <AOM_VIDEO_WORKER_TOKEN>   x-content-sha256: <hex>   content-length: <bytes>
 *
 * The name is one of the fixed artifact names. The body is streamed to a temp file next to the target, its size and
 * sha256 verified, then renamed into place, so a reader never sees a half-written file.
 */

const NON_VIDEO_MAX_BYTES = 32 * 1024 * 1024;

const digest = (s: string) => createHash('sha256').update(s).digest();
/** Constant-time token comparison (both sides hashed first so the lengths match). */
export function tokenMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  return timingSafeEqual(digest(given), digest(expected));
}

/** The largest file the push accepts: an MP4 up to the whole disk budget, everything else is small text or one PNG. */
export const maxPushBytes = (ctx: Ctx, name: string): number =>
  artifactKeyOf(name) === 'video' ? ctx.config.videoMaxBytes : NON_VIDEO_MAX_BYTES;

export function videoPushRoutes(ctx: Ctx) {
  return async (app: FastifyInstance) => {
    const token = ctx.config.videoWorkerToken;
    if (!token) return; // not configured: the endpoint does not exist (404)
    // the body is the raw file, whatever its content type
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    app.put<{ Params: { renderId: string; name: string } }>(
      '/api/worker/video/renders/:renderId/files/:name',
      async (req, reply) => {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        if (!tokenMatches(bearer, token)) throw new HttpError(401, 'unauthenticated', 'bad worker token');
        const { renderId, name } = req.params;
        if (!artifactKeyOf(name)) throw notFound('unknown artifact name');
        if (!/^[0-9a-f-]{36}$/i.test(renderId)) throw notFound('render not found');
        const sha = String(req.headers['x-content-sha256'] ?? '').toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(sha))
          throw badRequest('bad_hash', 'x-content-sha256 must be 64 hex characters');
        const len = Number(req.headers['content-length']);
        if (!Number.isInteger(len) || len < 0) throw badRequest('bad_length', 'content-length is required');
        const cap = maxPushBytes(ctx, name);
        if (len > cap) throw new HttpError(413, 'too_large', `the file is over the ${cap} byte limit`);
        const r = await one(
          ctx.pool,
          'SELECT post_id, revision, status, library FROM video_renders WHERE id=$1',
          [renderId],
        );
        if (!r || r.library || r.status !== 'rendering') throw notFound('no render is waiting for files');

        const dir = join(ctx.config.videoDir, renderDir(r.post_id, r.revision));
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, `.push-${randomUUID()}.tmp`);
        const hash = createHash('sha256');
        let bytes = 0;
        const body = req.body as Readable;
        body.on('data', (c: Buffer) => {
          bytes += c.length;
          hash.update(c);
          if (bytes > len)
            body.destroy(new HttpError(400, 'size_mismatch', 'the body is longer than content-length'));
        });
        try {
          await pipeline(body, createWriteStream(tmp, { mode: 0o640 }));
          if (bytes !== len) throw badRequest('size_mismatch', `received ${bytes} bytes, expected ${len}`);
          if (hash.digest('hex') !== sha)
            throw badRequest('hash_mismatch', 'sha256 of the body does not match');
          await rename(tmp, join(dir, name));
        } catch (err) {
          await rm(tmp, { force: true });
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, 'upload_failed', err instanceof Error ? err.message : 'upload failed');
        }
        return reply.send({ ok: true, name, bytes });
      },
    );
  };
}

/** The publish worker's own small HTTP server: only the push route, nothing else of the API. Returns a stop function. */
export async function startPushServer(
  ctx: Ctx,
  port = ctx.config.videoWorkerPort,
): Promise<() => Promise<void>> {
  const server = Fastify({ logger: false, trustProxy: true, bodyLimit: 1024 });
  server.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError)
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    ctx.log.error({ err }, 'video push failed');
    const status =
      typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500
        ? err.statusCode
        : 500;
    return reply
      .code(status)
      .send({
        error: {
          code: status === 500 ? 'internal_error' : 'bad_request',
          message: status === 500 ? 'internal server error' : err.message,
        },
      });
  });
  server.setNotFoundHandler((_req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'not found' } }),
  );
  await server.register(videoPushRoutes(ctx));
  await server.listen({ port, host: '0.0.0.0' });
  return () => server.close();
}
