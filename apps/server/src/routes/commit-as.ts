import { IdParamsSchema, SetCommitAsRequestSchema, SetPostAsRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { getCommitAs, setCommitAs } from '../commands/commit-as.ts';
import { assertCanCheckPostAs, requestPostAsChecks, setPostAsApps } from '../commands/post-as.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** "Commit as" of a project (backlog #65). */
export function commitAsRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/projects/:id/commit-as', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return getCommitAs(ctx, s.user, req.params.id);
    });

    app.put(
      '/api/projects/:id/commit-as',
      { schema: { params: IdParamsSchema, body: SetCommitAsRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setCommitAs(ctx, s.user, req.params.id, req.body.commitAs);
        return getCommitAs(ctx, s.user, req.params.id);
      },
    );

    // "Post as" app selection (organization Owner or Admin); answers with the whole Commit as response.
    app.put(
      '/api/projects/:id/post-as',
      { schema: { params: IdParamsSchema, body: SetPostAsRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setPostAsApps(ctx, s.user, req.params.id, req.body.apps);
        return getCommitAs(ctx, s.user, req.params.id);
      },
    );

    app.post('/api/projects/:id/post-as/check', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const s = await requireUser(ctx, req);
      await assertCanCheckPostAs(ctx, s.user, req.params.id);
      const sent = await requestPostAsChecks(ctx, req.params.id);
      return reply.code(202).send({ sent });
    });
  };
}
