import {
  AcceptInvitationRequestSchema,
  type InvitationInfoResponse,
  InvitationTokenParamsSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { createSession } from '../auth/sessions.ts';
import { acceptInvitation, lookupInvitation } from '../commands/invitations.ts';
import type { Ctx } from '../context.ts';
import { iso } from '../db/sql.ts';
import { meResponse, setSessionCookie } from './auth.ts';
import { typed } from './util.ts';

export function invitationRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/invitations/:token', { schema: { params: InvitationTokenParamsSchema } }, async (req) => {
      const inv = await lookupInvitation(ctx, req.params.token);
      const out: InvitationInfoResponse = {
        email: inv.email,
        role: inv.role,
        expiresAt: iso(inv.expires_at) as string,
      };
      return out;
    });

    app.post(
      '/api/invitations/:token/accept',
      {
        schema: { params: InvitationTokenParamsSchema, body: AcceptInvitationRequestSchema },
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const userId = await acceptInvitation(ctx, req.params.token, req.body);
        const s = await createSession(ctx, userId, { userAgent: req.headers['user-agent'], ip: req.ip });
        setSessionCookie(ctx, reply, s.token, s.maxAgeSec);
        reply.code(201);
        return meResponse(ctx, userId);
      },
    );
  };
}
