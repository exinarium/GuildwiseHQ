import {
  CreatePlatformPauseRequestSchema,
  DeployCheckRequestSchema,
  IdParamsSchema,
  RecordDeployRequestSchema,
  RequestGrantRequestSchema,
  ResumePlatformPauseRequestSchema,
  SetPlatformTeamRequestSchema,
  SetRunnerPinRequestSchema,
  TriageBugRequestSchema,
} from '@aom/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireSession, requireSuperAdmin, requireUser } from '../auth/guards.ts';
import type { Ctx } from '../context.ts';
import { rows } from '../db/sql.ts';
import { forbidden, notFound } from '../errors.ts';
import { checkDeploy, listDeployAudit, recordDeploy } from '../platform-team/deploy.ts';
import {
  grantAccessLog,
  listGrants,
  readExtendedDiagnostics,
  requestGrant,
  revokeGrant,
} from '../platform-team/grants.ts';
import { triageBug } from '../platform-team/intake.ts';
import { endPause, listPauses, pausesForUser, startPause } from '../platform-team/pause.ts';
import { listPins, setRunnerPin } from '../platform-team/pins.ts';
import { listBugs } from '../platform-team/queries.ts';
import {
  type PlatformAccess,
  platformAccessOf,
  platformTeamSettings,
  setPlatformTeam,
} from '../platform-team/settings.ts';
import { typed } from './util.ts';

const SignatureParams = z.object({ signature: z.string().min(1).max(200) });

/**
 * The platform team's routes (Lean Team v3). The super admin only DESIGNATES the team (`/api/platform/team`) and may read
 * and pause/pin; everything the team decides (approvals, reports) lives on the platform organisation's desk. Members of
 * the platform project read, the Owner and Admins of the platform organisation act. 404 for everyone else, like the
 * rest of the platform area.
 */
