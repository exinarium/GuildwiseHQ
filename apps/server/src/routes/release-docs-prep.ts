import { IdParamsSchema, ReleaseDocsPrepSettingsSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg, requireUser } from '../auth/guards.ts';
import type { Ctx } from '../context.ts';
import {
  getReleaseDocsPrepRun,
  getReleaseDocsPrepSettings,
  releaseDocsPrepOverview,
  retryReleaseDocsPrep,
  setReleaseDocsPrepSettings,
  skipReleaseDocsPrep,
  startReleaseDocsPrep,
} from '../release/docs-prep.ts';
import { typed } from './util.ts';

const RunParamsSchema = z.object({ id: z.uuid(), runId: z.uuid() });

/** Release prep (docs and videos): the switch, its runs, Retry and Skip. */
export function releaseDocsPrepRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/projects/:id/release-docs-prep/settings', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getReleaseDocsPrepSettings(ctx, s.user, req.params.id);
    });

    app.put(
      '/api/projects/:id/release-docs-prep/settings',
      { schema: { params: IdParamsSchema, body: ReleaseDocsPrepSettingsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setReleaseDocsPrepSettings(ctx, s.user, req.params.id, req.body);
        return getReleaseDocsPrepSettings(ctx, s.user, req.params.id);
      },
    );

    app.get('/api/release-docs-prep', async (req) => {
      const a = await requireOrg(ctx, req);
      return releaseDocsPrepOverview(ctx, a.session.user, a.orgId);
    });

    app.get(
      '/api/projects/:id/release-docs-prep/runs/latest',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return (await getReleaseDocsPrepRun(ctx, s.user, req.params.id, 'latest')) ?? null;
      },
    );

    app.get(
      '/api/projects/:id/release-docs-prep/runs/:runId',
      { schema: { params: RunParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return getReleaseDocsPrepRun(ctx, s.user, req.params.id, req.params.runId);
      },
    );

    app.post(
      '/api/projects/:id/release-docs-prep/runs',
      { schema: { params: IdParamsSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        reply.code(202);
        return startReleaseDocsPrep(ctx, s.user, req.params.id);
      },
    );

    app.post(
      '/api/projects/:id/release-docs-prep/runs/:runId/retry',
      { schema: { params: RunParamsSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        reply.code(202);
        return retryReleaseDocsPrep(ctx, s.user, req.params.id, req.params.runId);
      },
    );

    app.post('/api/projects/:id/release-docs-prep/skip', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      await skipReleaseDocsPrep(ctx, s.user, req.params.id);
      reply.code(204);
    });
  };
}
