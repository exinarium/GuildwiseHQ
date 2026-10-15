import { CreateLedgerEntryRequestSchema, EditLedgerEntryRequestSchema, LedgerQuerySchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { requestedOrgId, resolveOrgId } from '../auth/org-context.ts';
import { addLedgerEntry, editLedgerEntry } from '../commands/ledger.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { getLedgerDto, getVisibleLedgerDto, ledgerVersions, listLedger } from '../queries/ledger.ts';
import { typed } from './util.ts';

export function ledgerRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/ledger', { schema: { querystring: LedgerQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const orgId = await resolveOrgId(ctx, s, requestedOrgId(req));
      return { entries: await listLedger(ctx.pool, s.user.id, orgId, req.query) };
    });

    app.post('/api/ledger', { schema: { body: CreateLedgerEntryRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const id = await addLedgerEntry(ctx, s.user, await resolveOrgId(ctx, s, requestedOrgId(req)), req.body);
      const entry = await getLedgerDto(ctx.pool, id, s.user.id);
      if (!entry) throw notFound('ledger entry not found');
      reply.code(201);
      return { entry };
    });

    const IdParams = z.object({ id: z.uuid() });

    /** An entry with its history of wordings (newest first). */
    app.get('/api/ledger/:id/history', { schema: { params: IdParams } }, async (req) => {
      const s = await requireUser(ctx, req);
      const entry = await getVisibleLedgerDto(ctx.pool, s.user.id, req.params.id);
      if (!entry) throw notFound('ledger entry not found');
      return { entry, versions: await ledgerVersions(ctx.pool, entry) };
    });

    /** Edits a live standing order in place; the earlier wording stays in its history. */
    app.patch(
      '/api/ledger/:id',
      { schema: { params: IdParams, body: EditLedgerEntryRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await editLedgerEntry(ctx, s.user, req.params.id, req.body);
        const entry = await getLedgerDto(ctx.pool, req.params.id, s.user.id);
        if (!entry) throw notFound('ledger entry not found');
        return { entry };
      },
    );
  };
}
