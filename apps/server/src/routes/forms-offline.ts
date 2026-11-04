import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import { cancelOfflineRequest, resendOfflineLink, showOfflineEmail } from '../commands/forms-offline.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** The desk side of the runner-offline flow: Show email (audited), Resend link, Cancel. Owner and Admin only. */
export function formsOfflineRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const Id = z.object({ id: z.uuid() });
    const admin = async (req: Parameters<typeof requireOrg>[1]) =>
      whoOf(await requireOrg(ctx, req, { min: 'admin' }));

    app.post('/api/forms/offline-requests/:id/email', { schema: { params: Id } }, async (req, reply) => {
      const out = await showOfflineEmail(ctx, await admin(req), req.params.id);
      return reply.header('cache-control', 'no-store').send(out);
    });
    app.post('/api/forms/offline-requests/:id/resend', { schema: { params: Id } }, async (req) => {
      const out = await resendOfflineLink(ctx, await admin(req), req.params.id);
      return { ok: true, ...out };
    });
    app.post('/api/forms/offline-requests/:id/cancel', { schema: { params: Id } }, async (req) => {
      await cancelOfflineRequest(ctx, await admin(req), req.params.id);
      return { ok: true };
    });
  };
}
