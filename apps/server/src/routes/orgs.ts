import {
  CreateOrgInvitationRequestSchema,
  IdParamsSchema,
  type OrgDetailResponse,
  OrgMemberParamsSchema,
  type OrgsResponse,
  PatchOrgMemberRequestSchema,
  PatchOrgRequestSchema,
  SetMemberProjectsRequestSchema,
  SwitchOrgRequestSchema,
  TransferOwnershipRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg, requireUser } from '../auth/guards.ts';
import { membershipsOf, rememberActiveOrg } from '../auth/org-context.ts';
import {
  changeMemberRole,
  inviteOrgMember,
  leaveOrg,
  listGuests,
  listMembers,
  listOrgInvitations,
  removalPreview,
  removeOrgMember,
  renameOrg,
  resendOrgInvitation,
  resetMemberPassword,
  resetMemberTwoFactor,
  revokeOrgInvitation,
  setDiagnosticsSharing,
  setMemberProjects,
  setRequireTwoFactor,
  transferOwnership,
} from '../commands/orgs.ts';
import type { Ctx } from '../context.ts';
import { iso, one } from '../db/sql.ts';
import { HttpError } from '../errors.ts';
import { activeOrgDto } from '../orgs/summary.ts';
import { buildMe, guestOrgs } from '../queries/me.ts';
import { typed } from './util.ts';

/** Organization routes (docs/design/organizations.md section 10). All take the request org (`X-AOM-Org`). */
export function orgRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    /** Memberships (suspended ones flagged by `status`) and the organizations where the user is a guest. */
    app.get('/api/orgs', async (req): Promise<OrgsResponse> => {
      const s = await requireUser(ctx, req);
      const mine = await membershipsOf(ctx.pool, s.user.id);
      return {
        orgs: mine.map((m) => ({ id: m.org_id, name: m.name, role: m.role, status: m.status })),
        guestIn: await guestOrgs(ctx, s.user.id),
      };
    });

    /** Remembers the org as this session's default (the tab keeps its own in sessionStorage) and returns `me`. */
    app.post('/api/orgs/active', { schema: { body: SwitchOrgRequestSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const mine = await membershipsOf(ctx.pool, s.user.id);
      if (!mine.some((m) => m.org_id === req.body.orgId))
        throw new HttpError(403, 'org_forbidden', 'you are not a member of that organization');
      await rememberActiveOrg(ctx, s, req.body.orgId);
      return buildMe(ctx, { ...s, activeOrgId: req.body.orgId }, req.body.orgId);
    });

    /** The organization of this request: any member (limits and usage for the Owner and Admins only). */
    app.get('/api/org', async (req): Promise<OrgDetailResponse> => {
      const a = await requireOrg(ctx, req);
      const owner = await one<{ id: string; display_name: string; email: string }>(
        ctx.pool,
        'SELECT id, display_name, email FROM users WHERE id=$1',
        [a.org.owner_user_id],
      );
      return {
        ...(await activeOrgDto(ctx, a.org, a.role)),
        owner: {
          id: owner?.id ?? a.org.owner_user_id,
          displayName: owner?.display_name ?? '',
          email: owner?.email ?? '',
        },
        createdAt: iso(a.org.created_at) as string,
      };
    });

    /** Rename and the two-factor policy: the Owner and Admins rename; only the Owner changes the policy. */
    app.patch('/api/org', { schema: { body: PatchOrgRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      if (req.body.name !== undefined) await renameOrg(ctx, a, req.body.name);
      if (req.body.requireTwoFactor !== undefined)
        await setRequireTwoFactor(ctx, a, req.body.requireTwoFactor);
      if (req.body.diagnosticsSharing !== undefined)
        await setDiagnosticsSharing(ctx, a, req.body.diagnosticsSharing, req.body.consentVersion);
      const fresh = await requireOrg(ctx, req, { min: 'admin' });
      const owner = await one<{ id: string; display_name: string; email: string }>(
        ctx.pool,
        'SELECT id, display_name, email FROM users WHERE id=$1',
        [fresh.org.owner_user_id],
      );
      return {
        ...(await activeOrgDto(ctx, fresh.org, fresh.role)),
        owner: {
          id: owner?.id ?? fresh.org.owner_user_id,
          displayName: owner?.display_name ?? '',
          email: owner?.email ?? '',
        },
        createdAt: iso(fresh.org.created_at) as string,
      } satisfies OrgDetailResponse;
    });

    app.get('/api/org/members', async (req) => {
      const a = await requireOrg(ctx, req);
      return { members: await listMembers(ctx, a.orgId) };
    });

    app.patch(
      '/api/org/members/:userId',
      { schema: { params: OrgMemberParamsSchema, body: PatchOrgMemberRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'owner' });
        await changeMemberRole(ctx, a, req.params.userId, req.body.role);
        return { members: await listMembers(ctx, a.orgId) };
      },
    );

    app.put(
      '/api/org/members/:userId/projects',
      { schema: { params: OrgMemberParamsSchema, body: SetMemberProjectsRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await setMemberProjects(ctx, a, req.params.userId, req.body.projectIds);
        return { members: await listMembers(ctx, a.orgId) };
      },
    );

    app.get(
      '/api/org/members/:userId/removal-preview',
      { schema: { params: OrgMemberParamsSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        return removalPreview(ctx, a, req.params.userId);
      },
    );

    // `/api/org/members/me` leaves the organization (anyone but the Owner).
    app.delete('/api/org/members/me', async (req) => {
      const a = await requireOrg(ctx, req);
      await leaveOrg(ctx, a);
      return { ok: true };
    });

    app.delete('/api/org/members/:userId', { schema: { params: OrgMemberParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await removeOrgMember(ctx, a, req.params.userId);
      return { members: await listMembers(ctx, a.orgId) };
    });

    app.post(
      '/api/org/members/:userId/reset-two-factor',
      { schema: { params: OrgMemberParamsSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'owner' });
        await resetMemberTwoFactor(ctx, a, req.params.userId);
        return { ok: true };
      },
    );

    // The temporary password is in this response only; it is not stored, logged or mailed.
    app.post(
      '/api/org/members/:userId/reset-password',
      {
        schema: { params: OrgMemberParamsSchema },
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        reply.header('Cache-Control', 'no-store');
        return resetMemberPassword(ctx, a, req.params.userId);
      },
    );

    app.post(
      '/api/org/transfer-ownership',
      { schema: { body: TransferOwnershipRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'owner' });
        await transferOwnership(ctx, a, req.body.userId, req.body.password);
        return { ok: true };
      },
    );

    app.get('/api/org/invitations', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return { invitations: await listOrgInvitations(ctx, a.orgId) };
    });

    app.post(
      '/api/org/invitations',
      { schema: { body: CreateOrgInvitationRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await inviteOrgMember(ctx, a, req.body);
        reply.code(201);
        return { invitations: await listOrgInvitations(ctx, a.orgId) };
      },
    );

    app.post('/api/org/invitations/:id/resend', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await resendOrgInvitation(ctx, a, req.params.id);
      return { invitations: await listOrgInvitations(ctx, a.orgId) };
    });

    app.post('/api/org/invitations/:id/revoke', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await revokeOrgInvitation(ctx, a, req.params.id);
      return { invitations: await listOrgInvitations(ctx, a.orgId) };
    });

    app.get('/api/org/guests', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return { guests: await listGuests(ctx, a.orgId) };
    });
  };
}
