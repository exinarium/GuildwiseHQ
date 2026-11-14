import { AddOrgAppRequestSchema, RenameOrgAppRequestSchema, ShareOrgAppRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import {
  addOrgApp,
  listOrgApps,
  readOrgAppRequest,
  removeOrgApp,
  renameOrgApp,
  shareOrgApp,
  testOrgApp,
  unshareOrgApp,
} from '../commands/org-apps.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const IdParams = z.object({ id: z.uuid() });

/**
 * Automated apps of the organization (Settings > Automated apps). Every member may read; every change is the Owner's only
 * (checked in the commands). Bodies carry sealed envelopes, never a key: a body holding a PEM in the clear is refused by the
 * JSON parser before it reaches a route or a log line.
 */
export function orgAppRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/org/apps', async (req) => {
      const a = await requireOrg(ctx, req);
      return listOrgApps(ctx, a.session.user, a.orgId);
    });

    app.post('/api/org/apps', { schema: { body: AddOrgAppRequestSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      const r = await addOrgApp(ctx, a.session.user, a.orgId, req.body);
      reply.code(202);
      return r;
    });

    app.get(
      '/api/org/apps/requests/:rid',
      { schema: { params: z.object({ rid: z.uuid() }) } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        return readOrgAppRequest(ctx, a.session.user, a.orgId, req.params.rid);
      },
    );

    app.patch(
      '/api/org/apps/:id',
      { schema: { params: IdParams, body: RenameOrgAppRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req);
        await renameOrgApp(ctx, a.session.user, a.orgId, req.params.id, req.body.label);
        return { ok: true };
      },
    );

    app.post(
      '/api/org/apps/:id/shares',
      { schema: { params: IdParams, body: ShareOrgAppRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        const r = await shareOrgApp(ctx, a.session.user, a.orgId, req.params.id, req.body);
        reply.code(202);
        return r;
      },
    );

    app.post(
      '/api/org/apps/:id/test',
      { schema: { params: IdParams, querystring: z.object({ workstationId: z.uuid().optional() }) } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        const r = await testOrgApp(ctx, a.session.user, a.orgId, req.params.id, req.query.workstationId);
        reply.code(202);
        return r;
      },
    );

    app.delete(
      '/api/org/apps/:id/workstations/:wsId',
      { schema: { params: z.object({ id: z.uuid(), wsId: z.uuid() }) } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req);
        await unshareOrgApp(ctx, a.session.user, a.orgId, req.params.id, req.params.wsId);
        reply.code(202);
        return { queued: true };
      },
    );

    app.delete('/api/org/apps/:id', { schema: { params: IdParams } }, async (req, reply) => {
      const a = await requireOrg(ctx, req);
      await removeOrgApp(ctx, a.session.user, a.orgId, req.params.id);
      reply.code(202);
      return { queued: true };
    });
  };
}
