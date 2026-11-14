import { InstallIndustryBundleRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { requestedOrgId, resolveOrgId } from '../auth/org-context.ts';
import {
  installIndustryBundle,
  listIndustryBundles,
  previewIndustryBundle,
  removeIndustryBundle,
} from '../commands/industry-bundles.ts';
import type { Ctx } from '../context.ts';
import { forbidden } from '../errors.ts';
import { typed } from './util.ts';

const Params = z.object({ bundleId: z.string().min(1).max(80) });
const PreviewQuery = z.object({ projectId: z.uuid().optional() });

export function industryBundleRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const orgOf = async (
      s: Awaited<ReturnType<typeof requireUser>>,
      req: Parameters<typeof requestedOrgId>[0],
    ) => {
      const id = await resolveOrgId(ctx, s, requestedOrgId(req));
      if (!id) throw forbidden('you do not belong to an organization');
      return id;
    };

    app.get('/api/industry-bundles', async (req) => {
      const s = await requireUser(ctx, req);
      return { bundles: await listIndustryBundles(ctx, s.user, await orgOf(s, req)) };
    });
    app.get(
      '/api/industry-bundles/:bundleId',
      { schema: { params: Params, querystring: PreviewQuery } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return previewIndustryBundle(
          ctx,
          s.user,
          await orgOf(s, req),
          req.params.bundleId,
          req.query.projectId,
        );
      },
    );
    app.post(
      '/api/industry-bundles/:bundleId/install',
      { schema: { params: Params, body: InstallIndustryBundleRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return installIndustryBundle(ctx, s.user, await orgOf(s, req), req.params.bundleId, req.body);
      },
    );
    app.post('/api/industry-bundles/:bundleId/remove', { schema: { params: Params } }, async (req) => {
      const s = await requireUser(ctx, req);
      return removeIndustryBundle(ctx, s.user, await orgOf(s, req), req.params.bundleId);
    });
  };
}
