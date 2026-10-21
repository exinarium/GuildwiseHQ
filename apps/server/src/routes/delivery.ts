import {
  ApproveRecipeRequestSchema,
  ConnectRequestSchema,
  DeployRequestSchema,
  HostKeyScanRequestSchema,
  IdParamsSchema,
  KeyCreateRequestSchema,
  PrepareRequestSchema,
  PreviewSetupRequestSchema,
  ProbeRequestSchema,
  PublishSetupRequestSchema,
  RejectRecipeRequestSchema,
  ReleaseRequestSchema,
  RevokeKeyRequestSchema,
  SaveSetupDraftRequestSchema,
  SetDeliveryModeRequestSchema,
  SetDeploySecretRequestSchema,
  SetGateBindingRequestSchema,
  SetGatePresetRequestSchema,
  SetupDryRunRequestSchema,
  UseProposalRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg, requireUser } from '../auth/guards.ts';
import { orgRoleOf } from '../auth/org-context.ts';
import { loadVisibleProject } from '../authz/scope.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { removeGatePreset, setDeploySecret, setGateBinding, setGatePreset } from '../delivery/admin.ts';
import {
  connectBlockedReason,
  getOp,
  requestConnect,
  requestHostKeyScan,
  requestKey,
  requestPrepare,
  requestRevoke,
} from '../delivery/connect.ts';
import { listProbeDtos, requestProbe } from '../delivery/probes.ts';
import { deliverySettings, listBindings, listPresets, releaseQueue, toRunDto } from '../delivery/queries.ts';
import { approveRecipe, rejectRecipe, requestRecipeInspect, setDeliveryMode } from '../delivery/recipes.ts';
import { cancelRun, listDeployRuns, releaseFromQueue, requestDeployRun } from '../delivery/runs.ts';
import {
  getSetupState,
  previewSetup,
  publishSetup,
  requestSetupDryRun,
  saveSetupDraft,
  useDeployProposal,
} from '../delivery/setup.ts';
import { forbidden } from '../errors.ts';
import { typed } from './util.ts';

/**
 * Delivery recipes, gates, the release queue and the deploy runs (docs/design/ceo-front-door.md section 9). Approving a
 * recipe is the Owner's button; releasing is the Owner's or an Admin's; nothing here is reachable by relayed text.
 */
