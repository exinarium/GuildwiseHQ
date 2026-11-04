import { HookMappingSchema, JourneyDurationSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import {
  cancelWaitCmd,
  continueWaitCmd,
  extendWaitCmd,
  gotoWaitCmd,
  listInstanceWaits,
  resendLinkCmd,
} from '../commands/journey-waits.ts';
import type { Ctx } from '../context.ts';
import { decideGate } from '../journeys/gates.ts';
import { createTrigger, listTriggers, rotateTrigger, updateTrigger } from '../journeys/hooks/triggers.ts';
import { typed } from './util.ts';

/** Journey waits, gates and hook triggers (docs/investigations/GWP-67). Bodies are strict zod schemas. */
export function journeyWaitRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const Id = z.object({ id: z.uuid() });
    const WaitId = z.object({ waitId: z.uuid() });
    const member = async (req: Parameters<typeof requireOrg>[1]) =>
      whoOf(await requireOrg(ctx, req, { min: 'member' }));

    app.get('/api/journey-instances/:id/waits', { schema: { params: Id } }, async (req) =>
      listInstanceWaits(ctx, await member(req), req.params.id),
    );
    app.post(
      '/api/journey-waits/:waitId/extend',
      { schema: { params: WaitId, body: z.object({ duration: JourneyDurationSchema }).strict() } },
      async (req) => {
        await extendWaitCmd(ctx, await member(req), req.params.waitId, req.body.duration);
        return { ok: true };
      },
    );
    app.post('/api/journey-waits/:waitId/continue', { schema: { params: WaitId } }, async (req) => {
      await continueWaitCmd(ctx, await member(req), req.params.waitId);
      return { ok: true };
    });
    app.post(
      '/api/journey-waits/:waitId/goto',
      { schema: { params: WaitId, body: z.object({ stepId: z.string().min(1).max(60) }).strict() } },
      async (req) => {
        await gotoWaitCmd(ctx, await member(req), req.params.waitId, req.body.stepId);
        return { ok: true };
      },
    );
    app.post('/api/journey-waits/:waitId/cancel', { schema: { params: WaitId } }, async (req) => {
      await cancelWaitCmd(ctx, await member(req), req.params.waitId);
      return { ok: true };
    });
    app.post('/api/journey-waits/:waitId/resend-link', { schema: { params: WaitId } }, async (req) => {
      await resendLinkCmd(ctx, await member(req), req.params.waitId);
      return { ok: true };
    });
    app.post(
      '/api/journey-gates/:waitId/decide',
      {
        schema: {
          params: WaitId,
          body: z
            .object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(2000).optional() })
            .strict(),
        },
      },
      async (req) => {
        await decideGate(ctx, await member(req), req.params.waitId, req.body.decision, req.body.note);
        return { ok: true };
      },
    );

    const Hook = z.object({ id: z.uuid(), hookId: z.uuid() });
    app.get('/api/journeys/:id/hooks', { schema: { params: Id } }, async (req) =>
      listTriggers(ctx, await member(req), req.params.id),
    );
    app.post(
      '/api/journeys/:id/hooks',
      {
        schema: {
          params: Id,
          body: z
            .object({
              name: z.string().min(1).max(120),
              purpose: z.enum(['start', 'resume']),
              scheme: z.enum(['guildwise', 'body_sha256']).optional(),
              mapping: HookMappingSchema,
              onNoMatch: z.enum(['create', 'refuse']).optional(),
            })
            .strict(),
        },
      },
      async (req, reply) => {
        const out = await createTrigger(ctx, await member(req), req.params.id, req.body);
        reply.code(201);
        return out;
      },
    );
    app.patch(
      '/api/journeys/:id/hooks/:hookId',
      {
        schema: {
          params: Hook,
          body: z
            .object({
              name: z.string().min(1).max(120).optional(),
              scheme: z.enum(['guildwise', 'body_sha256']).optional(),
              mapping: HookMappingSchema.optional(),
              onNoMatch: z.enum(['create', 'refuse']).optional(),
              enabled: z.literal(false).optional(),
            })
            .strict(),
        },
      },
      async (req) => {
        await updateTrigger(ctx, await member(req), req.params.id, req.params.hookId, req.body);
        return { ok: true };
      },
    );
    app.post('/api/journeys/:id/hooks/:hookId/rotate', { schema: { params: Hook } }, async (req) =>
      rotateTrigger(ctx, await member(req), req.params.id, req.params.hookId),
    );
  };
}
