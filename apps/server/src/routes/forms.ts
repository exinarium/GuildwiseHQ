import { CreateFormRequestSchema, FORM_LIMITS, FormStatusSchema, SaveFormRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import {
  archiveForm,
  createForm,
  readFormLogo,
  saveForm,
  unarchiveForm,
  uploadFormLogo,
} from '../commands/forms.ts';
import type { Ctx } from '../context.ts';
import { badRequest } from '../errors.ts';
import { getForm, getFormVersion, listForms } from '../queries/forms.ts';
import { typed } from './util.ts';

const BODY_LIMIT = FORM_LIMITS.logoBytes + 16 * 1024;
const IdParams = z.object({ id: z.uuid() });
const VersionParams = z.object({ id: z.uuid(), version: z.coerce.number().int().min(1) });

/**
 * Forms: any member reads, the Owner and Admins write. A form of another organization answers 404. No answers are
 * stored by any route here.
 */
export function formRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get(
      '/api/forms',
      { schema: { querystring: z.object({ status: FormStatusSchema.default('active') }) } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return { forms: await listForms(ctx, a.orgId, req.query.status) };
      },
    );

    app.post('/api/forms', { schema: { body: CreateFormRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      reply.code(201);
      return createForm(ctx, whoOf(a), req.body.definition);
    });

    app.get('/api/forms/:id', { schema: { params: IdParams } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return getForm(ctx.pool, a.orgId, req.params.id);
    });

    app.get('/api/forms/:id/versions/:version', { schema: { params: VersionParams } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return getFormVersion(ctx, a.orgId, req.params.id, req.params.version);
    });

    app.put('/api/forms/:id', { schema: { params: IdParams, body: SaveFormRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return saveForm(ctx, whoOf(a), req.params.id, req.body);
    });

    app.post('/api/forms/:id/archive', { schema: { params: IdParams } }, async (req, reply) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await archiveForm(ctx, whoOf(a), req.params.id);
      reply.code(204);
    });

    app.post('/api/forms/:id/unarchive', { schema: { params: IdParams } }, async (req, reply) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await unarchiveForm(ctx, whoOf(a), req.params.id);
      reply.code(204);
    });

    // The logo travels as the raw request body (the routes of this plugin only).
    await fastify.register(async (inner) => {
      inner.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) =>
        done(null, body),
      );
      const raw = typed(inner);

      raw.post('/api/forms/logos', { bodyLimit: BODY_LIMIT }, async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        if (!Buffer.isBuffer(req.body)) throw badRequest('file_required', 'send the image as the request body');
        const out = await uploadFormLogo(ctx, whoOf(a), req.body);
        reply.code(201);
        return out;
      });

      raw.get('/api/forms/logos/:imageId', { schema: { params: z.object({ imageId: z.uuid() }) } }, async (req, reply) => {
        const a = await requireOrg(ctx, req);
        const img = await readFormLogo(ctx, a.orgId, req.params.imageId);
        return reply
          .header('content-type', img.contentType)
          .header('content-security-policy', "sandbox; default-src 'none'")
          .header('x-content-type-options', 'nosniff')
          .header('cache-control', 'private, max-age=86400, immutable')
          .header('cross-origin-resource-policy', 'same-origin')
          .send(img.data);
      });
    });
  };
}
