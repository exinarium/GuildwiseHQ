import {
  CreateInvitationRequestSchema,
  IdParamsSchema,
  type InvitationDto,
  PatchUserRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../auth/guards.ts';
import { patchUser } from '../commands/admin.ts';
import { inviteUser, listInvitations, resendInvitation, revokeInvitation } from '../commands/invitations.ts';
import type { Ctx } from '../context.ts';
import { one, rows } from '../db/sql.ts';
import { toInvitationDto, toUserDto } from '../dto.ts';
import { notFound } from '../errors.ts';
import { typed } from './util.ts';

export function adminRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    const invitation = async (id: string): Promise<InvitationDto> => {
      const r = await one(ctx.pool, 'SELECT * FROM invitations WHERE id=$1', [id]);
      if (!r) throw notFound('invitation not found');
      return toInvitationDto(r);
    };

    app.get('/api/admin/users', async (req) => {
      await requireAdmin(ctx, req);
      const users = await rows(ctx.pool, 'SELECT * FROM users ORDER BY created_at');
      return { users: users.map(toUserDto) };
    });

    app.patch(
      '/api/admin/users/:id',
      { schema: { params: IdParamsSchema, body: PatchUserRequestSchema } },
      async (req) => {
        const admin = await requireAdmin(ctx, req);
        await patchUser(ctx, admin, req.params.id, req.body);
        const u = await one(ctx.pool, 'SELECT * FROM users WHERE id=$1', [req.params.id]);
        return toUserDto(u as Record<string, any>);
      },
    );

    app.get('/api/admin/invitations', async (req) => {
      await requireAdmin(ctx, req);
      return { invitations: (await listInvitations(ctx)).map(toInvitationDto) };
    });

    app.post(
      '/api/admin/invitations',
      { schema: { body: CreateInvitationRequestSchema } },
      async (req, reply) => {
        const admin = await requireAdmin(ctx, req);
        const id = await inviteUser(ctx, admin, req.body);
        reply.code(201);
        return invitation(id);
      },
    );

    app.post('/api/admin/invitations/:id/resend', { schema: { params: IdParamsSchema } }, async (req) => {
      const admin = await requireAdmin(ctx, req);
      await resendInvitation(ctx, admin, req.params.id);
      return invitation(req.params.id);
    });

    app.post('/api/admin/invitations/:id/revoke', { schema: { params: IdParamsSchema } }, async (req) => {
      const admin = await requireAdmin(ctx, req);
      await revokeInvitation(ctx, admin, req.params.id);
      return invitation(req.params.id);
    });
  };
}
