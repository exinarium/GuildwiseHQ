import { IdParamsSchema, SetCommitAsRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { getCommitAs, setCommitAs } from '../commands/commit-as.ts';
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
  };
}