export function deliveryRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/projects/:id/delivery', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return deliverySettings(ctx, s.user, req.params.id);
    });

    app.put(
      '/api/projects/:id/delivery/mode',
      { schema: { params: IdParamsSchema, body: SetDeliveryModeRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setDeliveryMode(ctx, s.user, req.params.id, req.body.mode);
        return deliverySettings(ctx, s.user, req.params.id);
      },
    );

    /** "Check for changes": asks a workstation to read `delivery/` of the project vault again. */
    app.post(
      '/api/projects/:id/delivery/inspect',
      { schema: { params: IdParamsSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        await loadVisibleProject(ctx.pool, s.user.id, req.params.id);
        const r = await requestRecipeInspect(ctx, req.params.id);
        reply.code(202);
        return r;
      },
    );

    app.post(
      '/api/projects/:id/delivery/approve',
      { schema: { params: IdParamsSchema, body: ApproveRecipeRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await approveRecipe(ctx, s.user, req.params.id, req.body.hash);
        return deliverySettings(ctx, s.user, req.params.id);
      },
    );

    app.post(
      '/api/projects/:id/delivery/reject',
      { schema: { params: IdParamsSchema, body: RejectRecipeRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await rejectRecipe(ctx, s.user, req.params.id, req.body.hash, req.body.reason);
        return deliverySettings(ctx, s.user, req.params.id);
      },
    );

    // ------------------------------------------------------------------------------ the guided deploy setup
    app.get('/api/projects/:id/delivery/setup', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getSetupState(ctx, s.user, req.params.id);
    });

    app.put(
      '/api/projects/:id/delivery/setup',
      { schema: { params: IdParamsSchema, body: SaveSetupDraftRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await saveSetupDraft(ctx, s.user, req.params.id, req.body);
        return getSetupState(ctx, s.user, req.params.id);
      },
    );

    app.post(
      '/api/projects/:id/delivery/setup/preview',
      { schema: { params: IdParamsSchema, body: PreviewSetupRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return previewSetup(ctx, s.user, req.params.id, req.body);
      },
    );

    app.post(
      '/api/projects/:id/delivery/setup/publish',
      { schema: { params: IdParamsSchema, body: PublishSetupRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await publishSetup(ctx, s.user, req.params.id, req.body);
        reply.code(202);
        return r;
      },
    );

    /** "Try it without changing anything": a dry run of the saved version (the Owner's approval needs one). */
    app.post(
      '/api/projects/:id/delivery/setup/dry-run',
      { schema: { params: IdParamsSchema, body: SetupDryRunRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return requestSetupDryRun(ctx, s.user, req.params.id, req.body.env);
      },
    );

    app.post(
      '/api/projects/:id/delivery/setup/use-proposal',
      { schema: { params: IdParamsSchema, body: UseProposalRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await useDeployProposal(ctx, s.user, req.params.id, req.body.proposalId);
        return getSetupState(ctx, s.user, req.params.id);
      },
    );

    /** The read-only look at Docker here, the servers this computer can reach, or one server (a durable command). */
    app.post(
      '/api/projects/:id/delivery/probe',
      { schema: { params: IdParamsSchema, body: ProbeRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await requestProbe(ctx, s.user, req.params.id, req.body);
        reply.code(202);
        return r;
      },
    );

    // ------------------------------------------------------------------------------ guided connect (design v2)
    const OpParams = z.object({ id: z.uuid(), commandId: z.uuid() });
    const TargetParams = z.object({ id: z.uuid(), targetId: z.uuid() });

    /** The server's fingerprint, as seen from the chosen computer (nothing is trusted or written). */
    app.post(
      '/api/projects/:id/delivery/hostkey',
      { schema: { params: IdParamsSchema, body: HostKeyScanRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await requestHostKeyScan(ctx, s.user, req.params.id, req.body);
        reply.code(202);
        return r;
      },
    );

    /** This computer's dedicated key for a server (the panel's copy-paste text); the private key stays on the computer. */
    app.post(
      '/api/projects/:id/delivery/key',
      { schema: { params: IdParamsSchema, body: KeyCreateRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await requestKey(ctx, s.user, req.params.id, req.body);
        reply.code(202);
        return r;
      },
    );

    /** Connect: a password or key file (sealed in the browser), a pasted key, or an existing sign-in; then the test. */
    app.post(
      '/api/projects/:id/delivery/connect',
      { schema: { params: IdParamsSchema, body: ConnectRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await requestConnect(ctx, s.user, req.params.id, req.body);
        reply.code(202);
        return r;
      },
    );

    /** Removes one key that Guildwise added (by its fingerprint), signing in from the chosen computer. */
    app.post(
      '/api/projects/:id/delivery/targets/:targetId/revoke-key',
      { schema: { params: TargetParams, body: RevokeKeyRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await requestRevoke(ctx, s.user, req.params.id, req.params.targetId, req.body);
        reply.code(202);
        return r;
      },
    );

    /** Prepare a server (or a folder on a computer): the confirmed list of actions. */
    app.post(
      '/api/projects/:id/delivery/prepare',
      { schema: { params: IdParamsSchema, body: PrepareRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await requestPrepare(ctx, s.user, req.params.id, req.body);
        reply.code(202);
        return r;
      },
    );

    app.get('/api/projects/:id/delivery/ops/:commandId', { schema: { params: OpParams } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getOp(ctx, s.user, req.params.id, req.params.commandId);
    });

    /** "Check connection": can the computer that deploys this server sign in to it now? */
    app.post(
      '/api/projects/:id/delivery/targets/:targetId/check',
      { schema: { params: TargetParams } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const t = await one(
          ctx.pool,
          'SELECT workstation_id FROM deploy_targets WHERE id=$1 AND project_id=$2',
          [req.params.targetId, req.params.id],
        );
        const cheap = t?.workstation_id && (await connectBlockedReason(ctx.pool, t.workstation_id)) === null;
        const r = await requestProbe(ctx, s.user, req.params.id, {
          scope: cheap ? 'ssh_check' : 'ssh_target',
          targetId: req.params.targetId,
        });
        reply.code(202);
        return r;
      },
    );

    app.get('/api/projects/:id/delivery/probes', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const project = await loadVisibleProject(ctx.pool, s.user.id, req.params.id);
      return {
        probes: await listProbeDtos(ctx.pool, req.params.id, {
          userId: s.user.id,
          projectOwner: project.my_role === 'owner',
        }),
      };
    });

    /**
     * The Deploy button (and the fallback for a CEO whose `aom deploy run` call was blocked): the same server path, from the
     * Owner's or an Admin's session, with no model involved.
     */
    app.post(
      '/api/projects/:id/delivery/deploy',
      { schema: { params: IdParamsSchema, body: DeployRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        const project = await loadVisibleProject(ctx.pool, s.user.id, req.params.id);
        const role = await orgRoleOf(ctx.pool, s.user.id, project.org_id);
        if (role !== 'owner' && role !== 'admin') throw forbidden('only an Owner or an Admin deploys');
        return requestDeployRun(ctx, {
          projectId: project.id,
          env: req.body.env,
          commit: req.body.commit,
          targets: req.body.targets,
          trigger: 'request',
          requester: { kind: role, id: s.user.id, name: s.user.displayName, provenance: 'session' },
        });
      },
    );

    app.put(
      '/api/workstations/:id/deploy-secrets',
      { schema: { params: IdParamsSchema, body: SetDeploySecretRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        await setDeploySecret(ctx, s.user, req.params.id, req.body);
        reply.code(202);
        return { queued: true };
      },
    );

    // ------------------------------------------------------------------------------ the queue and the runs
    app.get('/api/delivery/queue', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return { items: await releaseQueue(ctx, a.orgId) };
    });

    app.post('/api/delivery/release', { schema: { body: ReleaseRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return releaseFromQueue(ctx, a.session.user, a.orgId, req.body.runIds);
    });

    app.post('/api/delivery/runs/:id/cancel', { schema: { params: IdParamsSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await cancelRun(ctx, a.session.user, a.orgId, req.params.id);
      return { ok: true };
    });

    app.get(
      '/api/delivery/runs',
      {
        schema: {
          querystring: z.object({
            projectId: z.uuid().optional(),
            limit: z.coerce.number().int().min(1).max(200).optional(),
          }),
        },
      },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        const list = await listDeployRuns(ctx.pool, {
          orgId: a.orgId,
          ...(req.query.projectId ? { projectId: req.query.projectId } : {}),
          limit: req.query.limit ?? 60,
        });
        return { runs: list.map(toRunDto) };
      },
    );

    // ------------------------------------------------------------------------------ gate presets and bindings
    app.get('/api/delivery/gates', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return {
        presets: await listPresets(ctx.pool, a.orgId),
        bindings: await listBindings(ctx.pool, a.orgId),
      };
    });

    app.put('/api/delivery/presets', { schema: { body: SetGatePresetRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await setGatePreset(ctx, a.session.user, a.orgId, req.body.name, req.body.gate);
      return {
        presets: await listPresets(ctx.pool, a.orgId),
        bindings: await listBindings(ctx.pool, a.orgId),
      };
    });

    app.delete(
      '/api/delivery/presets/:name',
      { schema: { params: z.object({ name: z.string().min(1).max(60) }) } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await removeGatePreset(ctx, a.session.user, a.orgId, req.params.name);
        return {
          presets: await listPresets(ctx.pool, a.orgId),
          bindings: await listBindings(ctx.pool, a.orgId),
        };
      },
    );

    app.put('/api/delivery/bindings', { schema: { body: SetGateBindingRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await setGateBinding(ctx, a.session.user, a.orgId, req.body);
      return {
        presets: await listPresets(ctx.pool, a.orgId),
        bindings: await listBindings(ctx.pool, a.orgId),
      };
    });
  };
}
