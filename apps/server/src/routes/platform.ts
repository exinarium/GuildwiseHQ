import {
  DemoScenarioResponseSchema,
  IdParamsSchema,
  NewOrgInvitationRequestSchema,
  OrgStatusActionRequestSchema,
  PasswordResetSentSchema,
  PatchPlatformOrgRequestSchema,
  PatchPlatformUserRequestSchema,
  PlatformAuditQuerySchema,
  PlatformOrgsQuerySchema,
  PlatformTransferOwnershipRequestSchema,
  SetSimulationRequestSchema,
  WipeSimulationRequestSchema,
  WipeSimulationResponseSchema,
} from '@aom/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireSuperAdmin } from '../auth/guards.ts';
import {
  getPlatformInvitation,
  inviteNewOrg,
  listPlatformInvitations,
  resendNewOrgInvitation,
  revokeNewOrgInvitation,
} from '../commands/invitations.ts';
import { sendPasswordResetAsAdmin } from '../commands/password-reset.ts';
import {
  auditLog,
  getPlatformOrg,
  listPlatformOrgs,
  listPlatformUsers,
  patchPlatformOrg,
  patchPlatformUser,
  platformTransferOwnership,
  resetUserTwoFactor,
  setOrgStatus,
} from '../commands/platform.ts';
import { setOrgSimulation, wipeSimulationOrg } from '../commands/simulation.ts';
import type { Ctx } from '../context.ts';
import { loadDemoScenario } from '../simulation/demo.ts';
import { typed } from './util.ts';

const meta = (req: FastifyRequest) => ({
  ip: req.ip,
  userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400),
});

/**
 * The platform area (docs/design/organizations.md section 10): super admin only (404 for everyone else). It shows
 * organization metadata and accounts; there is no route here that reads an organization's work.
 */
export function platformRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/platform/orgs', { schema: { querystring: PlatformOrgsQuerySchema } }, async (req) => {
      await requireSuperAdmin(ctx, req);
      return { orgs: await listPlatformOrgs(ctx, req.query) };
    });

    app.get('/api/platform/orgs/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      return getPlatformOrg(ctx, s, req.params.id, meta(req));
    });

    app.patch(
      '/api/platform/orgs/:id',
      { schema: { params: IdParamsSchema, body: PatchPlatformOrgRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        await patchPlatformOrg(ctx, s, req.params.id, req.body, meta(req));
        return getPlatformOrg(ctx, s, req.params.id, meta(req));
      },
    );

    for (const action of ['suspend', 'reactivate', 'cancel'] as const) {
      app.post(
        `/api/platform/orgs/:id/${action}`,
        { schema: { params: IdParamsSchema, body: OrgStatusActionRequestSchema } },
        async (req) => {
          const s = await requireSuperAdmin(ctx, req);
          await setOrgStatus(ctx, s, req.params.id, action, req.body, meta(req));
          return getPlatformOrg(ctx, s, req.params.id, meta(req));
        },
      );
    }

    app.put(
      '/api/platform/orgs/:id/simulation',
      { schema: { params: IdParamsSchema, body: SetSimulationRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        await setOrgSimulation(ctx, s, req.params.id, req.body, meta(req));
        return getPlatformOrg(ctx, s, req.params.id, meta(req));
      },
    );

    // Wipes a simulation organization with all its data (events included); the name must be typed back.
    app.post(
      '/api/platform/orgs/:id/wipe-simulation',
      { schema: { params: IdParamsSchema, body: WipeSimulationRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return WipeSimulationResponseSchema.parse(
          await wipeSimulationOrg(ctx, s, req.params.id, req.body, meta(req)),
        );
      },
    );

    // Adds the missing parts of a busy demo company to a simulation organization (add-only, safe to repeat).
    app.post('/api/platform/orgs/:id/demo-scenario', { schema: { params: IdParamsSchema } }, async (req) => {
      await requireSuperAdmin(ctx, req);
      return DemoScenarioResponseSchema.parse(await loadDemoScenario(ctx, fastify, req.params.id));
    });

    app.post(
      '/api/platform/orgs/:id/transfer-ownership',
      { schema: { params: IdParamsSchema, body: PlatformTransferOwnershipRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        await platformTransferOwnership(ctx, s, req.params.id, req.body.toUserId, req.body.reason, meta(req));
        return getPlatformOrg(ctx, s, req.params.id, meta(req));
      },
    );

    app.get('/api/platform/invitations', async (req) => {
      await requireSuperAdmin(ctx, req);
      return { invitations: await listPlatformInvitations(ctx) };
    });

    app.post(
      '/api/platform/invitations',
      { schema: { body: NewOrgInvitationRequestSchema } },
      async (req, reply) => {
        const s = await requireSuperAdmin(ctx, req);
        const id = await inviteNewOrg(ctx, s, req.body, meta(req));
        reply.code(201);
        return getPlatformInvitation(ctx, id);
      },
    );

    app.post('/api/platform/invitations/:id/resend', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      await resendNewOrgInvitation(ctx, s, req.params.id, meta(req));
      return getPlatformInvitation(ctx, req.params.id);
    });

    app.post('/api/platform/invitations/:id/revoke', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      await revokeNewOrgInvitation(ctx, s, req.params.id);
      return getPlatformInvitation(ctx, req.params.id);
    });

    app.get(
      '/api/platform/users',
      { schema: { querystring: z.object({ q: z.string().max(200).optional() }) } },
      async (req) => {
        await requireSuperAdmin(ctx, req);
        return { users: await listPlatformUsers(ctx, req.query.q) };
      },
    );

    app.patch(
      '/api/platform/users/:id',
      { schema: { params: IdParamsSchema, body: PatchPlatformUserRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        await patchPlatformUser(ctx, s, req.params.id, req.body.status, meta(req));
        return { users: (await listPlatformUsers(ctx)).filter((u) => u.id === req.params.id) };
      },
    );

    app.post(
      '/api/platform/users/:id/reset-two-factor',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        await resetUserTwoFactor(ctx, s, req.params.id, meta(req));
        return { ok: true };
      },
    );

    app.post(
      '/api/platform/users/:id/send-password-reset',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return PasswordResetSentSchema.parse(
          await sendPasswordResetAsAdmin(ctx, s, req.params.id, meta(req)),
        );
      },
    );

    app.get('/api/platform/audit', { schema: { querystring: PlatformAuditQuerySchema } }, async (req) => {
      await requireSuperAdmin(ctx, req);
      return auditLog(ctx, req.query);
    });
  };
}
