import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  AddRenderWorkerRequestSchema,
  IdParamsSchema,
  RENDER_ARTIFACT_NAMES,
  RENDER_INPUT_URL_TTL_MS,
  RENDER_JOB_LEASE_MS,
  RENDER_UPLOAD_URL_TTL_MS,
  RenderClaimRequestSchema,
  RenderCompleteRequestSchema,
  RenderFailRequestSchema,
  RenderHeartbeatRequestSchema,
  WORKER_OUTDATED_CODE,
  workerOutdated,
  workerOutdatedMessage,
} from '@aom/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireSuperAdmin } from '../auth/guards.ts';
import { SlidingLimit } from '../auth/limits.ts';
import { requireStepUp } from '../auth/step-up.ts';
import {
  artifactKeyOf,
  beatHeartbeat,
  renderDir,
  serverVersion,
  videoActive,
  videoSettings,
} from '../commands/video-posts.ts';
import type { Ctx } from '../context.ts';
import { exec, one, type Row } from '../db/sql.ts';
import { badRequest, HttpError, notFound } from '../errors.ts';
import { readUploadSlot } from '../video/push.ts';
import { inputPath, signedQuery, uploadPath, verifySignedQuery } from '../video/render-io.ts';
import {
  claimRender,
  durationOverLimit,
  extendLease,
  failTooLong,
  markFailed,
  markRendered,
  releaseOutdatedWaits,
} from '../video/render-jobs.ts';
import {
  addRenderWorker,
  listRenderWorkers,
  logDenied,
  logWorker,
  reportEncoder,
  revokeRenderWorker,
  touchWorker,
  workerByToken,
} from '../video/render-workers.ts';
import { typed } from './util.ts';

/**
 * The render job API (core DESIGN R16, R19, R23): outbound-only for the worker, modelled on the runner token pattern.
 * Bearer `aomv_<32 bytes>` (only its sha256 is stored; revoked or unknown: 401), a per-worker limit of 120 requests a
 * minute and a failed-authentication limit of 10 a minute per address. The server owns every database write; the worker
 * gets the script it must render and short-lived signed upload links, nothing else.
 *
 *   POST /api/render/jobs/claim {version, encoder, encoderReason?}  -> 204 | {renderId, attempt, leaseUntil, inputUrl, uploadUrls}
 *   GET  /api/render/jobs/:id/input?attempt&exp&sig                -> {renderId, attempt, script, options}
 *   POST /api/render/jobs/:id/heartbeat {attempt, encoder?}         -> {leaseUntil} | 409 lease_lost
 *   POST /api/render/jobs/:id/complete {attempt, bytes, artifacts}  -> {status}
 *   POST /api/render/jobs/:id/fail {attempt, message}               -> {status}
 *
 * Uploads go to the push route (video/push.ts) with the signed links. Heartbeat, complete, fail and the input fetch are
 * bound to the claiming worker and attempt. The super admin side: `GET/POST /api/platform/render-workers` and
 * `POST /api/platform/render-workers/:id/revoke`.
 */

/** The one video file a render of this format may upload (the renderer writes `short.mp4` for Shorts). */
const videoNameOf = (format: string): string => (format === 'short' ? 'short.mp4' : 'video.mp4');
const VIDEO_NAMES = new Set(['video.mp4', 'short.mp4']);

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** The default duration measurement (pure JavaScript: the app image has no ffmpeg). Tests replace it. */
export type MeasureDuration = (file: string) => Promise<number>;
const defaultMeasure: MeasureDuration = async (file) => (await import('@aom/video')).mp4Duration(file);

