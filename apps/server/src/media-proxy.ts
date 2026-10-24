import http from 'node:http';
import https from 'node:https';
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
/** A body that stalls this long is cut. */
const MEDIA_IDLE_TIMEOUT_MS = 30_000;
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

const fail = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).header('cache-control', 'no-store').send({ error: { code, message } });

export function registerMediaProxy(app: FastifyInstance, mediaUrl: string | undefined): void {
  const base = mediaUrl ? new URL(mediaUrl) : null;
  const client = base?.protocol === 'https:' ? https : http;

  app.route({
    method: ['GET', 'HEAD'],
    url: '/videos/*',
    handler: (req: FastifyRequest, reply: FastifyReply) => {
      if (!base) return fail(reply, 404, 'not_found', 'videos are not available');
      const target = mediaTarget(req.raw.url ?? '');
      if (!target) return fail(reply, 404, 'not_found', 'not found');

      const headers: Record<string, string> = { accept: '*/*', 'accept-encoding': 'identity' };
      for (const h of REQUEST_HEADERS) {
        const v = req.headers[h];
        if (typeof v === 'string') headers[h] = v;
      }
      return new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (!settled) {
            settled = true;
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
            up.setTimeout(MEDIA_IDLE_TIMEOUT_MS);
            const status = res.statusCode ?? 502;
            if (![200, 206, 304, 416].includes(status)) {
              res.resume();
              void (status === 404
                ? fail(reply, 404, 'not_found', 'not found')
                : fail(reply, 503, 'media_unavailable', 'the media service is not available'));
              return done();
            }
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
            void reply.send(req.method === 'HEAD' ? undefined : res);
            if (req.method === 'HEAD') res.resume();
          },
        );
        up.on('timeout', () => up.destroy(new Error('media timeout')));
        up.on('error', (err) => {
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
