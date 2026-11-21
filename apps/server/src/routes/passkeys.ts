import {
  AddPasskeyRequestSchema,
  IdParamsSchema,
  PasskeyApprovalRequestSchema,
  PasskeyApprovalResponseSchema,
  PasskeyRegistrationOptionsResponseSchema,
  WorkstationApprovalsResponseSchema,
  WorkstationPasskeyDtoSchema,
  WorkstationPasskeysResponseSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { SlidingLimit } from '../auth/limits.ts';
import { requireStepUp } from '../auth/step-up.ts';
import {
  addPasskey,
  listPasskeys,
  registrationOptions,
  relayPasskeyApproval,
  removePasskey,
  workstationApprovals,
} from '../commands/passkeys.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const PasskeyParamsSchema = z.object({ id: z.uuid(), passkeyId: z.uuid() });
const ItemParamsSchema = z.object({ id: z.uuid(), itemId: z.string().min(1).max(64) });

/**
 * The workstation page's Approvals (R22): passkeys for the two routine held kinds and the held list. Only the workstation's
 * owner. The server verifies registrations and relays assertions; the runner decides (DESIGN R18-S2).
 */
export function passkeyRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const registrations = new SlidingLimit(10, 60_000);
    const relays = new SlidingLimit(20, 60_000);

    app.get('/api/workstations/:id/passkeys', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return WorkstationPasskeysResponseSchema.parse(await listPasskeys(ctx, s.user, req.params.id));
    });

    // Adding a passkey adds an approver: a fresh "Confirm it's you" first (R5), before the WebAuthn ceremony.
    app.post(
      '/api/workstations/:id/passkeys/options',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        requireStepUp(ctx, s);
        if (ctx.config.rateLimit) registrations.hit(s.user.id);
        return PasskeyRegistrationOptionsResponseSchema.parse(
          await registrationOptions(ctx, s.user, req.params.id),
        );
      },
    );

    app.post(
      '/api/workstations/:id/passkeys',
      { schema: { params: IdParamsSchema, body: AddPasskeyRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        requireStepUp(ctx, s);
        const dto = await addPasskey(ctx, s.user, req.params.id, req.body);
        reply.code(201);
        return WorkstationPasskeyDtoSchema.parse(dto);
      },
    );

    app.delete(
      '/api/workstations/:id/passkeys/:passkeyId',
      { schema: { params: PasskeyParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await removePasskey(ctx, s.user, req.params.id, req.params.passkeyId);
        return { ok: true };
      },
    );

    app.get('/api/workstations/:id/approvals', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return WorkstationApprovalsResponseSchema.parse(await workstationApprovals(ctx, s.user, req.params.id));
    });

    app.post(
      '/api/workstations/:id/approvals/:itemId/passkey',
      { schema: { params: ItemParamsSchema, body: PasskeyApprovalRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        if (ctx.config.rateLimit) relays.hit(s.user.id);
        const r = await relayPasskeyApproval(ctx, s.user, req.params.id, req.params.itemId, req.body);
        reply.code(202);
        return PasskeyApprovalResponseSchema.parse(r);
      },
    );
  };
}
