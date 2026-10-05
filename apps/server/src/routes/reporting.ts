import { UpdateReportingRequestSchema, UpdateTimezoneRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireUser } from '../auth/guards.ts';
import { getReporting, setTimezone, updateReporting } from '../commands/reporting.ts';
import type { Ctx } from '../context.ts';
import { meResponse } from './auth.ts';
import { typed } from './util.ts';

/** Part B settings: the organization's reporting preferences and the manager's time zone. */
export function reportingRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/reporting', async (req) => {
      const s = await requireUser(ctx, req);
      return getReporting(ctx, s.user.id);
    });

    app.put('/api/reporting', { schema: { body: UpdateReportingRequestSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      return updateReporting(ctx, s.user, req.body);
    });

    app.put('/api/auth/timezone', { schema: { body: UpdateTimezoneRequestSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await setTimezone(ctx, s.user, req.body.timezone);
      return meResponse(ctx, s.user.id);
    });
  };
}