export function platformTeamRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    /** Super admin, or a member (read) / manager (write) of the platform organisation; 404 otherwise. */
    const access = async (req: FastifyRequest, write: boolean): Promise<PlatformAccess> => {
      const first = await requireSession(ctx, req).catch(() => {
        throw notFound();
      });
      const session =
        first.user.kind === 'super_admin' ? await requireSuperAdmin(ctx, req) : await requireUser(ctx, req);
      const a = await platformAccessOf(ctx, session);
      if (!a.team) throw notFound('no platform team is designated');
      if (a.superAdmin) return a;
      if (write ? !a.manager : !a.member) throw notFound();
      return a;
    };
    const actorLabel = (a: PlatformAccess): string => a.session.user.email ?? a.session.user.id;

    // ---------------------------------------------------------------- designation (super admin)
    app.get('/api/platform/team', async (req) => {
      await requireSuperAdmin(ctx, req);
      return platformTeamSettings(ctx);
    });
    app.put('/api/platform/team', { schema: { body: SetPlatformTeamRequestSchema } }, async (req) => {
      const s = await requireSuperAdmin(ctx, req);
      return setPlatformTeam(ctx, s, req.body);
    });

    // ---------------------------------------------------------------- overview and lists
    app.get('/api/platform-team/overview', async (req) => {
      const a = await access(req, false);
      return {
        team: await platformTeamSettings(ctx),
        canManage: a.manager || a.superAdmin,
        bugs: await listBugs(ctx, { limit: 50 }),
        pauses: await listPauses(ctx, { limit: 50 }),
        grants: await listGrants(ctx),
        pins: await listPins(ctx),
        audit: await listDeployAudit(ctx, 30),
      };
    });
    app.get('/api/platform-team/bugs', async (req) => {
      await access(req, false);
      return { bugs: await listBugs(ctx) };
    });
    app.get('/api/platform-team/pauses', async (req) => {
      await access(req, false);
      return { pauses: await listPauses(ctx) };
    });
    app.get('/api/platform-team/deploy-audit', async (req) => {
      await access(req, false);
      return { entries: await listDeployAudit(ctx, 200) };
    });

    // ---------------------------------------------------------------- pauses
    app.post(
      '/api/platform-team/pauses',
      { schema: { body: CreatePlatformPauseRequestSchema } },
      async (req) => {
        const a = await access(req, true);
        const b = req.body;
        if (!b.projectId && !b.workflowKey && !b.stageId && !b.workstationId)
          throw forbidden('a pause needs a project, workflow, stage or workstation');
        const r = await startPause(ctx, {
          scope: {
            projectId: b.projectId ?? null,
            workflowKey: b.workflowKey ?? null,
            stageId: b.stageId ?? null,
            workstationId: b.workstationId ?? null,
          },
          reason: b.reason,
          source: 'manual',
          ...(b.bugCardId ? { bugCardId: b.bugCardId } : {}),
          byUserId: a.session.user.id,
        });
        return { pauseId: r?.pauseId ?? null, created: r?.created ?? false };
      },
    );
    app.post(
      '/api/platform-team/pauses/:id/resume',
      { schema: { params: IdParamsSchema, body: ResumePlatformPauseRequestSchema } },
      async (req) => {
        const a = await access(req, true);
        const ended = await endPause(ctx, req.params.id, {
          by: 'manual',
          reason: req.body.reason ?? `Resumed by ${actorLabel(a)}`,
          byUserId: a.session.user.id,
        });
        if (!ended) throw notFound('pause not found or already ended');
        return { ok: true };
      },
    );
    // What the signed-in user feels: banner on their projects, badge on their workstations.
    app.get('/api/platform-team/my-pauses', async (req) => {
      const s = await requireUser(ctx, req);
      return { pauses: await pausesForUser(ctx, s.user.id) };
    });

    // ---------------------------------------------------------------- triage (a manager's override of the architect)
    app.post(
      '/api/platform-team/bugs/:id/triage',
      { schema: { params: IdParamsSchema, body: TriageBugRequestSchema } },
      async (req) => {
        const a = await access(req, true);
        return triageBug(ctx, { userId: a.session.user.id, label: actorLabel(a) }, req.params.id, req.body);
      },
    );

    // ---------------------------------------------------------------- grants
    app.post('/api/platform-team/grants', { schema: { body: RequestGrantRequestSchema } }, async (req) => {
      const a = await access(req, true);
      if (a.superAdmin) throw forbidden('the platform organization asks for grants, not the super admin');
      return requestGrant(ctx, a.session.user, req.body);
    });
    app.get(
      '/api/platform-team/bugs/:signature/extended',
      { schema: { params: SignatureParams } },
      async (req) => {
        const a = await access(req, false);
        if (a.superAdmin) throw forbidden('only the platform team reads granted diagnostics');
        return readExtendedDiagnostics(ctx, a.session.user, req.params.signature);
      },
    );
    // The client organization's side: its grants, and revoking one.
    app.get('/api/platform-team/client-grants', async (req) => {
      const s = await requireUser(ctx, req);
      const orgs = await rows<{ org_id: string }>(
        ctx.pool,
        `SELECT org_id FROM org_members WHERE user_id=$1 AND status='active' AND role IN ('owner','admin')`,
        [s.user.id],
      );
      const out = [];
      for (const o of orgs) out.push(...(await listGrants(ctx, { orgId: o.org_id })));
      return { grants: out };
    });
    app.post('/api/platform-team/grants/:id/revoke', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return revokeGrant(ctx, s.user, req.params.id);
    });
    app.get(
      '/api/platform-team/grants/:id/access-log',
      { schema: { params: IdParamsSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const g = (await listGrants(ctx)).find((x) => x.id === req.params.id);
        if (!g) throw notFound();
        const m = await rows(
          ctx.pool,
          `SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active' AND role IN ('owner','admin')`,
          [g.clientOrgId, s.user.id],
        );
        if (m.length === 0) throw notFound();
        return { entries: await grantAccessLog(ctx, g.id) };
      },
    );

    // ---------------------------------------------------------------- safe mode (runner version pin)
    app.get('/api/platform-team/runner-pins', async (req) => {
      await access(req, false);
      return { pins: await listPins(ctx) };
    });
    app.put('/api/platform-team/runner-pin', { schema: { body: SetRunnerPinRequestSchema } }, async (req) => {
      const a = await access(req, true);
      return setRunnerPin(ctx, a.session.user, req.body);
    });

    // ---------------------------------------------------------------- deploy policy (for a deploy script)
    // "Is this deploy allowed?" and "this deploy happened". Nothing here deploys anything.
    app.post(
      '/api/platform-team/deploy/check',
      { schema: { body: DeployCheckRequestSchema } },
      async (req) => {
        const a = await access(req, true);
        return checkDeploy(ctx, req.body, actorLabel(a));
      },
    );
    app.post(
      '/api/platform-team/deploy/record',
      { schema: { body: RecordDeployRequestSchema } },
      async (req) => {
        const a = await access(req, true);
        return recordDeploy(ctx, req.body, actorLabel(a));
      },
    );
  };
}
