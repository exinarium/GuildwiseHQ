import {
  IdParamsSchema,
  PatchVaultRequestSchema,
  RegisterVaultRequestSchema,
  ResolveVaultConflictRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { listVaults, registerVault, resolveVaultConflict, updateVault } from '../commands/vaults.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { typed } from './util.ts';

export function vaultRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    const one = async (userId: string, id: string) => {
      const v = (await listVaults(ctx, userId)).find((x) => x.id === id);
      if (!v) throw notFound('vault not found');
      return v;
    };

    app.get('/api/vaults', async (req) => {
      const s = await requireUser(ctx, req);
      return { vaults: await listVaults(ctx, s.user.id) };
    });

    app.post('/api/vaults', { schema: { body: RegisterVaultRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const id = await registerVault(ctx, s.user, req.body);
      reply.code(201);
      return one(s.user.id, id);
    });

    app.patch(
      '/api/vaults/:id',
      { schema: { params: IdParamsSchema, body: PatchVaultRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await updateVault(ctx, s.user, req.params.id, req.body);
        return one(s.user.id, req.params.id);
      },
    );

    app.post(
      '/api/vaults/:id/resolve-conflict',
      { schema: { params: IdParamsSchema, body: ResolveVaultConflictRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await resolveVaultConflict(ctx, s.user, req.params.id, req.body.workstationId);
        return one(s.user.id, req.params.id);
      },
    );
  };
}
