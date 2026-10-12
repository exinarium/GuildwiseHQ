import {
  CreateMailInboxRequestSchema,
  IdParamsSchema,
  MailMessagesQuerySchema,
  PatchMailInboxRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg, requireSuperAdmin } from '../auth/guards.ts';
import {
  createInbox,
  inboundHealth,
  listInboxes,
  listMessages,
  patchInbox,
  rotateInbox,
} from '../commands/mail-inboxes.ts';
import type { Ctx } from '../context.ts';
import { HttpError, notFound } from '../errors.ts';
import { countInbound, ingestInbound } from '../mail/inbound/ingest.ts';
import { configuredProvider, webhookAuthorised } from '../mail/inbound/providers.ts';
import { BadInbound } from '../mail/inbound/types.ts';
import { typed } from './util.ts';

/** Postmark's limit is 35 MB; bigger bodies never reach us. The stored-message limit (`AOM_INBOUND_MAX_BYTES`) is lower. */
const WEBHOOK_BODY_LIMIT = 36 * 1024 * 1024;

/**
 * Inbound e-mail (docs/design/workflow-builder.md D9): the provider webhook, an organisation's inboxes (Owner and
 * Admins; the allow-list is the Owner's), and the super admin's health view.
 */
export function inboundRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    // ---- The provider webhook: no cookie, no Origin. The shared secret is the credential, checked before the body is read.
    fastify.post(
      '/api/inbound/mail/:provider',
      {
        bodyLimit: WEBHOOK_BODY_LIMIT,
        config: { rateLimit: { max: 1200, timeWindow: '1 minute' } },
        onRequest: async (req) => {
          const provider = configuredProvider(ctx.config);
          const asked = (req.params as { provider?: string }).provider;
          if (!provider || provider.id !== asked) throw notFound('inbound e-mail is not set up');
          if (!webhookAuthorised(ctx.config, req.headers)) {
            await countInbound(ctx.pool, 'auth_failed').catch(() => {});
            throw new HttpError(401, 'unauthenticated', 'authentication required');
          }
        },
      },
      async (req, reply) => {
        const provider = configuredProvider(ctx.config);
        if (!provider) throw notFound('inbound e-mail is not set up');
        let message: ReturnType<typeof provider.parse>;
        try {
          message = provider.parse(req.body);
        } catch (err) {
          if (!(err instanceof BadInbound)) throw err;
          // A body we cannot read will not get better: 200 so the provider does not retry it for hours.
          await countInbound(ctx.pool, 'unparsable').catch(() => {});
          return reply.code(200).send({ ok: true, ignored: 'unreadable' });
        }
        const results = await ingestInbound(ctx, message);
        return reply.code(200).send({
          ok: true,
          results: results.map((r) => ({ status: r.status, ...(r.reason ? { reason: r.reason } : {}) })),
        });
      },
    );

    // ---- An organisation's inboxes
    app.get('/api/mail-inboxes', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return listInboxes(ctx, a.orgId);
    });

    app.post('/api/mail-inboxes', { schema: { body: CreateMailInboxRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      const inbox = await createInbox(ctx, a, req.body);
      reply.code(201);
      return inbox;
    });

    app.patch(
      '/api/mail-inboxes/:id',
      { schema: { params: IdParamsSchema, body: PatchMailInboxRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        return patchInbox(ctx, a, req.params.id, req.body);
      },
    );

    app.post('/api/mail-inboxes/:id/rotate', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return rotateInbox(ctx, a, req.params.id);
    });

    app.get(
      '/api/mail-inboxes/:id/messages',
      { schema: { params: IdParamsSchema, querystring: MailMessagesQuerySchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        return { messages: await listMessages(ctx, a.orgId, req.params.id, req.query.limit) };
      },
    );

    // ---- The platform's view of the provider (super admin)
    app.get('/api/platform/inbound', async (req) => {
      await requireSuperAdmin(ctx, req);
      return inboundHealth(ctx);
    });
  };
}