export function renderJobRoutes(ctx: Ctx, opts: { measureDuration?: MeasureDuration } = {}) {
  const measure = opts.measureDuration ?? defaultMeasure;
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const now = () => ctx.clock.now().getTime();
    const perWorker = new SlidingLimit(120, 60_000, now);
    const failedAuth = new SlidingLimit(10, 60_000, now);

    /** The calling worker: its bearer token, the rate limits, and "seen". */
    async function worker(req: FastifyRequest, action: string, version?: string | null): Promise<Row> {
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      const w = await workerByToken(ctx, bearer);
      if (!w) {
        // the limit first: once over it, the request ends with 429 before any database write
        failedAuth.hit(req.ip);
        await logDenied(ctx, { workerId: null, action, ip: req.ip, outcome: 'denied: bad token' });
        throw new HttpError(401, 'unauthenticated', 'unknown or revoked render worker token');
      }
      try {
        perWorker.hit(w.id);
      } catch (err) {
        await logDenied(ctx, { workerId: w.id, action, ip: req.ip, outcome: 'denied: rate limited' });
        throw err;
      }
      await touchWorker(ctx, w.id, { ip: req.ip, version: version ?? null });
      return w;
    }

    /** The render this worker and attempt hold, or 409 lease_lost (another worker's job, a stale attempt, finished). */
    async function held(req: FastifyRequest, w: Row, renderId: string, attempt: number, action: string) {
      const r = await one(
        ctx.pool,
        `SELECT x.*, p.format, p.script FROM video_renders x JOIN video_posts p ON p.id = x.post_id WHERE x.id=$1`,
        [renderId],
      );
      if (r?.status !== 'rendering' || r.attempts !== attempt || r.worker_id !== w.id) {
        await logDenied(ctx, { workerId: w.id, action, renderId, ip: req.ip, outcome: 'denied: lease lost' });
        throw new HttpError(409, 'lease_lost', 'this attempt no longer holds the render');
      }
      return r;
    }

    app.post('/api/render/jobs/claim', { schema: { body: RenderClaimRequestSchema } }, async (req, reply) => {
      const w = await worker(req, 'claim', req.body.version);
      await reportEncoder(ctx, w, req.body.encoder, req.body.encoderReason, { ip: req.ip });
      const server = await serverVersion(ctx);
      if (workerOutdated(req.body.version, server)) {
        const message = workerOutdatedMessage(req.body.version, server as string);
        await beatHeartbeat(ctx, 'render', { version: req.body.version });
        await logDenied(ctx, { workerId: w.id, action: 'claim', ip: req.ip, outcome: 'denied: outdated' });
        throw new HttpError(409, WORKER_OUTDATED_CODE, message);
      }
      // the claim is the render half's heartbeat, so the Video page status keeps working
      await beatHeartbeat(ctx, 'render', { version: req.body.version });
      await releaseOutdatedWaits(ctx);
      // without a healthy channel only an explicit preview renders, as in the in-process loop
      const active = await videoActive(ctx);
      if (!active && !(await videoSettings(ctx)).enabled) return reply.code(204).send();
      const r = await claimRender(ctx, {
        previewsOnly: !active,
        leaseMs: RENDER_JOB_LEASE_MS,
        workerId: w.id,
      });
      if (!r) return reply.code(204).send();
      const attempt = r.attempts as number;
      const uploadUrls: Record<string, string> = {};
      // one video slot: only the video name of the post's format gets a link
      const post = await one(ctx.pool, 'SELECT format FROM video_posts WHERE id=$1', [r.post_id]);
      const ownVideo = videoNameOf(post?.format);
      // every upload link of this claim carries the same expiry: it identifies the claim in the upload slots, so a
      // re-queued render whose attempt number starts again at 1 never meets a slot of an earlier claim
      const uploadExp = ctx.clock.now().getTime() + RENDER_UPLOAD_URL_TTL_MS;
      // ... and is kept on the row while it renders (`artifacts.uploadExp`, a number no artifact reader looks at;
      // `markRendered` replaces the artifacts, a re-queue clears them), so only this claim's links can upload
      await exec(
        ctx.pool,
        `UPDATE video_renders SET artifacts = COALESCE(artifacts, '{}'::jsonb) || jsonb_build_object('uploadExp', $2::bigint)
          WHERE id=$1 AND attempts=$3 AND status='rendering'`,
        [r.id, uploadExp, attempt],
      );
      for (const name of RENDER_ARTIFACT_NAMES.filter((n) => !VIDEO_NAMES.has(n) || n === ownVideo))
        uploadUrls[name] =
          `${uploadPath(r.id, name)}?${await signedQuery(ctx, { method: 'PUT', renderId: r.id, attempt, name }, RENDER_UPLOAD_URL_TTL_MS, uploadExp)}`;
      await logWorker(ctx, {
        workerId: w.id,
        action: 'claim',
        renderId: r.id,
        ip: req.ip,
        outcome: `attempt ${attempt}`,
      });
      return {
        renderId: r.id,
        attempt,
        leaseUntil: new Date(r.lease_until).toISOString(),
        inputUrl: `${inputPath(r.id)}?${await signedQuery(ctx, { method: 'GET', renderId: r.id, attempt, name: 'input' }, RENDER_INPUT_URL_TTL_MS)}`,
        uploadUrls,
      };
    });

    app.get(
      '/api/render/jobs/:id/input',
      {
        schema: {
          params: IdParamsSchema,
          querystring: z.object({
            attempt: z.string().optional(),
            exp: z.string().optional(),
            sig: z.string().optional(),
          }),
        },
      },
      async (req) => {
        const w = await worker(req, 'input');
        let attempt: number;
        try {
          attempt = await verifySignedQuery(
            ctx,
            { method: 'GET', renderId: req.params.id, name: 'input' },
            req.query,
          );
        } catch (err) {
          await logDenied(ctx, {
            workerId: w.id,
            action: 'input',
            renderId: req.params.id,
            ip: req.ip,
            outcome: `denied: ${(err as Error).message}`,
          });
          throw err;
        }
        const r = await held(req, w, req.params.id, attempt, 'input');
        if (!r.script) throw notFound('the post has no script');
        return {
          renderId: r.id,
          attempt,
          script: r.script,
          options: { label: `post ${r.post_id} render ${r.id}` },
        };
      },
    );

    app.post(
      '/api/render/jobs/:id/heartbeat',
      { schema: { params: IdParamsSchema, body: RenderHeartbeatRequestSchema } },
      async (req) => {
        const w = await worker(req, 'heartbeat');
        if (req.body.encoder)
          await reportEncoder(ctx, w, req.body.encoder, req.body.encoderReason, {
            ip: req.ip,
            renderId: req.params.id,
          });
        await held(req, w, req.params.id, req.body.attempt, 'heartbeat');
        await beatHeartbeat(ctx, 'render', { busy: 'render', version: w.version ?? null });
        const ok = await extendLease(
          ctx,
          { id: req.params.id, attempts: req.body.attempt },
          RENDER_JOB_LEASE_MS,
          w.id,
        );
        if (!ok) throw new HttpError(409, 'lease_lost', 'this attempt no longer holds the render');
        return { leaseUntil: new Date(now() + RENDER_JOB_LEASE_MS).toISOString() };
      },
    );

    app.post(
      '/api/render/jobs/:id/complete',
      { schema: { params: IdParamsSchema, body: RenderCompleteRequestSchema } },
      async (req) => {
        const w = await worker(req, 'complete');
        const r = await held(req, w, req.params.id, req.body.attempt, 'complete');
        const held1 = { id: r.id as string, attempts: r.attempts as number };
        const dir = join(ctx.config.videoDir, renderDir(r.post_id, r.revision));
        const names = Object.keys(req.body.artifacts);
        // exactly one video, the one of the post's format: the file measured below is the file recorded
        const video = videoNameOf(r.format);
        if (names.some((n) => VIDEO_NAMES.has(n) && n !== video))
          throw badRequest('wrong_video', `a ${r.format} render uploads only ${video}`);
        if (!names.includes(video)) throw badRequest('no_video', `the artifacts list no ${video}`);
        const artifacts: Record<string, string | null> = {};
        let videoBytes = 0;
        for (const name of names) {
          const key = artifactKeyOf(name);
          if (!key) throw badRequest('unknown_artifact', `unknown artifact ${name}`);
          const want = req.body.artifacts[name] as { sha256: string; size: number };
          const file = join(dir, name);
          // the file must be on the video volume (pushed through the signed upload link) and be the one the worker made
          // ... in this attempt's upload slot (a leftover of an earlier attempt does not count)
          const slot = await readUploadSlot(dir, name);
          // (same attempt number and a link that is still valid: a slot of an earlier claim of a re-queued render has
          // another expiry and is overwritten by this claim's upload; if it was not, its sha differs or it expired)
          if (
            !existsSync(file) ||
            !slot ||
            slot.attempt !== r.attempts ||
            slot.exp !== Number(r.artifacts?.uploadExp)
          )
            throw badRequest('missing_artifact', `${name} was not uploaded`);
          const size = (await stat(file)).size;
          if (size !== want.size || slot.sha256 !== want.sha256 || (await sha256File(file)) !== want.sha256) {
            await logDenied(ctx, {
              workerId: w.id,
              action: 'complete',
              renderId: r.id,
              ip: req.ip,
              outcome: `denied: ${name} differs`,
            });
            throw badRequest('hash_mismatch', `${name} on the server does not match its sha256 and size`);
          }
          if (name === video) videoBytes = size;
          artifacts[key] = join(renderDir(r.post_id, r.revision), name);
        }
        // the server measures the length itself and applies the limit; the worker's word is not taken for it
        let seconds: number;
        try {
          seconds = await measure(join(dir, video));
        } catch (err) {
          await markFailed(ctx, held1, `the uploaded video cannot be read: ${(err as Error).message}`);
          await logWorker(ctx, {
            workerId: w.id,
            action: 'complete',
            renderId: r.id,
            ip: req.ip,
            outcome: 'failed: unreadable video',
          });
          throw badRequest('bad_video', 'the uploaded video cannot be read as an MP4');
        }
        const tooLong = durationOverLimit(r.format, seconds);
        if (tooLong) {
          await failTooLong(ctx, held1, tooLong);
          await logWorker(ctx, {
            workerId: w.id,
            action: 'complete',
            renderId: r.id,
            ip: req.ip,
            outcome: `failed: ${tooLong}`,
          });
          return { status: 'failed', error: tooLong };
        }
        const encoder = req.body.encoder ?? (w.encoder === 'nvenc' ? 'nvenc' : 'cpu');
        if (encoder === 'cpu_fallback')
          await reportEncoder(
            ctx,
            w,
            'cpu',
            req.body.encoderReason ?? w.encoder_reason ?? 'NVENC failed during a render',
            {
              ip: req.ip,
              renderId: r.id,
              fallback: true,
            },
          );
        const done = await markRendered(ctx, held1, {
          durationSeconds: seconds,
          bytes: videoBytes,
          artifacts,
          encoder,
        });
        if (!done) throw new HttpError(409, 'lease_lost', 'this attempt no longer holds the render');
        await logWorker(ctx, {
          workerId: w.id,
          action: 'complete',
          renderId: r.id,
          ip: req.ip,
          outcome: `rendered (${encoder})`,
        });
        return { status: 'rendered' };
      },
    );

    app.post(
      '/api/render/jobs/:id/fail',
      { schema: { params: IdParamsSchema, body: RenderFailRequestSchema } },
      async (req) => {
        const w = await worker(req, 'fail');
        const r = await held(req, w, req.params.id, req.body.attempt, 'fail');
        await markFailed(ctx, { id: r.id, attempts: r.attempts }, req.body.message);
        await logWorker(ctx, {
          workerId: w.id,
          action: 'fail',
          renderId: r.id,
          ip: req.ip,
          outcome: req.body.message,
        });
        return { status: 'failed' };
      },
    );

    // ---- the super admin side (Platform > Video, "Render workers")

    app.get('/api/platform/render-workers', async (req) => {
      await requireSuperAdmin(ctx, req);
      return { workers: await listRenderWorkers(ctx) };
    });
    app.post(
      '/api/platform/render-workers',
      { schema: { body: AddRenderWorkerRequestSchema } },
      async (req, reply) => {
        const s = await requireSuperAdmin(ctx, req);
        requireStepUp(ctx, s);
        return reply.code(201).send(await addRenderWorker(ctx, s.user.id, req.body.name));
      },
    );
    app.post(
      '/api/platform/render-workers/:id/revoke',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        requireStepUp(ctx, s);
        return { worker: await revokeRenderWorker(ctx, s.user.id, req.params.id) };
      },
    );
  };
}
