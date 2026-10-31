import {
  AuthorizeStandingOrderRequestSchema,
  CreateLedgerEntryRequestSchema,
  EditLedgerEntryRequestSchema,
  EscalateStandingOrderRequestSchema,
  LedgerQuerySchema,
  ledgerToday,
  RetireLedgerEntryRequestSchema,
  ReviewLedgerEntryRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { requestedOrgId, resolveOrgId } from '../auth/org-context.ts';
import { authorizeOrder, escalateOrder, revokeOrder } from '../ceo/orders.ts';
import { addLedgerEntryChecked, editLedgerEntry } from '../commands/ledger.ts';
import { retireLedgerEntry } from '../commands/ledger-retire.ts';
import { setLedgerReviewDate } from '../commands/ledger-review.ts';
import { installRulePack, listRulePacks, previewRulePack, removeRulePack } from '../commands/rule-packs.ts';
import type { Ctx } from '../context.ts';
import { forbidden, notFound } from '../errors.ts';
import { getLedgerDto, getVisibleLedgerDto, ledgerVersions, listLedger } from '../queries/ledger.ts';
import { typed } from './util.ts';

export function ledgerRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const today = () => ledgerToday(ctx.clock.now());

    app.get('/api/ledger', { schema: { querystring: LedgerQuerySchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const orgId = await resolveOrgId(ctx, s, requestedOrgId(req));
      return { entries: await listLedger(ctx.pool, s.user.id, orgId, { ...req.query, today: today() }) };
    });

    app.post('/api/ledger', { schema: { body: CreateLedgerEntryRequestSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      const r = await addLedgerEntryChecked(
        ctx,
        s.user,
        await resolveOrgId(ctx, s, requestedOrgId(req)),
        req.body,
      );
      const entry = await getLedgerDto(ctx.pool, r.entryId, today(), s.user.id);
      if (!entry) throw notFound('ledger entry not found');
      reply.code(r.merged ? 200 : 201);
      return {
        entry,
        ...(r.merged ? { merged: true } : {}),
        ...(r.conflictsWith.length > 0 ? { conflictsWith: r.conflictsWith } : {}),
      };
    });

    // Rule packs (business mode). Registered before the `:id` routes.
    const packOrg = async (
      s: Awaited<ReturnType<typeof requireUser>>,
      req: Parameters<typeof requestedOrgId>[0],
    ) => {
      const id = await resolveOrgId(ctx, s, requestedOrgId(req));
      if (!id) throw forbidden('you do not belong to an organization');
      return id;
    };
    const PackParams = z.object({ packId: z.string().min(1).max(80) });
    app.get('/api/ledger/rule-packs', async (req) => {
      const s = await requireUser(ctx, req);
      const orgId = await packOrg(s, req);
      return { packs: await listRulePacks(ctx, s.user, orgId) };
    });
    app.get('/api/ledger/rule-packs/:packId', { schema: { params: PackParams } }, async (req) => {
      const s = await requireUser(ctx, req);
      const orgId = await packOrg(s, req);
      return previewRulePack(ctx, s.user, orgId, req.params.packId);
    });
    app.post('/api/ledger/rule-packs/:packId/install', { schema: { params: PackParams } }, async (req) => {
      const s = await requireUser(ctx, req);
      const orgId = await packOrg(s, req);
      return installRulePack(ctx, s.user, orgId, req.params.packId);
    });
    app.post('/api/ledger/rule-packs/:packId/remove', { schema: { params: PackParams } }, async (req) => {
      const s = await requireUser(ctx, req);
      const orgId = await packOrg(s, req);
      return removeRulePack(ctx, s.user, orgId, req.params.packId);
    });

    const IdParams = z.object({ id: z.uuid() });

    /** An entry with its history of wordings (newest first). */
    app.get('/api/ledger/:id/history', { schema: { params: IdParams } }, async (req) => {
      const s = await requireUser(ctx, req);
      const entry = await getVisibleLedgerDto(ctx.pool, s.user.id, req.params.id, today());
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
        const entry = await getLedgerDto(ctx.pool, req.params.id, today(), s.user.id);
        if (!entry) throw notFound('ledger entry not found');
        return { entry };
      },
    );

    /** The owner confirms a due entry at a review: it stays, with a later review date or none. */
    app.post(
      '/api/ledger/:id/review',
      { schema: { params: IdParams, body: ReviewLedgerEntryRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setLedgerReviewDate(ctx, s.user, req.params.id, {
          reviewDate: req.body.reviewDate,
          confirmed: true,
        });
        const entry = await getLedgerDto(ctx.pool, req.params.id, today(), s.user.id);
        if (!entry) throw notFound('ledger entry not found');
        return { entry };
      },
    );

    /** The Owner lets the CEO enforce this order with full power, pinned to the wording he read (docs front door 3.4). */
    app.post(
      '/api/ledger/:id/authorize',
      { schema: { params: IdParams, body: AuthorizeStandingOrderRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await authorizeOrder(ctx, s.user, req.params.id, req.body);
        const entry = await getVisibleLedgerDto(ctx.pool, s.user.id, req.params.id, today());
        if (!entry) throw notFound('ledger entry not found');
        return { entry };
      },
    );

    app.post('/api/ledger/:id/revoke', { schema: { params: IdParams } }, async (req) => {
      const s = await requireUser(ctx, req);
      await revokeOrder(ctx, s.user, req.params.id);
      const entry = await getVisibleLedgerDto(ctx.pool, s.user.id, req.params.id, today());
      if (!entry) throw notFound('ledger entry not found');
      return { entry };
    });

    /** An Admin asks the Owner to take this order over as his own. */
    app.post(
      '/api/ledger/:id/escalate',
      { schema: { params: IdParams, body: EscalateStandingOrderRequestSchema.optional() } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await escalateOrder(ctx, s.user, req.params.id, req.body?.note ?? '');
        const entry = await getVisibleLedgerDto(ctx.pool, s.user.id, req.params.id, today());
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
        const entry = await getLedgerDto(ctx.pool, req.params.id, today(), s.user.id);
        if (!entry) throw notFound('ledger entry not found');
        return { entry };
      },
    );
  };
}
