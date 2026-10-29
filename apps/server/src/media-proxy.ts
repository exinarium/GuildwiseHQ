import http from 'node:http';
import https from 'node:https';
import { pipeline, Transform } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * `/videos/*` is served by the media container (media/Dockerfile), not by this app. The proxy streams the upstream
 * response (the files are up to tens of MB: nothing is buffered), passes the conditional and Range request headers so
 * seeking and revalidation work, and answers fast when the media service is missing or down so the web app can hide
 * the video UI. Only GET and HEAD, only the `/videos/` prefix, only plain file names (no traversal).
 */
const REQUEST_HEADERS = ['range', 'if-range', 'if-none-match', 'if-modified-since'] as const;
const RESPONSE_HEADERS = [
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
  'content-type',
  'content-length',
] as const;
/** Time to reach the media service and get its response headers. */
export const MEDIA_CONNECT_TIMEOUT_MS = 2_000;
/** A body the media service itself stops sending for this long is cut. */
export const MEDIA_IDLE_TIMEOUT_MS = 30_000;
/** A stream the client has paused (not reading) this long is closed; the browser re-requests a Range on resume. */
export const MEDIA_PAUSE_MAX_MS = 10 * 60_000;
/** How often the body watchdog looks. */
export const MEDIA_WATCHDOG_TICK_MS = 5_000;
const SAFE_PATH = /^\/videos\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_QUERY = /^\?[A-Za-z0-9_=&.-]*$/;

/** The upstream path (+ query) for a request URL, or null when it is not a plain `/videos/<file>` request. */
export function mediaTarget(rawUrl: string): string | null {
  const q = rawUrl.indexOf('?');
  const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
  const query = q < 0 ? '' : rawUrl.slice(q);
  // No percent-encoding at all: file names are plain, and %2e%2e / %2f tricks have no business here.
  if (!SAFE_PATH.test(path) || path.includes('..')) return null;
  return path + (SAFE_QUERY.test(query) && query !== '?' ? query : '');
}

/** How much one client address may take from the media service (an unauthenticated route that streams tens of MB). */
export interface MediaLimits {
  /** Simultaneous requests per address; 0 = no limit. */
  maxConcurrentPerIp: number;
  /** Requests per rolling minute per address; 0 = no limit. */
  ratePerMin: number;
}
/** Body timers; injectable so tests run fast. `now` is the watchdog's clock (tests drive it by hand, so a stalled event loop cannot trip a cap). */
export interface MediaTiming {
  idleMs: number;
  pauseMaxMs: number;
  tickMs: number;
  now: () => number;
}
export const DEFAULT_MEDIA_TIMING: MediaTiming = {
  idleMs: MEDIA_IDLE_TIMEOUT_MS,
  pauseMaxMs: MEDIA_PAUSE_MAX_MS,
  tickMs: MEDIA_WATCHDOG_TICK_MS,
  now: Date.now,
};
export const DEFAULT_MEDIA_LIMITS: MediaLimits = { maxConcurrentPerIp: 8, ratePerMin: 240 };

/** Per-address concurrency and rate. In memory; an address with nothing running and nothing in the last minute is forgotten. */
export function createMediaLimiter(limits: MediaLimits, now: () => number = Date.now) {
  const byIp = new Map<string, { active: number; hits: number[] }>();
  const prune = (t: number): void => {
    for (const [ip, e] of byIp) {
      while (e.hits.length && t - (e.hits[0] as number) >= 60_000) e.hits.shift();
      if (e.active === 0 && e.hits.length === 0) byIp.delete(ip);
    }
  };
  return {
    /** A release function when the request may go on, else the reason and when to retry. */
    take(ip: string): { release: () => void } | { refused: 'concurrent' | 'rate'; retryAfterSec: number } {
      const t = now();
      if (byIp.size > 1000) prune(t);
      let e = byIp.get(ip);
      if (!e) {
        e = { active: 0, hits: [] };
        byIp.set(ip, e);
      }
      while (e.hits.length && t - (e.hits[0] as number) >= 60_000) e.hits.shift();
      if (limits.ratePerMin > 0 && e.hits.length >= limits.ratePerMin)
        return {
          refused: 'rate',
          retryAfterSec: Math.max(1, Math.ceil((60_000 - (t - (e.hits[0] as number))) / 1000)),
        };
      if (limits.maxConcurrentPerIp > 0 && e.active >= limits.maxConcurrentPerIp)
        return { refused: 'concurrent', retryAfterSec: 1 };
      e.hits.push(t);
      e.active++;
      const entry = e;
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          entry.active = Math.max(0, entry.active - 1);
        },
      };
    },
    size: () => byIp.size,
  };
}

const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).header('cache-control', 'no-store').send({ error: { code, message } });

