import { CreateLedgerEntryRequestSchema, LedgerQuerySchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { addLedgerEntry } from '../commands/ledger.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { getLedgerDto, listLedger } from '../queries/ledger.ts';
import { typed } from './util.ts';

export function ledgerRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/ledger', { schema: { querystring: LedgerQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { entries: await listLedger(ctx.pool, s.user.id, req.query) };
    });

    app.post('/api/ledger', { schema: { body: CreateLedgerEntryRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const id = await addLedgerEntry(ctx, s.user, req.body);
      const entry = await getLedgerDto(ctx.pool, id);
      if (!entry) throw notFound('ledger entry not found');
      reply.code(201);
      return { entry };
    });
  };
}
