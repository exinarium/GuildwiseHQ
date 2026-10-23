import {
  AcceptPackUpdateRequestSchema,
  AddPackRequestSchema,
  CheckPackRequestSchema,
  PackScriptsRequestSchema,
  TrustPackRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import {
  acceptPackUpdate,
  addPack,
  checkPack,
  getPack,
  listPacks,
  removePack,
  revokePack,
  setPackScripts,
  trustPack,
} from '../commands/packs.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const Params = z.object({ id: z.uuid() });

/** Capability packs: git import, trust review, update diffs (docs/ARCHITECTURE.md section 38.4). Owners and admins only. */
export function packRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const who = async (req: Parameters<typeof requireOrg>[1]) =>
      whoOf(await requireOrg(ctx, req, { min: 'admin' }));

    app.get('/api/packs', async (req) => listPacks(ctx, await who(req)));
    app.post('/api/packs', { schema: { body: AddPackRequestSchema } }, async (req, reply) => {
      reply.code(201);
      return { pack: await addPack(ctx, await who(req), req.body) };
    });
    app.get('/api/packs/:id', { schema: { params: Params } }, async (req) => ({
      pack: await getPack(ctx, await who(req), req.params.id),
    }));
    app.post(
      '/api/packs/:id/check',
      { schema: { params: Params, body: CheckPackRequestSchema } },
      async (req, reply) => {
        reply.code(202);
        return checkPack(ctx, await who(req), req.params.id, req.body.ref);
      },
    );
    app.post(
      '/api/packs/:id/accept-update',
      { schema: { params: Params, body: AcceptPackUpdateRequestSchema } },
      async (req) => ({ pack: await acceptPackUpdate(ctx, await who(req), req.params.id, req.body.sha) }),
    );
    app.post(
      '/api/packs/:id/trust',
      { schema: { params: Params, body: TrustPackRequestSchema } },
      async (req) => ({
        pack: await trustPack(ctx, await who(req), req.params.id, req.body),
      }),
    );
    app.post('/api/packs/:id/revoke', { schema: { params: Params } }, async (req) => ({
      pack: await revokePack(ctx, await who(req), req.params.id),
    }));
    app.post(
      '/api/packs/:id/scripts',
      { schema: { params: Params, body: PackScriptsRequestSchema } },
      async (req) => ({
        pack: await setPackScripts(ctx, await who(req), req.params.id, req.body.enabled),
      }),
    );
    app.delete('/api/packs/:id', { schema: { params: Params } }, async (req, reply) => {
      await removePack(ctx, await who(req), req.params.id);
      reply.code(204);
    });
  };
}
