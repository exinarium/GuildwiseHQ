import {
  CreateLedgerEntryRequestSchema,
  EditLedgerEntryRequestSchema,
  LedgerQuerySchema,
  RetireLedgerEntryRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { requestedOrgId, resolveOrgId } from '../auth/org-context.ts';
import { addLedgerEntryChecked, editLedgerEntry } from '../commands/ledger.ts';
import { retireLedgerEntry } from '../commands/ledger-retire.ts';
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
      const r = await addLedgerEntryChecked(
        ctx,
        s.user,
        await resolveOrgId(ctx, s, requestedOrgId(req)),
        req.body,
      );
      const entry = await getLedgerDto(ctx.pool, r.entryId, s.user.id);
      if (!entry) throw notFound('ledger entry not found');
      reply.code(r.merged ? 200 : 201);
      return {
        entry,
        ...(r.merged ? { merged: true } : {}),
        ...(r.conflictsWith.length > 0 ? { conflictsWith: r.conflictsWith } : {}),
      };
    });

    const IdParams = z.object({ id: z.uuid() });

    /** An entry with its history of wordings (newest first). */
    app.get('/api/ledger/:id/history', { schema: { params: IdParams } }, async (req) => {
      const s = await requireUser(ctx, req);
      const entry = await getVisibleLedgerDto(ctx.pool, s.user.id, req.params.id);
      if (!entry) throw notFound('ledger entry not found');
      return { entry, versions: await ledgerVersions(ctx.pool, entry) };
    });

    /** Withdraws an entry with a reason: it is kept for the record, never briefed and never found by a search. */
    app.post(
      '/api/ledger/:id/retire',
      { schema: { params: IdParams, body: RetireLedgerEntryRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await retireLedgerEntry(ctx, s.user, req.params.id, req.body);
        const entry = await getLedgerDto(ctx.pool, req.params.id, s.user.id);
        if (!entry) throw notFound('ledger entry not found');
        return { entry };
      },
    );

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
