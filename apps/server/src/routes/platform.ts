import {
  AddPlatformBlockRequestSchema,
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
  SetRunnerUpdateSettingsRequestSchema,
  SetSimulationRequestSchema,
  WipeSimulationRequestSchema,
  WipeSimulationResponseSchema,
} from '@aom/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireSuperAdmin } from '../auth/guards.ts';
import { requireStepUp } from '../auth/step-up.ts';
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
  setOrgStatus,
} from '../commands/platform.ts';
import { addBlock, listBlocklist, removeBlock } from '../commands/platform-blocklist.ts';
import { requestPlatformTransfer } from '../commands/platform-transfer.ts';
import { devopsAuditCounts, listRunnerErrorSummaries } from '../commands/runner-telemetry.ts';
import { assertCreatedAsSimulation, setOrgSimulation, wipeSimulationOrg } from '../commands/simulation.ts';
import type { Ctx } from '../context.ts';
import { runnerUpdateSettings, setRunnerUpdatesPaused } from '../installer/release.ts';
import { loadDemoScenario } from '../simulation/demo.ts';
import { typed } from './util.ts';

const meta = (req: FastifyRequest) => ({
  ip: req.ip,
  userAgent: String(req.headers['user-agent'] ?? '').slice(0, 400),
});

/**
 * The platform area (docs/design/organizations.md section 10): super admin only (404 for everyone else). It shows
 * organization metadata and accounts; there is no route here that reads an organization's work (R17). There is no
 * two-factor reset (users recover by email: `routes/two-factor-recovery.ts`).
 */
export function platformRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    // What the runners report about themselves, as the platform may see it (R17-4): signatures, versions, counts and
    // checked stack frames; no message, stack or context. The detail stays with the platform team's bug intake.
    app.get('/api/platform/runner-errors', async (req) => {
      await requireSuperAdmin(ctx, req);
      const limit = Number((req.query as { limit?: string }).limit ?? 100);
      return { errors: await listRunnerErrorSummaries(ctx, Number.isFinite(limit) ? limit : 100) };
    });
    // DevOps commands: counts per runner version and platform only. The commands themselves are for the organization's
    // Owner and the workstation's owner (`routes/devops-audit.ts`).
    app.get('/api/platform/devops-audit', async (req) => {
      await requireSuperAdmin(ctx, req);
      return { counts: await devopsAuditCounts(ctx) };
    });

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
      await assertCreatedAsSimulation(ctx.pool, req.params.id);
      return DemoScenarioResponseSchema.parse(await loadDemoScenario(ctx, fastify, req.params.id));
    });

    // A support case: asks the Owner to hand the organization to one of its Admins (R17-3). It takes effect when the
    // Owner approves, or after a 7-day notice the Owner can veto (never by itself with deploy targets).
    app.post(
      '/api/platform/orgs/:id/transfer-ownership',
      { schema: { params: IdParamsSchema, body: PlatformTransferOwnershipRequestSchema } },
      async (req, reply) => {
        const s = await requireSuperAdmin(ctx, req);
        await requestPlatformTransfer(ctx, s, req.params.id, req.body.toUserId, req.body.reason);
        reply.code(202);
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
      '/api/platform/users/:id/send-password-reset',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return PasswordResetSentSchema.parse(
          await sendPasswordResetAsAdmin(ctx, s, req.params.id, meta(req)),
        );
      },
    );

    // The kill switch for runner auto-updates: while paused, `GET /api/runner/release` tells runners to stay put.
    app.get('/api/platform/runner-updates', async (req) => {
      await requireSuperAdmin(ctx, req);
      return runnerUpdateSettings(ctx);
    });

    app.put(
      '/api/platform/runner-updates',
      { schema: { body: SetRunnerUpdateSettingsRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        await setRunnerUpdatesPaused(ctx, req.body.paused, s.user.id);
        return runnerUpdateSettings(ctx);
      },
    );

    // The owner's block list (R1): domains, addresses, IPs or ranges, and allowed domains. Changes need a fresh step-up.
    app.get('/api/platform/blocklist', async (req) => {
      await requireSuperAdmin(ctx, req);
      return { entries: await listBlocklist(ctx) };
    });

    app.post(
      '/api/platform/blocklist',
      { schema: { body: AddPlatformBlockRequestSchema } },
      async (req, reply) => {
        const s = await requireSuperAdmin(ctx, req);
        requireStepUp(ctx, s);
        const entries = await addBlock(ctx, s, req.body, meta(req));
        reply.code(201);
        return { entries };
      },
    );

    app.delete('/api/platform/blocklist/:id', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      requireStepUp(ctx, s);
      return { entries: await removeBlock(ctx, s, req.params.id, meta(req)) };
    });

    app.get('/api/platform/audit', { schema: { querystring: PlatformAuditQuerySchema } }, async (req) => {
      await requireSuperAdmin(ctx, req);
      return auditLog(ctx, req.query);
    });
  };
}
