import {
  LEGACY_CODE_V6_KEY,
  OrgContextQuerySchema,
  RoleDefinitionSchema,
  roleListedInMode,
  WorkflowDefinitionSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { requestedOrgId, resolveOrgId } from '../auth/org-context.ts';
import { isOthersPrivateRole } from '../catalogue/loader.ts';
import { subworkflowTargets } from '../catalogue/subworkflow-lookup.ts';
import { catalogueOrg } from '../commands/designer.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { orgModeOf } from '../orgs/mode.ts';
import { typed } from './util.ts';

export function catalogueRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    // Latest active version per key: built-in plus the caller's own org.
    // `?projectId=`: a shared project runs on its owner's catalogue (the Hire form lists the owner's roles).
    app.get('/api/roles', { schema: { querystring: OrgContextQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(
        ctx.pool,
        s.user,
        await resolveOrgId(ctx, s, requestedOrgId(req)),
        req.query.projectId,
        false,
      );
      const list = await rows(
        ctx.pool,
        `SELECT DISTINCT ON (r.org_id, r.key) r.org_id, r.status, r.definition, e.extensions
           FROM role_definitions r
           LEFT JOIN role_extensions e ON e.org_id = $1 AND e.role_key = r.key AND r.org_id IS NULL
          WHERE (r.org_id IS NULL OR r.org_id = $1) AND r.status = 'active'
          ORDER BY r.org_id NULLS FIRST, r.key, r.version DESC`,
        [orgId],
      );
      const mode = await orgModeOf(ctx.pool, orgId);
      return {
        roles: list
          .filter(
            (r) => r.org_id !== null || roleListedInMode(RoleDefinitionSchema.parse(r.definition).key, mode),
          )
          .map((r) => ({
            definition: RoleDefinitionSchema.parse(r.definition),
            orgId: r.org_id,
            status: r.status,
            extensions: r.extensions ?? null,
          }))
          // a role made from someone's private pack is that person's alone
          .filter((r) => !isOthersPrivateRole(r.definition.source, s.user.id)),
      };
    });

    // The sub-workflow step editor's choices: approved workflows and the caller's own projects with what is enabled.
    app.get('/api/subworkflow-targets', { schema: { querystring: OrgContextQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(
        ctx.pool,
        s.user,
        await resolveOrgId(ctx, s, requestedOrgId(req)),
        req.query.projectId,
        false,
      );
      return subworkflowTargets(ctx.pool, orgId, s.user.id);
    });

    app.get('/api/workflows', { schema: { querystring: OrgContextQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(
        ctx.pool,
        s.user,
        await resolveOrgId(ctx, s, requestedOrgId(req)),
        req.query.projectId,
        false,
      );
      const list = await rows(
        ctx.pool,
        `SELECT DISTINCT ON (org_id, key) id, org_id, status, definition FROM workflow_versions
          WHERE (org_id IS NULL OR org_id = $1) AND status = 'active' AND project_id IS NULL AND key <> '${LEGACY_CODE_V6_KEY}'
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
