import {
  RemoveOrgModelPriceQuerySchema,
  ReshareOrgProviderKeyRequestSchema,
  SetOrgModelPriceRequestSchema,
  SetOrgProviderCapRequestSchema,
  SetOrgProviderKeyRequestSchema,
  ShareOrgProviderKeyRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import { listOrgModelPrices, removeOrgModelPrice, setOrgModelPrice } from '../commands/org-model-prices.ts';
import {
  listOrgProviders,
  overrideOrgProviderCap,
  reshareOrgProviderKey,
  revokeOrgProviderKey,
  setOrgProviderCap,
  setOrgProviderKey,
  shareOrgProviderKey,
} from '../commands/org-provider-keys.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const ProviderParamsSchema = z.object({ provider: z.string().min(1).max(40) });

/**
 * Organization-wide provider keys and their monthly caps (docs/ARCHITECTURE.md section 38.5): the Owner and Admins only. The key is
 * sealed in the browser to each workstation's public key; these routes carry ciphertexts.
 */
export function orgProviderRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/org/providers', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return listOrgProviders(ctx, a.session.user, a.orgId);
    });

    app.put(
      '/api/org/providers/:provider',
      { schema: { params: ProviderParamsSchema, body: SetOrgProviderKeyRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await setOrgProviderKey(ctx, a.session.user, a.orgId, req.params.provider, req.body);
        reply.code(202);
        return { queued: true };
      },
    );

    app.delete(
      '/api/org/providers/:provider',
      { schema: { params: ProviderParamsSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await revokeOrgProviderKey(ctx, a.session.user, a.orgId, req.params.provider);
        reply.code(202);
        return { queued: true };
      },
    );

    app.put(
      '/api/org/providers/:provider/shares',
      { schema: { params: ProviderParamsSchema, body: ShareOrgProviderKeyRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await shareOrgProviderKey(ctx, a.session.user, a.orgId, req.params.provider, req.body);
        reply.code(202);
        return { queued: true };
      },
    );

    app.post(
      '/api/org/providers/:provider/reshare',
      { schema: { params: ProviderParamsSchema, body: ReshareOrgProviderKeyRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await reshareOrgProviderKey(ctx, a.session.user, a.orgId, req.params.provider, req.body);
        reply.code(202);
        return { queued: true };
      },
    );

    // Owner-set prices for models the built-in tables do not price (Owner and Admins read, the Owner sets).
    app.get('/api/org/model-prices', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return listOrgModelPrices(ctx, a.session.user, a.orgId);
    });

    app.put('/api/org/model-prices', { schema: { body: SetOrgModelPriceRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await setOrgModelPrice(ctx, a.session.user, a.orgId, req.body);
      return { ok: true };
    });

    app.delete(
      '/api/org/model-prices',
      { schema: { querystring: RemoveOrgModelPriceQuerySchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await removeOrgModelPrice(ctx, a.session.user, a.orgId, req.query.provider, req.query.model);
        return { ok: true };
      },
    );

    app.put(
      '/api/org/providers/:provider/cap',
      { schema: { params: ProviderParamsSchema, body: SetOrgProviderCapRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await setOrgProviderCap(ctx, a.session.user, a.orgId, req.params.provider, req.body.monthlyUsd);
        return { ok: true };
      },
    );

    app.post(
      '/api/org/providers/:provider/cap/override',
      { schema: { params: ProviderParamsSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await overrideOrgProviderCap(ctx, a.session.user, a.orgId, req.params.provider);
        return { ok: true };
      },
    );
  };
}
