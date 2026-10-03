import {
  IdParamsSchema,
  PairingCodeResponseSchema,
  PatchWorkstationRequestSchema,
  RunnerPairRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireAdmin, requireUser } from '../auth/guards.ts';
import {
  createPairingCode,
  pairRunner,
  renameWorkstation,
  unlinkWorkstation,
} from '../commands/workstations.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { workstationDtos } from '../queries/misc.ts';
import { typed } from './util.ts';

export function workstationRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    const own = async (userId: string, id: string) => {
      const [w] = await workstationDtos(ctx, 'w.id = $1 AND w.user_id = $2', [id, userId]);
      if (!w) throw notFound('workstation not found');
      return w;
    };

    app.get('/api/workstations', async (req) => {
      const s = await requireUser(ctx, req);
      return {
        workstations: await workstationDtos(ctx, `w.user_id = $1 AND w.status = 'active'`, [s.user.id]),
      };
    });

    app.post('/api/workstations/pairing-codes', async (req, reply) => {
      const s = await requireUser(ctx, req);
      reply.code(201);
      return PairingCodeResponseSchema.parse(await createPairingCode(ctx, s.user));
    });

    app.patch(
      '/api/workstations/:id',
      { schema: { params: IdParamsSchema, body: PatchWorkstationRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await renameWorkstation(ctx, s.user, req.params.id, req.body.name);
        return own(s.user.id, req.params.id);
      },
    );

    app.post('/api/workstations/:id/unlink', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await unlinkWorkstation(ctx, s.user, req.params.id);
      return { ok: true };
    });

    // Unauthenticated: the pairing code is the credential. Called by the runner CLI (no Origin header).
    app.post(
      '/api/runner/pair',
      {
        schema: { body: RunnerPairRequestSchema },
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      },
      async (req) => pairRunner(ctx, req.body),
    );

    app.get('/api/admin/workstations', async (req) => {
      await requireAdmin(ctx, req);
      return { workstations: await workstationDtos(ctx, `w.status = 'active'`, []) };
    });

    app.post('/api/admin/workstations/:id/unlink', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireAdmin(ctx, req);
      await unlinkWorkstation(ctx, s.user, req.params.id);
      return { ok: true };
    });
  };
}
