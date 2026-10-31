import { timingSafeEqual } from 'node:crypto';
import {
  isBusinessOrg,
  isOrgOperational,
  RELAY_STRIPPED_HEADERS,
  type RelayKind,
  type RelayOutcome,
} from '@aom/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { hashRelayToken, RELAY_TOKEN_RE } from '../commands/relay-integrations.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';

/** What the lookup found; the only thing kept about a call besides the numbers below. */
interface RelayCall {
  integrationId: string;
  orgId: string;
  kind: RelayKind;
  startedAt: bigint;
}

declare module 'fastify' {
  interface FastifyRequest {
    relay: RelayCall | null;
  }
}

const STRIPPED: ReadonlySet<string> = new Set(RELAY_STRIPPED_HEADERS);
/** Unknown-path calls are metadata too, but a flood of them must not become a flood of rows. */
const UNKNOWN_ROWS_PER_MINUTE = 600;

const sameHash = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const elapsedMs = (since: bigint): number => Number((process.hrtime.bigint() - since) / 1_000_000n);

/**
 * The provider's headers as received: lower-case names, order and duplicates kept; hop-by-hop, proxy and GuildWise's
 * own headers dropped (the session cookie, `x-aom-*`, and every name the `Connection` header lists).
 */
export function forwardHeaders(rawHeaders: readonly string[]): [string, string][] {
  const out: [string, string][] = [];
  const listed = new Set<string>();
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    if ((rawHeaders[i] as string).toLowerCase() === 'connection')
      for (const t of (rawHeaders[i + 1] as string).split(',')) listed.add(t.trim().toLowerCase());
  }
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] as string).toLowerCase();
    if (STRIPPED.has(name) || name.startsWith('x-aom-') || listed.has(name)) continue;
    out.push([name, rawHeaders[i + 1] as string]);
  }
  return out;
}

/**
 * The public inbound relay, `/relay/in/<token>`: GET and POST from an outside provider, forwarded raw to the runner
 * that serves the integration. Registered WITHOUT fastify-plugin so its parsers, hooks and error handler stay inside.
 *
 * Nothing of the call is stored or logged except numbers and ids: the URL (token and query), headers and body never
 * reach a log line or a table. The server does size, rate and path checks only; signatures are the runner's.
 */
export function relayPublicRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const hub = () => ctx.services.webhookRelay;
    fastify.decorateRequest('relay', null);
    // The body stays the exact bytes: no JSON or form parsing, whatever the content type.
    fastify.removeAllContentTypeParsers();
    fastify.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    let unknownWindow = { at: 0, n: 0 };
    const record = async (
      req: FastifyRequest,
      status: number,
      outcome: RelayOutcome,
      sizeBytes: number,
    ): Promise<void> => {
      const call = req.relay;
      if (!call) {
        const t = Date.now();
        if (t - unknownWindow.at > 60_000) unknownWindow = { at: t, n: 0 };
        if (++unknownWindow.n > UNKNOWN_ROWS_PER_MINUTE) return;
      }
      await hub().record({
        orgId: call?.orgId ?? null,
        integrationId: call?.integrationId ?? null,
        kind: call?.kind ?? null,
        method: req.method,
        sizeBytes,
        status,
        latencyMs: call ? elapsedMs(call.startedAt) : 0,
        outcome,
      });
    };
    const sizeOf = (req: FastifyRequest): number => {
      const n = Number(req.headers['content-length']);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };

    // Empty bodies everywhere: an error never explains itself to a stranger, and never echoes the input.
    fastify.setErrorHandler(async (err: { statusCode?: number; name?: string }, req, reply) => {
      const tooBig = err.statusCode === 413;
      const status =
        typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
      ctx.log.warn({ relay: { integrationId: req.relay?.integrationId ?? null, status, errName: err.name } }, 'relay error');
      await record(req, status, tooBig ? 'rejected_size' : 'error', sizeOf(req));
      return reply.code(status).send();
    });

    const empty404 = async (req: FastifyRequest, reply: FastifyReply) => {
      await record(req, 404, 'unknown_path', 0);
      return reply.code(404).send();
    };

    /** 404 for an unknown, revoked, malformed or out-of-mode token, before the body is read. */
    const lookup = async (req: FastifyRequest, reply: FastifyReply) => {
      const startedAt = process.hrtime.bigint();
      const token = (req.params as { token?: string }).token ?? '';
      let found: { id: string; org_id: string; kind: RelayKind } | null = null;
      if (RELAY_TOKEN_RE.test(token)) {
        const hash = hashRelayToken(token);
        const r = await one(
          ctx.pool,
          `SELECT i.id, i.org_id, i.kind, i.status, i.token_hash, o.mode, o.status AS org_status
             FROM relay_integrations i JOIN organizations o ON o.id = i.org_id WHERE i.token_hash=$1`,
          [hash],
        );
        if (
          r &&
          r.status === 'active' &&
          r.token_hash &&
          sameHash(hash, r.token_hash) &&
          isBusinessOrg(r) &&
          isOrgOperational(r.org_status)
        )
          found = { id: r.id, org_id: r.org_id, kind: r.kind };
      }
      if (!found) {
        await record(req, 404, 'unknown_path', 0);
        return reply.code(404).send();
      }
      req.relay = { integrationId: found.id, orgId: found.org_id, kind: found.kind, startedAt };
    };

    const rateLimit = async (req: FastifyRequest, reply: FastifyReply) => {
      const call = req.relay as RelayCall;
      const t = hub().takeToken(call.integrationId, Date.now());
      if (t.ok) return;
      await record(req, 429, 'rejected_rate', sizeOf(req));
      return reply.code(429).header('retry-after', String(t.retryAfterSec)).send();
    };

    const forward = async (req: FastifyRequest, reply: FastifyReply) => {
      const call = req.relay as RelayCall;
      const body = req.method === 'GET' ? Buffer.alloc(0) : Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const raw = req.raw.url ?? '';
      const q = raw.indexOf('?');
      const r = await hub().forward(
        {
          integrationId: call.integrationId,
          kind: call.kind,
          method: req.method as 'GET' | 'POST',
          query: q >= 0 ? raw.slice(q + 1) : '',
          headers: forwardHeaders(req.raw.rawHeaders),
          body,
        },
        ctx.config.relay.timeoutMs[call.kind],
      );
      if (r.kind === 'offline') {
        await record(req, 503, 'runner_offline', body.length);
        return reply.code(503).header('retry-after', String(ctx.config.relay.retryAfterSec)).send();
      }
      if (r.kind === 'timeout') {
        await record(req, 504, 'timeout', body.length);
        return reply.code(504).send();
      }
      await record(req, r.status, 'forwarded', body.length);
      reply.code(r.status);
      for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.send(r.body);
    };

    fastify.route({
      method: ['GET', 'POST'],
      url: '/relay/in/:token',
      logLevel: 'silent',
      bodyLimit: ctx.config.relay.maxBodyBytes,
      exposeHeadRoute: false,
      onRequest: lookup,
      preHandler: rateLimit,
      handler: forward,
    });
    // Anything else, a malformed path or another method: 404 before any body is read.
    fastify.route({
      method: ['PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      url: '/relay/in/:token',
      logLevel: 'silent',
      exposeHeadRoute: false,
      onRequest: empty404,
      handler: async () => undefined,
    });
    for (const url of ['/relay/in', '/relay/in/*'])
      fastify.route({
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
        url,
        logLevel: 'silent',
        exposeHeadRoute: false,
        onRequest: empty404,
        handler: async () => undefined,
      });
  };
}