export function registerMediaProxy(
  app: FastifyInstance,
  mediaUrl: string | undefined,
  limits: MediaLimits = DEFAULT_MEDIA_LIMITS,
  timing: Partial<MediaTiming> = {},
): void {
  const { idleMs, pauseMaxMs, tickMs, now: clock } = { ...DEFAULT_MEDIA_TIMING, ...timing };
  const base = mediaUrl ? new URL(mediaUrl) : null;
  const limiter = createMediaLimiter(limits);
  const client = base?.protocol === 'https:' ? https : http;

  app.route({
    method: ['GET', 'HEAD'],
    url: '/videos/*',
    handler: (req: FastifyRequest, reply: FastifyReply) => {
      if (!base) return fail(reply, 404, 'not_found', 'videos are not available');
      const target = mediaTarget(req.raw.url ?? '');
      if (!target) return fail(reply, 404, 'not_found', 'not found');
      const slot = limiter.take(req.ip);
      if ('refused' in slot) {
        void reply.header('retry-after', String(slot.retryAfterSec));
        return fail(
          reply,
          429,
          'too_many_requests',
          'too many video requests from this address; try again shortly',
        );
      }
      // freed when the response is over, however it ends (finished, cut, client gone, upstream failed)
      reply.raw.once('close', slot.release);

      const headers: Record<string, string> = { accept: '*/*', 'accept-encoding': 'identity' };
      for (const h of REQUEST_HEADERS) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      return new Promise<void>((resolve) => {
        let settled = false;
        let streaming = false;
        let watchdog: NodeJS.Timeout | undefined;
        const stopWatchdog = () => {
          if (watchdog) clearInterval(watchdog);
          watchdog = undefined;
        };
        const done = () => {
          stopWatchdog();
          if (!settled) {
            settled = true;
            slot.release();
            resolve();
          }
        };
        const up = client.request(
          {
            protocol: base.protocol,
            hostname: base.hostname,
            port: base.port || undefined,
            method: req.method,
            path: (base.pathname.replace(/\/$/, '') || '') + target,
            headers,
            timeout: MEDIA_CONNECT_TIMEOUT_MS,
          },
          (res) => {
            // The socket idle timer only guards connect + headers. A paused video stops reading (backpressure), so
            // a quiet socket is not a dead upstream: the body is watched by the watchdog below instead.
            up.setTimeout(0);
            const status = res.statusCode ?? 502;
            if (![200, 206, 304, 416].includes(status)) {
              res.resume();
              void (status === 404
                ? fail(reply, 404, 'not_found', 'not found')
                : fail(reply, 503, 'media_unavailable', 'the media service is not available'));
              return done();
            }
            streaming = true;
            reply.code(status);
            for (const h of RESPONSE_HEADERS) {
              const v = res.headers[h];
              if (typeof v === 'string') reply.header(h, v);
            }
            // The client went away (seeking cancels the request): stop pulling from the media service.
            reply.raw.once('close', () => {
              if (!res.complete) up.destroy();
              done();
            });
            res.once('error', () => undefined);
            if (req.method === 'HEAD') {
              void reply.send(undefined);
              res.resume();
              return;
            }
            // A pass-through lets us see when upstream chunks arrive without consuming them (a 'data' listener on
            // `res` would start it flowing before Fastify pipes it, and lose bytes).
            let lastChunk = clock();
            let heldSince: number | null = null;
            let lastWritten = 0;
            const meter = new Transform({
              transform(chunk, _enc, cb) {
                lastChunk = clock();
                cb(null, chunk);
              },
            });
            pipeline(res, meter, () => undefined);
            void reply.send(meter);
            reply.raw.once('finish', stopWatchdog);
            watchdog = setInterval(() => {
              const now = clock();
              // Bytes that reached the client's socket since the last tick: a slow reader is progress, not a pause.
              const written = reply.raw.socket?.bytesWritten ?? 0;
              const progressed = written > lastWritten;
              lastWritten = written;
              // Held up by the client (paused / not draining): not upstream silence, but not forever either.
              if (
                res.isPaused() ||
                meter.readableFlowing === false ||
                meter.writableNeedDrain ||
                reply.raw.writableNeedDrain
              ) {
                if (progressed) heldSince = now;
                else heldSince ??= now;
                lastChunk = now;
                if (now - heldSince > pauseMaxMs) {
                  stopWatchdog();
                  up.destroy();
                  reply.raw.destroy();
                }
                return;
              }
              heldSince = null;
              // (a finished upstream cannot go silent: only the pause cap above applies to it)
              if (!res.complete && now - lastChunk > idleMs) {
                stopWatchdog();
                up.destroy(new Error('media timeout'));
                reply.raw.destroy();
              }
            }, tickMs);
            watchdog.unref();
          },
        );
        // The client left before the headers came: stop the upstream request now, not at the connect timeout.
        reply.raw.once('close', () => {
          if (!streaming) {
            done();
            up.destroy();
          }
        });
        up.on('timeout', () => up.destroy(new Error('media timeout')));
        up.on('error', (err) => {
          stopWatchdog();
          if (streaming) {
            // cut mid-body: the answer is already on its way, end it (truncated) instead of writing an error page
            reply.raw.destroy();
            return done();
          }
          if (settled || reply.sent) return;
          req.log.warn({ err: err.message }, 'media service unavailable');
          void fail(reply, 503, 'media_unavailable', 'the media service is not available');
          done();
        });
        up.end();
      });
    },
  });
}
