import { HOOK_MAX_BYTES } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { receiveHook } from '../commands/hooks.ts';
import type { Ctx } from '../context.ts';
import { badRequest, notFound } from '../errors.ts';

const Uuid = z.uuid();

/**
 * Incoming webhooks (backlog #14). No cookie, no Origin: the secret is the credential, either as the last part of the
 * path or as `Authorization: Bearer <secret>`. JSON only, at most `HOOK_MAX_BYTES`.
 */
export function hookRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const handler = async (
      req: { params: unknown; headers: Record<string, unknown>; body: unknown },
      reply: { code: (n: number) => unknown },
    ) => {
      const p = req.params as { id: string; secret?: string };
      // A malformed id is just another thing that is not there.
      if (!Uuid.safeParse(p.id).success) throw notFound('no such hook');
      const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const bearer = /^Bearer\s+(\S+)$/i.exec(auth)?.[1] ?? null;
      const payload = req.body ?? null;
      if (payload !== null && typeof payload !== 'object')
        throw badRequest('invalid_payload', 'send a JSON object or array');
      const idem = req.headers['idempotency-key'];
      const r = await receiveHook(ctx, {
        scheduleId: p.id,
        secret: p.secret ?? bearer,
        payload,
        idempotencyKey: typeof idem === 'string' && idem.length <= 200 ? idem : undefined,
      });
      reply.code(r.status);
      return r.body;
    };
    const opts = {
      bodyLimit: HOOK_MAX_BYTES,
      config: { rateLimit: { max: 300, timeWindow: '1 minute' } },
    };
    fastify.post('/api/hooks/:id', opts, handler as never);
    fastify.post('/api/hooks/:id/:secret', opts, handler as never);
  };
}
