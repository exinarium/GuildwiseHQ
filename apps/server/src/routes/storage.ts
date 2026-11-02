import {
  StorageAuthBodySchema,
  StorageConnectBodySchema,
  StorageConnectionCreateSchema,
  StorageConnectionRenameSchema,
  StorageTestBodySchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import {
  cancelStorageAuth,
  createStorageConnection,
  getStorageRequest,
  listStorageConnections,
  removeStorageConnection,
  renameStorageConnection,
  requestStorageAuth,
  requestStorageConnect,
  requestStorageTest,
} from '../commands/storage-connections.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const IdParams = z.object({ id: z.uuid() });
const SessionParams = z.object({ id: z.uuid(), sid: z.uuid() });
const RequestParams = z.object({ rid: z.string().min(1).max(64) });

/**
 * Storage connections of an organization (docs/investigations/GWP-63 section 4.4). Any member reads the list (the forms
 * builder needs it); the Owner and Admins manage connections. Connect, sign-in and test run on the user's own
 * workstation. No answer ever holds a token, key, path or file content.
 */
export function storageRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/org/storage/connections', async (req) => {
      const a = await requireOrg(ctx, req);
      return { connections: await listStorageConnections(ctx, a.orgId, a.session.user.id) };
    });

    app.post('/api/org/storage/connections', { schema: { body: StorageConnectionCreateSchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      const connection = await createStorageConnection(ctx, a.session.user, a.orgId, req.body);
      reply.code(201);
      return { connection };
    });

    app.patch(
      '/api/org/storage/connections/:id',
      { schema: { params: IdParams, body: StorageConnectionRenameSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await renameStorageConnection(ctx, a.session.user.id, a.orgId, req.params.id, req.body.label);
        return { ok: true };
      },
    );

    app.delete('/api/org/storage/connections/:id', { schema: { params: IdParams } }, async (req, reply) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await removeStorageConnection(ctx, a.session.user.id, a.orgId, req.params.id);
      reply.code(204);
    });

    app.post(
      '/api/org/storage/connections/:id/connect',
      { schema: { params: IdParams, body: StorageConnectBodySchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        const out = await requestStorageConnect(ctx, a.session.user, a.orgId, req.params.id, req.body);
        reply.code(202);
        return out;
      },
    );

    app.post(
      '/api/org/storage/connections/:id/auth',
      { schema: { params: IdParams, body: StorageAuthBodySchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        const out = await requestStorageAuth(ctx, a.session.user, a.orgId, req.params.id, req.body);
        reply.code(202);
        return out;
      },
    );

    app.post(
      '/api/org/storage/connections/:id/auth/:sid/cancel',
      { schema: { params: SessionParams } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await cancelStorageAuth(ctx, a.session.user, a.orgId, req.params.id, req.params.sid);
        return { ok: true };
      },
    );

    app.post(
      '/api/org/storage/connections/:id/test',
      { schema: { params: IdParams, body: StorageTestBodySchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        const out = await requestStorageTest(ctx, a.session.user, a.orgId, req.params.id, req.body.requestId);
        reply.code(202);
        return out;
      },
    );

    app.get('/api/org/storage/requests/:rid', { schema: { params: RequestParams } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return { request: await getStorageRequest(ctx, a.session.user.id, req.params.rid) };
    });
  };
}
