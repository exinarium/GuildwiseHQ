import {
  IdParamsSchema,
  PatchVaultRequestSchema,
  RegisterVaultRequestSchema,
  ResolveVaultConflictRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { type Who, whoOf } from '../auth/org-context.ts';
import { listVaults, registerVault, resolveVaultConflict, updateVault } from '../commands/vaults.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { typed } from './util.ts';

export function vaultRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    const one = async (who: Who, id: string) => {
      const v = (await listVaults(ctx, who)).find((x) => x.id === id);
      if (!v) throw notFound('vault not found');
      return v;
    };

    app.get('/api/vaults', async (req) => {
      return { vaults: await listVaults(ctx, whoOf(await requireOrg(ctx, req))) };
    });

    app.post('/api/vaults', { schema: { body: RegisterVaultRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      const id = await registerVault(ctx, a.session.user, { id: a.orgId, role: a.role }, req.body);
      reply.code(201);
      return one(whoOf(a), id);
    });

    app.patch(
      '/api/vaults/:id',
      { schema: { params: IdParamsSchema, body: PatchVaultRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await updateVault(ctx, a.session.user, req.params.id, req.body);
        return one(whoOf(a), req.params.id);
      },
    );

    app.post(
      '/api/vaults/:id/resolve-conflict',
      { schema: { params: IdParamsSchema, body: ResolveVaultConflictRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await resolveVaultConflict(ctx, a.session.user, req.params.id, req.body.workstationId);
        return one(whoOf(a), req.params.id);
      },
    );
  };
}
