import {
  CardParamsSchema,
  CreateMailInboxRequestSchema,
  IdParamsSchema,
  MailMessagesQuerySchema,
  MailReplyRequestSchema,
  PatchMailInboxRequestSchema,
} from '@aom/shared';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireOrg, requireSuperAdmin, requireUser } from '../auth/guards.ts';
import { currentMailDraft, requestMailDraft } from '../commands/mail-draft.ts';
import {
  createInbox,
  inboundHealth,
  listInboxes,
  listMessages,
  patchInbox,
  rotateInbox,
} from '../commands/mail-inboxes.ts';
import { getMailThread, replyToMailThread } from '../commands/mail-reply.ts';
import type { Ctx } from '../context.ts';
import { HttpError, notFound } from '../errors.ts';
import { dispatchInbound } from '../mail/inbound/dispatch.ts';
import { countInbound } from '../mail/inbound/ingest.ts';
import { configuredProvider, webhookAuthorised } from '../mail/inbound/providers.ts';
import { BadInbound, type MultipartBody } from '../mail/inbound/types.ts';
import { typed } from './util.ts';

/** Postmark's and SendGrid's limit is 30 to 35 MB; bigger bodies never reach us. The stored-message limit (`AOM_INBOUND_MAX_BYTES`) is lower. */
const WEBHOOK_BODY_LIMIT = 36 * 1024 * 1024;

/**
 * SendGrid Inbound Parse posts `multipart/form-data`. Fields are read as latin-1 so every byte survives (the adapter decodes with
 * the charset SendGrid states); a file (an attachment) is only counted, never kept. Throws `BadInbound` for a form that is
 * malformed or over the limits.
 */
async function collectMultipart(req: FastifyRequest): Promise<MultipartBody> {
  const body: MultipartBody = { fields: {}, files: [], bytes: 0 };
  try {
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        let size = 0;
        for await (const chunk of part.file) size += (chunk as Buffer).length;
        body.bytes += size;
        if (part.file.truncated) body.bytes += WEBHOOK_BODY_LIMIT;
        // The raw-MIME mode could send `email` as a file part: keep nothing, the field form is what SendGrid uses.
        body.files.push({
          field: part.fieldname,
          filename: part.filename ?? '',
          contentType: part.mimetype ?? '',
          size,
        });
      } else {
        const value = typeof part.value === 'string' ? part.value : '';
        body.bytes += value.length;
        if (part.valueTruncated) body.bytes += WEBHOOK_BODY_LIMIT;
        if (!(part.fieldname in body.fields)) body.fields[part.fieldname] = value;
      }
    }
  } catch (err) {
    throw new BadInbound(`unreadable form: ${(err as Error).message}`);
  }
  return body;
}

/**
 * Inbound e-mail (docs/design/workflow-builder.md D9): the provider webhook, an organisation's inboxes (Owner and
 * Admins; the allow-list is the Owner's), and the super admin's health view.
 */
export function inboundRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    // Multipart is parsed for this plugin's routes only (the webhook); `defCharset` keeps field bytes intact.
    await fastify.register(multipart, {
      defCharset: 'latin1',
      limits: {
        fieldSize: WEBHOOK_BODY_LIMIT,
        fileSize: WEBHOOK_BODY_LIMIT,
        files: 100,
        fields: 60,
        parts: 200,
      },
    } as Parameters<typeof multipart>[1]);

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
        let message: Awaited<ReturnType<typeof provider.parse>>;
        try {
          message = await provider.parse(req.isMultipart() ? await collectMultipart(req) : req.body);
        } catch (err) {
          if (!(err instanceof BadInbound)) throw err;
          // A body we cannot read will not get better: 200 so the provider does not retry it for hours.
          await countInbound(ctx.pool, 'unparsable').catch(() => {});
          return reply.code(200).send({ ok: true, ignored: 'unreadable' });
        }
        const results = await dispatchInbound(ctx, message);
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

    // ---- Conversations and replies as the organisation (#15)
    app.get('/api/mail-threads/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getMailThread(ctx, s.user, { threadId: req.params.id });
    });
    app.post(
      '/api/mail-threads/:id/reply',
      { schema: { params: IdParamsSchema, body: MailReplyRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return replyToMailThread(ctx, s.user, { threadId: req.params.id }, req.body);
      },
    );
    app.get('/api/cards/:id/mail-thread', { schema: { params: CardParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getMailThread(ctx, s.user, { cardId: req.params.id });
    });
    app.post(
      '/api/cards/:id/mail-reply',
      { schema: { params: CardParamsSchema, body: MailReplyRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return replyToMailThread(ctx, s.user, { cardId: req.params.id }, req.body);
      },
    );

    // ---- "Draft with BA": a reply draft written by a BA task, reviewed and sent by a person
    app.get('/api/mail-threads/:id/draft', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { draft: await currentMailDraft(ctx, s.user, { threadId: req.params.id }) };
    });
    app.post('/api/mail-threads/:id/draft', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      reply.code(202);
      return { draft: await requestMailDraft(ctx, s.user, { threadId: req.params.id }) };
    });
    app.get('/api/cards/:id/mail-draft', { schema: { params: CardParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { draft: await currentMailDraft(ctx, s.user, { cardId: req.params.id }) };
    });
    app.post('/api/cards/:id/mail-draft', { schema: { params: CardParamsSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      reply.code(202);
      return { draft: await requestMailDraft(ctx, s.user, { cardId: req.params.id }) };
    });

    // ---- The platform's view of the provider (super admin)
    app.get('/api/platform/inbound', async (req) => {
      await requireSuperAdmin(ctx, req);
      return inboundHealth(ctx);
    });
  };
}
