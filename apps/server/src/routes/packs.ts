import {
  AcceptPackUpdateRequestSchema,
  AddPackRequestSchema,
  CheckPackRequestSchema,
  CreateMyPackRequestSchema,
  DecidePackAssignmentRequestSchema,
  GrantPackAgentRequestSchema,
  HireFromPackRequestSchema,
  PackScriptsRequestSchema,
  ReadMyPackRequestSchema,
  SaveMyPackRequestSchema,
  SetPackCredentialRequestSchema,
  SetPackVisibilityRequestSchema,
  SetPackWorkstationsRequestSchema,
  TrustPackRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import {
  createMyPack,
  getReadMyPack,
  grantPackAgent,
  listMyPacks,
  removeMyPack,
  saveMyPack,
  setMyPackVisibility,
  startReadMyPack,
  startReviewRead,
} from '../commands/pack-authoring.ts';
import {
  acceptRoleOffer,
  dismissRoleOffer,
  getHireStatus,
  getRoleReview,
  hireFromPack,
  listHirablePacks,
  listPackPersonas,
  listRoleOffers,
  startRoleReview,
} from '../commands/pack-hire.ts';
import { decideAssignment, listMyAssignments } from '../commands/pack-holders.ts';
import { getReviewWait, noteReviewWait } from '../commands/pack-review-wait.ts';
import {
  acceptPackUpdate,
  addPack,
  checkPack,
  getPack,
  listPacks,
  removePack,
  revokePack,
  setPackCredential,
  setPackScripts,
  setPackWorkstations,
  trustPack,
} from '../commands/packs.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const Params = z.object({ id: z.uuid() });

/** Capability packs: git import, trust review, update diffs (docs/ARCHITECTURE.md section 38.4). Owners and admins only. */
export function packRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const who = async (req: Parameters<typeof requireOrg>[1]) =>
      whoOf(await requireOrg(ctx, req, { min: 'admin' }));

    app.get('/api/packs', async (req) => listPacks(ctx, await who(req)));
    app.post('/api/packs', { schema: { body: AddPackRequestSchema } }, async (req, reply) => {
      reply.code(201);
      return { pack: await addPack(ctx, await who(req), req.body) };
    });
    app.get('/api/packs/:id', { schema: { params: Params } }, async (req) => ({
      pack: await getPack(ctx, await who(req), req.params.id),
    }));
    app.post(
      '/api/packs/:id/check',
      { schema: { params: Params, body: CheckPackRequestSchema } },
      async (req, reply) => {
        reply.code(202);
        return checkPack(ctx, await who(req), req.params.id, req.body.ref);
      },
    );
    app.post(
      '/api/packs/:id/accept-update',
      { schema: { params: Params, body: AcceptPackUpdateRequestSchema } },
      async (req) => ({ pack: await acceptPackUpdate(ctx, await who(req), req.params.id, req.body.sha) }),
    );
    app.post(
      '/api/packs/:id/trust',
      { schema: { params: Params, body: TrustPackRequestSchema } },
      async (req) => ({
        pack: await trustPack(ctx, await who(req), req.params.id, req.body),
      }),
    );
    app.post('/api/packs/:id/revoke', { schema: { params: Params } }, async (req) => ({
      pack: await revokePack(ctx, await who(req), req.params.id),
    }));
    app.post(
      '/api/packs/:id/scripts',
      { schema: { params: Params, body: PackScriptsRequestSchema } },
      async (req) => ({
        pack: await setPackScripts(ctx, await who(req), req.params.id, req.body.enabled),
      }),
    );
    app.delete('/api/packs/:id', { schema: { params: Params } }, async (req, reply) => {
      await removePack(ctx, await who(req), req.params.id);
      reply.code(204);
    });
    // R3a: who holds the pack (member opt-in) and the deploy key or token of a private repository (sealed in the browser)
    app.put(
      '/api/packs/:id/workstations',
      { schema: { params: Params, body: SetPackWorkstationsRequestSchema } },
      async (req) => ({ pack: await setPackWorkstations(ctx, await who(req), req.params.id, req.body) }),
    );
    app.put(
      '/api/packs/:id/credential',
      { schema: { params: Params, body: SetPackCredentialRequestSchema } },
      async (req) => ({ pack: await setPackCredential(ctx, await who(req), req.params.id, req.body) }),
    );

    // ---- any member --------------------------------------------------------------------------------------------
    const member = async (req: Parameters<typeof requireOrg>[1]) =>
      await requireOrg(ctx, req, { min: 'member' });
    // Q57: an Owner or Admin reads the text of an authored organization pack before approving it (sealed to their browser)
    app.post(
      '/api/packs/:id/review-read',
      { schema: { params: Params, body: ReadMyPackRequestSchema } },
      async (req, reply) => {
        reply.code(202);
        const w = await who(req);
        const started = await startReviewRead(ctx, w, req.params.id, req.body.replyKey);
        // Q67: the text exists only on the author's workstation, so an offline one means the review waits (and the reviewer is told
        // on their desk when it connects)
        return { ...started, wait: await noteReviewWait(ctx, w, req.params.id) };
      },
    );
    app.get('/api/packs/:id/review-wait', { schema: { params: Params } }, async (req) =>
      getReviewWait(ctx, await who(req), req.params.id),
    );
    app.get(
      '/api/packs/reads/:requestId',
      { schema: { params: z.object({ requestId: z.uuid() }) } },
      async (req) => getReadMyPack((await who(req)).userId, req.params.requestId),
    );
    // my capabilities: packs I authored (private to my workstation, or for the organization)
    app.get('/api/my-capabilities', async (req) => {
      const a = await member(req);
      return listMyPacks(ctx, a.session.user.id, a.orgId);
    });
    app.post('/api/my-capabilities', { schema: { body: CreateMyPackRequestSchema } }, async (req, reply) => {
      const a = await member(req);
      reply.code(201);
      return { pack: await createMyPack(ctx, a.session.user, a.orgId, req.body) };
    });
    app.post(
      '/api/my-capabilities/:id/save',
      { schema: { params: Params, body: SaveMyPackRequestSchema } },
      async (req, reply) => {
        const a = await member(req);
        reply.code(202);
        return saveMyPack(ctx, a.session.user.id, a.orgId, req.params.id, req.body);
      },
    );
    app.post(
      '/api/my-capabilities/:id/read',
      { schema: { params: Params, body: ReadMyPackRequestSchema } },
      async (req, reply) => {
        const a = await member(req);
        reply.code(202);
        return startReadMyPack(
          ctx,
          a.session.user.id,
          a.orgId,
          req.params.id,
          req.body.replyKey,
          req.body.withPinned,
        );
      },
    );
    app.get(
      '/api/my-capabilities/reads/:requestId',
      { schema: { params: z.object({ requestId: z.uuid() }) } },
      async (req) => {
        const a = await member(req);
        return getReadMyPack(a.session.user.id, req.params.requestId);
      },
    );
    app.put(
      '/api/my-capabilities/:id/visibility',
      { schema: { params: Params, body: SetPackVisibilityRequestSchema } },
      async (req, reply) => {
        const a = await member(req);
        await setMyPackVisibility(ctx, a.session.user.id, a.orgId, req.params.id, req.body.visibility);
        reply.code(204);
      },
    );
    app.put(
      '/api/my-capabilities/:id/agents',
      { schema: { params: Params, body: GrantPackAgentRequestSchema } },
      async (req, reply) => {
        const a = await member(req);
        await grantPackAgent(
          ctx,
          a.session.user.id,
          a.orgId,
          req.params.id,
          req.body.agentId,
          req.body.granted,
        );
        reply.code(204);
      },
    );
    app.delete('/api/my-capabilities/:id', { schema: { params: Params } }, async (req, reply) => {
      const a = await member(req);
      await removeMyPack(ctx, a.session.user.id, a.orgId, req.params.id);
      reply.code(204);
    });

    // member opt-in: a pack assigned to one of my workstations
    app.get('/api/pack-assignments', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'member' });
      return { items: await listMyAssignments(ctx, a.session.user.id) };
    });
    app.post(
      '/api/pack-assignments/:id/decide',
      { schema: { params: Params, body: DecidePackAssignmentRequestSchema } },
      async (req, reply) => {
        const a = await member(req);
        await decideAssignment(
          ctx,
          a.session.user.id,
          req.params.id,
          req.body.workstationId,
          req.body.accept,
        );
        reply.code(204);
      },
    );

    // hire from pack (any member: the HR page lists what they could hire from)
    app.get('/api/packs-hirable', async (req) => listHirablePacks(ctx, whoOf(await member(req))));
    app.get('/api/packs/:id/personas', { schema: { params: Params } }, async (req) =>
      listPackPersonas(ctx, whoOf(await member(req)), req.params.id),
    );
    app.post(
      '/api/packs/:id/hire',
      { schema: { params: Params, body: HireFromPackRequestSchema } },
      async (req, reply) => {
        const a = await member(req);
        reply.code(202);
        return hireFromPack(ctx, a.session.user, whoOf(a), req.params.id, req.body);
      },
    );
    app.get(
      '/api/pack-hires/:requestId',
      { schema: { params: z.object({ requestId: z.uuid() }) } },
      async (req) => getHireStatus(ctx, whoOf(await member(req)), req.params.requestId),
    );

    // a pack update changed a persona an agent was hired from: a new role version on offer (never applied by itself)
    app.get('/api/role-offers', async (req) => ({
      items: await listRoleOffers(ctx, whoOf(await member(req))),
    }));
    const RoleParams = z.object({ roleKey: z.string().min(1).max(80) });
    app.post('/api/role-offers/:roleKey/review', { schema: { params: RoleParams } }, async (req, reply) => {
      reply.code(202);
      return startRoleReview(ctx, whoOf(await member(req)), req.params.roleKey);
    });
    app.get(
      '/api/role-offers/:roleKey/review/:requestId',
      { schema: { params: RoleParams.extend({ requestId: z.uuid() }) } },
      async (req) => getRoleReview(ctx, whoOf(await member(req)), req.params.roleKey, req.params.requestId),
    );
    app.post(
      '/api/role-offers/:roleKey/accept',
      { schema: { params: RoleParams, body: z.object({ requestId: z.uuid() }) } },
      async (req) => {
        const a = await member(req);
        return acceptRoleOffer(ctx, a.session.user, whoOf(a), req.params.roleKey, req.body.requestId);
      },
    );
    app.post('/api/role-offers/:roleKey/dismiss', { schema: { params: RoleParams } }, async (req, reply) => {
      const a = await member(req);
      await dismissRoleOffer(ctx, a.session.user, whoOf(a), req.params.roleKey);
      reply.code(204);
    });
  };
}
