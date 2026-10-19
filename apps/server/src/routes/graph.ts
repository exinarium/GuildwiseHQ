import { CreateOrgGraphLinkRequestSchema, IdParamsSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { projectGraphStatus, reindexProjectGraph } from '../commands/graph.ts';
import { assertOrgLink, listOrgLinks, retractOrgLink } from '../commands/org-graph.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** Project graph STATUS (docs/design/project-graphs.md owner decision 5: no graph view, nothing code-derived). */
export function graphRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/projects/:id/graph', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return projectGraphStatus(ctx, a.session.user, req.params.id);
    });

    app.post('/api/projects/:id/graph/index', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      const r = await reindexProjectGraph(ctx, a.session.user, req.params.id);
      reply.code(202);
      return r;
    });

    // Links the Owner asserted between projects (project ids, or names they typed). Derived links are not served: they stay
    // in the organization vault and the CEO shows them in chat (docs/design/project-graphs.md section 8).
    app.get('/api/org-graph/links', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return { links: await listOrgLinks(ctx, a.orgId) };
    });

    app.post(
      '/api/org-graph/links',
      { schema: { body: CreateOrgGraphLinkRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await assertOrgLink(ctx, a.session.user, { id: a.orgId, role: a.role }, req.body);
        reply.code(201);
        return { links: await listOrgLinks(ctx, a.orgId) };
      },
    );

    app.delete('/api/org-graph/links/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await retractOrgLink(ctx, a.session.user, { id: a.orgId, role: a.role }, req.params.id);
      return { links: await listOrgLinks(ctx, a.orgId) };
    });
  };
}
