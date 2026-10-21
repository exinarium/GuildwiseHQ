import {
  BacklogFilter,
  CreateBacklogItemRequest,
  PatchBacklogItemRequest,
  SendBacklogRequest,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import {
  addBacklogItem,
  dropBacklogItem,
  editBacklogItem,
  listBacklog,
  sendBacklogItem,
  sendBacklogItems,
} from '../commands/backlog.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

const ProjectParams = z.object({ id: z.uuid() });
const ItemParams = z.object({ itemId: z.uuid() });

/** Project backlog: wanted work outside development. The filter and sort run here only; the web and the CLI show the result. */
export function backlogRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get(
      '/api/projects/:id/backlog',
      { schema: { params: ProjectParams, querystring: BacklogFilter } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return listBacklog(ctx, s.user, { projectId: req.params.id }, req.query);
      },
    );

    app.post(
      '/api/projects/:id/backlog',
      { schema: { params: ProjectParams, body: CreateBacklogItemRequest } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const item = await addBacklogItem(ctx, s.user, req.params.id, req.body);
        reply.code(201);
        return { item };
      },
    );

    app.patch(
      '/api/backlog/:itemId',
      { schema: { params: ItemParams, body: PatchBacklogItemRequest } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return { item: await editBacklogItem(ctx, s.user, req.params.itemId, req.body) };
      },
    );

    app.post('/api/backlog/:itemId/drop', { schema: { params: ItemParams } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { item: await dropBacklogItem(ctx, s.user, req.params.itemId) };
    });

    app.post('/api/backlog/:itemId/send', { schema: { params: ItemParams } }, async (req) => {
      const s = await requireUser(ctx, req);
      return sendBacklogItem(ctx, s.user, req.params.itemId);
    });

    app.post('/api/backlog/send', { schema: { body: SendBacklogRequest } }, async (req) => {
      const s = await requireUser(ctx, req);
      return { results: await sendBacklogItems(ctx, s.user, req.body.itemIds) };
    });
  };
}
