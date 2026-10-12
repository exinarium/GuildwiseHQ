import {
  IdParamsSchema,
  SetProjectWorkflowsRequestSchema,
  VariantParamsSchema,
  WorkflowVariantRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { catalogueOrg, discardDraft, submitDraft, validateDraft } from '../commands/designer.ts';
import { projectWorkflowsView, setProjectWorkflows } from '../commands/project-workflows.ts';
import { rebaseVariant, saveVariantDraft } from '../commands/workflow-variants.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { typed } from './util.ts';

/**
 * More than one workflow per project (#10): the enabled set, and the project's workflow variants (insertions on a base
 * workflow, drafted here, approved by the owner on the desk like any custom workflow).
 */
export function projectWorkflowRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/projects/:id/workflows', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return projectWorkflowsView(ctx, s.user.id, req.params.id);
    });

    app.put(
      '/api/projects/:id/workflows',
      { schema: { params: IdParamsSchema, body: SetProjectWorkflowsRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return setProjectWorkflows(ctx, s.user, req.params.id, req.body);
      },
    );

    /** Owner and Admins of the project's organization; the variant must belong to the project in the URL. */
    const variantContext = async (
      req: Parameters<typeof requireUser>[1],
      projectId: string,
      versionId?: string,
    ) => {
      const s = await requireUser(ctx, req);
      const { orgId } = await catalogueOrg(ctx.pool, s.user, null, projectId, true);
      if (versionId) {
        const row = await one(
          ctx.pool,
          'SELECT 1 AS x FROM workflow_versions WHERE id=$1 AND org_id=$2 AND project_id=$3',
          [versionId, orgId, projectId],
        );
        if (!row) throw notFound('variant not found');
      }
      return { s, orgId, designer: { kind: 'user', userId: s.user.id } as const };
    };

    app.post(
      '/api/projects/:id/workflow-variants',
      { schema: { params: IdParamsSchema, body: WorkflowVariantRequestSchema } },
      async (req, reply) => {
        const { orgId, designer } = await variantContext(req, req.params.id);
        reply.code(201);
        return saveVariantDraft(ctx, designer, orgId, { ...req.body, projectId: req.params.id } as never);
      },
    );

    app.put(
      '/api/projects/:id/workflow-variants/:versionId',
      { schema: { params: VariantParamsSchema, body: WorkflowVariantRequestSchema } },
      async (req) => {
        const { orgId, designer } = await variantContext(req, req.params.id, req.params.versionId);
        return saveVariantDraft(ctx, designer, orgId, { ...req.body, projectId: req.params.id } as never, {
          id: req.params.versionId,
        });
      },
    );

    app.post(
      '/api/projects/:id/workflow-variants/:versionId/validate',
      { schema: { params: VariantParamsSchema } },
      async (req) => {
        const { orgId } = await variantContext(req, req.params.id, req.params.versionId);
        return validateDraft(ctx, orgId, 'workflow', req.params.versionId);
      },
    );

    app.post(
      '/api/projects/:id/workflow-variants/:versionId/submit',
      { schema: { params: VariantParamsSchema } },
      async (req) => {
        const { orgId, designer } = await variantContext(req, req.params.id, req.params.versionId);
        return submitDraft(ctx, designer, orgId, 'workflow', req.params.versionId);
      },
    );

    app.post(
      '/api/projects/:id/workflow-variants/:versionId/rebase',
      { schema: { params: VariantParamsSchema } },
      async (req, reply) => {
        const { orgId, designer } = await variantContext(req, req.params.id, req.params.versionId);
        reply.code(201);
        return rebaseVariant(ctx, designer, orgId, req.params.id, req.params.versionId);
      },
    );

    app.delete(
      '/api/projects/:id/workflow-variants/:versionId',
      { schema: { params: VariantParamsSchema } },
      async (req) => {
        const { s, orgId } = await variantContext(req, req.params.id, req.params.versionId);
        await discardDraft(ctx, s.user.id, orgId, 'workflow', req.params.versionId);
        return { ok: true };
      },
    );
  };
}
