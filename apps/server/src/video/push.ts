import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  cleanWorkerVersion,
  WORKER_OUTDATED_CODE,
  WORKER_VERSION_HEADER,
  workerOutdated,
  workerOutdatedMessage,
} from '@aom/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { SlidingLimit } from '../auth/limits.ts';
import { artifactKeyOf, renderDir, serverVersion } from '../commands/video-posts.ts';
import type { Ctx } from '../context.ts';
import { exec, one } from '../db/sql.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { fastifyTrustProxy } from '../trust-proxy.ts';
import { verifySignedLink } from './render-io.ts';
import { logDenied, workerByToken } from './render-workers.ts';

/**
 * The artifact push: a remote render worker (`video-worker --remote`, core DESIGN R16) PUTs each finished file to the
 * machine that owns the video volume. One route plugin, mounted in two places: the app (when its volume is writable) and
 * the publish worker's own small server (video-worker.ts), because the app mounts the volume read-only.
 *
 *   PUT /api/worker/video/renders/:renderId/files/:name?attempt&exp&sig     (the signed link from the claim)
 *     Authorization: Bearer <the render worker's own aomv_ token>   x-content-sha256: <hex>   content-length: <bytes>
 *     x-worker-version: <the worker's application version>
 *
 * `AOM_VIDEO_WORKER_TOKEN` only switches the endpoint on; it is never accepted as a credential and never given to a
 * worker. A push needs the worker's token AND a valid signature for this render, attempt and name, and the render must
 * still be held by that worker and attempt (a stale attempt gets 409 lease_lost).
 *
 * A worker older than the server (or one that sends no version) gets 409 worker_outdated naming both versions, and the
 * render goes back to the queue without counting the attempt.
 *
 * The name is one of the fixed artifact names. The body is streamed to a temp file next to the target, its size and
 * sha256 verified, then renamed into place, so a reader never sees a half-written file. Two pushes of the same name at once
 * write to their own temp files (unique names); each one is verified on its own and the last rename wins, which is safe
 * because a render's file content is the same whichever push lands.
 */

const NON_VIDEO_MAX_BYTES = 32 * 1024 * 1024;
/** How long a render refused because its worker is outdated waits before an outdated worker may claim it again. */
const OUTDATED_WAIT_MS = 10 * 60_000;

/** The largest file the push accepts: an MP4 up to the whole disk budget, everything else is small text or one PNG. */
export const maxPushBytes = (ctx: Ctx, name: string): number =>
  artifactKeyOf(name) === 'video' ? ctx.config.videoMaxBytes : NON_VIDEO_MAX_BYTES;

