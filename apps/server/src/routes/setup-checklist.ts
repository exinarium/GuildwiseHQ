import { SetupChecklistSchema, streamId, UpdateSetupChecklistRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { userActor, userScope } from '../commands/common.ts';
import type { Ctx } from '../context.ts';
import { getSetupChecklist } from '../queries/setup-checklist.ts';
import { typed } from './util.ts';

/** The "Get started" checklist: steps computed per organization, hide/reopen kept per user. */
export function setupChecklistRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/setup-checklist', async (req) => {
      const a = await requireOrg(ctx, req);
      return SetupChecklistSchema.parse(await getSetupChecklist(ctx, a.session.user.id, a.orgId, a.role));
    });

    app.put('/api/setup-checklist', { schema: { body: UpdateSetupChecklistRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      const user = a.session.user;
      await ctx.store.append([
        {
          streamId: streamId.user(user.id),
          event: {
            type: 'UserSetupChecklistChanged',
            payload: { userId: user.id, dismissed: req.body.dismissed },
          },
          actor: userActor(user.id),
          scope: userScope(user.id),
        },
      ]);
      return SetupChecklistSchema.parse(await getSetupChecklist(ctx, user.id, a.orgId, a.role));
    });
  };
}
