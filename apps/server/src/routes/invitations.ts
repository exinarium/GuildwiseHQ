import {
  AcceptExistingInvitationRequestSchema,
  AcceptInvitationRequestSchema,
  InvitationTokenParamsSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/guards.ts';
import { createSession } from '../auth/sessions.ts';
import { setDigestPreference } from '../commands/blog-digest.ts';
import { acceptInvitation, acceptInvitationExisting, invitationInfo } from '../commands/invitations.ts';
import type { Ctx } from '../context.ts';
import { meResponse, setSessionCookie } from './auth.ts';
import { typed } from './util.ts';

/** Public invitation routes (the token is the credential): the three kinds share one flow (section 8.1). */
export function invitationRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/invitations/:token', { schema: { params: InvitationTokenParamsSchema } }, async (req) =>
      invitationInfo(ctx, req.params.token),
    );

    // A new account: name and password (and the organization name for a new organization). Sets the session cookie.
    app.post(
      '/api/invitations/:token/accept',
      {
        schema: { params: InvitationTokenParamsSchema, body: AcceptInvitationRequestSchema },
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const userId = await acceptInvitation(ctx, req.params.token, req.body);
        if (req.body.blogDigest !== undefined)
          await setDigestPreference(ctx, userId, req.body.blogDigest, 'invite');
        const s = await createSession(ctx, userId, { userAgent: req.headers['user-agent'], ip: req.ip });
        setSessionCookie(ctx, reply, s.token, s.maxAgeSec);
        reply.code(201);
        return meResponse(ctx, userId);
      },
    );

    // An existing account, signed in with the invited email: join (or start) the organization.
    app.post(
      '/api/invitations/:token/accept-existing',
      {
        schema: { params: InvitationTokenParamsSchema, body: AcceptExistingInvitationRequestSchema },
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const s = await requireSession(ctx, req);
        const orgId = await acceptInvitationExisting(ctx, s, req.params.token, req.body);
        if (req.body.blogDigest !== undefined)
          await setDigestPreference(ctx, s.user.id, req.body.blogDigest, 'invite');
        reply.code(201);
        return meResponse(ctx, s.user.id, orgId);
      },
    );
  };
}