export function videoPushRoutes(ctx: Ctx) {
  return async (app: FastifyInstance) => {
    if (!ctx.config.videoWorkerToken) return; // not configured: the endpoint does not exist (404)
    // failed authentication: 10 a minute per address
    const failedAuth = new SlidingLimit(10, 60_000, () => ctx.clock.now().getTime());
    /** Uploads running now, by render and name (one at a time per slot). */
    const inFlight = new Set<string>();
    // the body is the raw file, whatever its content type
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', (_req, payload, done) => done(null, payload));

    app.put<{
      Params: { renderId: string; name: string };
      Querystring: { attempt?: string; exp?: string; sig?: string };
    }>('/api/worker/video/renders/:renderId/files/:name', async (req, reply) => {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const worker = await workerByToken(ctx, bearer);
      if (!worker) {
        // the limit first: once over it, the request ends with 429 before any database write
        failedAuth.hit(req.ip);
        await logDenied(ctx, { workerId: null, action: 'upload', ip: req.ip, outcome: 'denied: bad token' });
        throw new HttpError(401, 'unauthenticated', 'bad worker token');
      }
      const { renderId, name } = req.params;
      if (!artifactKeyOf(name)) throw notFound('unknown artifact name');
      if (!/^[0-9a-f-]{36}$/i.test(renderId)) throw notFound('render not found');
      let attempt: number;
      let exp: number;
      try {
        ({ attempt, exp } = await verifySignedLink(ctx, { method: 'PUT', renderId, name }, req.query));
      } catch (err) {
        await logDenied(ctx, {
          workerId: worker.id,
          action: 'upload',
          renderId,
          ip: req.ip,
          outcome: `denied: ${(err as Error).message}`,
        });
        throw err;
      }
      const r = await one(
        ctx.pool,
        'SELECT post_id, revision, status, library, attempts, worker_id, artifacts FROM video_renders WHERE id=$1',
        [renderId],
      );
      if (!r || r.library || r.status !== 'rendering') throw notFound('no render is waiting for files');
      // the render must still be held by this worker and this attempt (before anything else may change the row)
      // ... and the link must be one of this claim (its expiry is the claim's, kept on the row): a link of an earlier
      // claim of a re-queued render, whose attempt numbers started again at 1, is refused
      if (r.attempts !== attempt || r.worker_id !== worker.id || Number(r.artifacts?.uploadExp) !== exp) {
        await logDenied(ctx, {
          workerId: worker.id,
          action: 'upload',
          renderId,
          ip: req.ip,
          outcome: 'denied: lease lost',
        });
        throw new HttpError(409, 'lease_lost', 'this attempt no longer holds the render');
      }
      // a worker older than the server (or one that sends no version) delivers nothing; checked after the token, so
      // an unauthenticated caller never sees the versions
      const version = cleanWorkerVersion(req.headers[WORKER_VERSION_HEADER]);
      const server = await serverVersion(ctx);
      if (workerOutdated(version, server)) {
        const message = workerOutdatedMessage(version, server as string);
        // the render goes back to the queue: the attempt does not count, and the wait keeps an old worker from
        // re-rendering in a tight loop (a current worker clears it when it claims). Only the holding attempt may.
        await exec(
          ctx.pool,
          `UPDATE video_renders SET status='queued', attempts=GREATEST(attempts-1,0), error=$2, lease_until=$3
              WHERE id=$1 AND status='rendering' AND NOT library AND attempts=$4 AND worker_id=$5`,
          [renderId, message, new Date(ctx.clock.now().getTime() + OUTDATED_WAIT_MS), attempt, worker.id],
        );
        ctx.log.warn({ renderId, worker: version, server }, message);
        throw new HttpError(409, WORKER_OUTDATED_CODE, message);
      }
      const sha = String(req.headers['x-content-sha256'] ?? '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha))
        throw badRequest('bad_hash', 'x-content-sha256 must be 64 hex characters');
      // a 0-byte file may arrive with no Content-Length and no body at all
      const len = Number(req.headers['content-length'] ?? (req.body === undefined ? 0 : Number.NaN));
      if (!Number.isInteger(len) || len < 0) throw badRequest('bad_length', 'content-length is required');
      const cap = maxPushBytes(ctx, name);
      if (len > cap) throw new HttpError(413, 'too_large', `the file is over the ${cap} byte limit`);

      const dir = join(ctx.config.videoDir, renderDir(r.post_id, r.revision));
      // one upload slot per name and attempt: the file complete measures is the file that gets recorded. A repeat of
      // the same bytes (a retry whose answer was lost) is accepted; different bytes are refused; two at once too.
      const slotKey = `${renderId}/${name}`;
      if (inFlight.has(slotKey))
        throw new HttpError(409, 'upload_in_progress', `${name} is being uploaded already`);
      const slot = await readUploadSlot(dir, name);
      // the slot belongs to this claim only when attempt AND link expiry match; a slot of an earlier claim of the same
      // render (re-queued, attempt numbers start again at 1) is stale and is overwritten
      if (slot && slot.attempt === attempt && slot.exp === exp) {
        if (slot.sha256 === sha) return reply.send({ ok: true, name, bytes: len, repeated: true });
        throw new HttpError(409, 'already_uploaded', `${name} was already uploaded for this attempt`);
      }
      inFlight.add(slotKey);
      try {
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, `.push-${randomUUID()}.tmp`);
        const hash = createHash('sha256');
        let bytes = 0;
        // a 0-byte file has no body at all (no stream is created)
        const body = (req.body as Readable | undefined) ?? Readable.from([]);
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
          await writeUploadSlot(dir, name, { attempt, exp, sha256: sha });
        } catch (err) {
          await rm(tmp, { force: true });
          if (err instanceof HttpError) throw err;
          throw new HttpError(400, 'upload_failed', err instanceof Error ? err.message : 'upload failed');
        }
        return reply.send({ ok: true, name, bytes });
      } finally {
        inFlight.delete(slotKey);
      }
    });
  };
}

/**
 * The upload slot of one artifact: which claim (attempt and link expiry) uploaded it, with which sha256
 * (`.slot-<name>` next to the file).
 */
export interface UploadSlot {
  attempt: number;
  exp: number;
  sha256: string;
}

/** The slot file of an artifact (removed with the file when the cleanup purges it). */
export const uploadSlotFile = (dir: string, name: string) => join(dir, `.slot-${name}`);

export async function readUploadSlot(dir: string, name: string): Promise<UploadSlot | null> {
  const text = await readFile(uploadSlotFile(dir, name), 'utf8').catch(() => null);
  // `<attempt> <exp> <sha256>`; anything else (an older two-field slot included) reads as no slot
  const m = text ? /^(\d+) (\d+) ([0-9a-f]{64})$/.exec(text.trim()) : null;
  return m ? { attempt: Number(m[1]), exp: Number(m[2]), sha256: m[3] as string } : null;
}

async function writeUploadSlot(dir: string, name: string, slot: UploadSlot): Promise<void> {
  const tmp = join(dir, `.push-${randomUUID()}.tmp`);
  await writeFile(tmp, `${slot.attempt} ${slot.exp} ${slot.sha256}\n`, { mode: 0o640 });
  await rename(tmp, uploadSlotFile(dir, name));
}

/** The publish worker's own small HTTP server: only the push route, nothing else of the API. Returns a stop function. */
export async function startPushServer(
  ctx: Ctx,
  port = ctx.config.videoWorkerPort,
): Promise<() => Promise<void>> {
  const server = Fastify({
    logger: false,
    trustProxy: fastifyTrustProxy(ctx.config.trustProxy),
    bodyLimit: 1024,
  });
  server.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof HttpError)
      return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    ctx.log.error({ err }, 'video push failed');
    const status =
      typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500
        ? err.statusCode
        : 500;
    return reply.code(status).send({
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
