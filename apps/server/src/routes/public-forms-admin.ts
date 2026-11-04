import { CreateClientLinkSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import {
  createClientLink,
  getPublication,
  listClientLinks,
  listSubmissions,
  publishForm,
  resetPublicLink,
  revokeClientLink,
  unpublishForm,
} from '../commands/public-forms.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const IdParams = z.object({ id: z.uuid() });

/** Publishing a form, its personal links and the desk's list of submissions. Members read, Owner and Admins write. */
export function publicFormAdminRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/forms/:id/publication', { schema: { params: IdParams } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return getPublication(ctx, a.orgId, req.params.id);
    });
    app.post('/api/forms/:id/publish', { schema: { params: IdParams } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return publishForm(ctx, whoOf(a), req.params.id);
    });
    app.post('/api/forms/:id/unpublish', { schema: { params: IdParams } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return unpublishForm(ctx, whoOf(a), req.params.id);
    });
    app.post('/api/forms/:id/publication/reset-link', { schema: { params: IdParams } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return resetPublicLink(ctx, whoOf(a), req.params.id);
    });

    app.get('/api/forms/:id/client-links', { schema: { params: IdParams } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { links: await listClientLinks(ctx, a.orgId, req.params.id) };
    });
    app.post(
      '/api/forms/:id/client-links',
      { schema: { params: IdParams, body: CreateClientLinkSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        reply.code(201);
        return createClientLink(ctx, whoOf(a), req.params.id, req.body);
      },
    );
    app.post(
      '/api/forms/:id/client-links/:linkId/revoke',
      { schema: { params: IdParams.extend({ linkId: z.string().length(22) }) } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await revokeClientLink(ctx, whoOf(a), req.params.id, req.params.linkId);
        reply.code(204);
      },
    );

    app.get(
      '/api/forms/:id/submissions',
      { schema: { params: IdParams, querystring: z.object({ cursor: z.iso.datetime().optional() }) } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return listSubmissions(ctx, a.orgId, req.params.id, req.query.cursor);
      },
    );
  };
}
