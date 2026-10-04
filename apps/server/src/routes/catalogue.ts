import { OrgContextQuerySchema, RoleDefinitionSchema, WorkflowDefinitionSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { catalogueOrg } from '../commands/designer.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { typed } from './util.ts';

export function catalogueRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    // Latest active version per key: built-in plus the caller's own org.
    // `?projectId=`: a shared project runs on its owner's catalogue (the Hire form lists the owner's roles).
    app.get('/api/roles', { schema: { querystring: OrgContextQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, req.query.projectId, false);
      const list = await rows(
        ctx.pool,
        `SELECT DISTINCT ON (r.org_id, r.key) r.org_id, r.status, r.definition, e.extensions
           FROM role_definitions r
           LEFT JOIN role_extensions e ON e.org_id = $1 AND e.role_key = r.key AND r.org_id IS NULL
          WHERE (r.org_id IS NULL OR r.org_id = $1) AND r.status = 'active'
          ORDER BY r.org_id NULLS FIRST, r.key, r.version DESC`,
        [orgId],
      );
      return {
        roles: list.map((r) => ({
          definition: RoleDefinitionSchema.parse(r.definition),
          orgId: r.org_id,
          status: r.status,
          extensions: r.extensions ?? null,
        })),
      };
    });

    app.get('/api/workflows', { schema: { querystring: OrgContextQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, req.query.projectId, false);
      const list = await rows(
        ctx.pool,
        `SELECT DISTINCT ON (org_id, key) id, org_id, status, definition FROM workflow_versions
          WHERE (org_id IS NULL OR org_id = $1) AND status = 'active'
          ORDER BY org_id NULLS FIRST, key, version DESC`,
        [orgId],
      );
      return {
        workflows: list.map((w) => ({
          id: w.id,
          orgId: w.org_id,
          status: w.status,
          definition: WorkflowDefinitionSchema.parse(w.definition),
        })),
      };
    });
  };
}
