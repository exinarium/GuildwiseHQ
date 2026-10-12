import {
  CreateDepartmentRequestSchema,
  ExtendRoleRequestSchema,
  IdParamsSchema,
  OrgContextQuerySchema,
  type OrgRole,
  RoleDraftInputSchema,
  RoleExtensionParamsSchema,
  RolePreviewQuerySchema,
  RolePreviewRequestSchema,
  WorkflowDraftInputSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { requestedOrgId, resolveOrgId } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import {
  catalogueOrg,
  createDepartment,
  definitionFile,
  discardDraft,
  extendRole,
  listDepartments,
  orgCatalogue,
  saveRoleDraft,
  saveWorkflowDraft,
  submitDraft,
  validateDraft,
} from '../commands/designer.ts';
import { previewRole, previewRoleDraft } from '../commands/role-preview.ts';
import type { Ctx } from '../context.ts';
import { resetRole } from '../hr/hr.ts';
import { typed } from './util.ts';

/** Organization designer routes (M10). Reads: any member of the owning organization; writes: its owner only. */
export function designerRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const q = { querystring: OrgContextQuerySchema };
    /** The organization of the request (header, else the session default); null for a user without any. */
    const reqOrg = (req: Parameters<typeof requestedOrgId>[0], s: AuthSession) =>
      resolveOrgId(ctx, s, requestedOrgId(req));

    app.get('/api/org/catalogue', { schema: q }, async (req) => {
      const s = await requireUser(ctx, req);
      return orgCatalogue(ctx, s.user, await reqOrg(req, s), req.query.projectId);
    });

    app.get('/api/org/definitions/:id/file', { schema: { ...q, params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return definitionFile(ctx, s.user, await reqOrg(req, s), req.params.id, req.query.projectId);
    });

    // ----- roles
    app.post('/api/roles', { schema: { ...q, body: RoleDraftInputSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, await reqOrg(req, s), req.query.projectId, true);
      reply.code(201);
      return saveRoleDraft(ctx, { kind: 'user', userId: s.user.id }, orgId, req.body);
    });
    app.put(
      '/api/roles/:id',
      { schema: { ...q, params: IdParamsSchema, body: RoleDraftInputSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const { orgId } = await catalogueOrg(
          ctx.pool,
          s.user,
          await reqOrg(req, s),
          req.query.projectId,
          true,
        );
        return saveRoleDraft(ctx, { kind: 'user', userId: s.user.id }, orgId, req.body, {
          id: req.params.id,
        });
      },
    );
    // The prompt preview: the real renderer on a sample brief, no agent runs. Same permission as editing roles.
    app.post('/api/roles/preview', { schema: { ...q, body: RolePreviewRequestSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, await reqOrg(req, s), req.query.projectId, true);
      const { role, ...opts } = req.body;
      return previewRole(ctx.pool, orgId, role, opts);
    });
    app.get(
      '/api/roles/drafts/:id/preview',
      { schema: { querystring: RolePreviewQuerySchema, params: IdParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const { projectId, ...opts } = req.query;
        const { orgId } = await catalogueOrg(ctx.pool, s.user, await reqOrg(req, s), projectId, true);
        return previewRoleDraft(ctx.pool, orgId, req.params.id, opts);
      },
    );
    app.post('/api/roles/:id/validate', { schema: { ...q, params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, await reqOrg(req, s), req.query.projectId, true);
      return validateDraft(ctx, orgId, 'role', req.params.id);
    });
    app.post('/api/roles/:id/submit', { schema: { ...q, params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, await reqOrg(req, s), req.query.projectId, true);
      return submitDraft(ctx, { kind: 'user', userId: s.user.id }, orgId, 'role', req.params.id);
    });
    app.delete('/api/roles/:id', { schema: { ...q, params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, await reqOrg(req, s), req.query.projectId, true);
      await discardDraft(ctx, s.user.id, orgId, 'role', req.params.id);
      return { ok: true };
    });
    app.put(
      '/api/roles/:key/extensions',
      { schema: { ...q, params: RoleExtensionParamsSchema, body: ExtendRoleRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const { orgId } = await catalogueOrg(
          ctx.pool,
          s.user,
          await reqOrg(req, s),
          req.query.projectId,
          true,
        );
        return extendRole(ctx, s.user, orgId, req.params.key, req.body);
      },
    );
    app.post(
      '/api/roles/:key/reset',
      { schema: { ...q, params: RoleExtensionParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const { orgId, role } = await catalogueOrg(
          ctx.pool,
          s.user,
          await reqOrg(req, s),
          req.query.projectId,
          true,
        );
        return resetRole(ctx, s.user, { userId: s.user.id, orgId, role: role as OrgRole }, req.params.key);
      },
    );

    // ----- workflows
    app.post('/api/workflows', { schema: { ...q, body: WorkflowDraftInputSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, await reqOrg(req, s), req.query.projectId, true);
      reply.code(201);
      return saveWorkflowDraft(ctx, { kind: 'user', userId: s.user.id }, orgId, req.body);
    });
    app.put(
      '/api/workflows/:id',
      { schema: { ...q, params: IdParamsSchema, body: WorkflowDraftInputSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const { orgId } = await catalogueOrg(
          ctx.pool,
          s.user,
          await reqOrg(req, s),
          req.query.projectId,
          true,
        );
        return saveWorkflowDraft(ctx, { kind: 'user', userId: s.user.id }, orgId, req.body, {
          id: req.params.id,
        });
      },
    );
    app.post('/api/workflows/:id/validate', { schema: { ...q, params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, await reqOrg(req, s), req.query.projectId, true);
      return validateDraft(ctx, orgId, 'workflow', req.params.id);
    });
    app.post('/api/workflows/:id/submit', { schema: { ...q, params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, await reqOrg(req, s), req.query.projectId, true);
      return submitDraft(ctx, { kind: 'user', userId: s.user.id }, orgId, 'workflow', req.params.id);
    });
    app.delete('/api/workflows/:id', { schema: { ...q, params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, await reqOrg(req, s), req.query.projectId, true);
      await discardDraft(ctx, s.user.id, orgId, 'workflow', req.params.id);
      return { ok: true };
    });

    // ----- departments
    app.get('/api/departments', { schema: q }, async (req) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(
        ctx.pool,
        s.user,
        await reqOrg(req, s),
        req.query.projectId,
        false,
      );
      return { departments: await listDepartments(ctx.pool, orgId) };
    });
    app.post(
      '/api/departments',
      { schema: { ...q, body: CreateDepartmentRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const { orgId } = await catalogueOrg(
          ctx.pool,
          s.user,
          await reqOrg(req, s),
          req.query.projectId,
          true,
        );
        reply.code(201);
        return createDepartment(ctx, s.user, orgId, req.body);
      },
    );
  };
}
