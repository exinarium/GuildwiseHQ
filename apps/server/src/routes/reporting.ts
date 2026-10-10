import {
  UpdateReportingRequestSchema,
  UpdateTimezoneRequestSchema,
  UpdateTourRequestSchema,
  WhatsNewSeenRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg, requireSession, requireUser } from '../auth/guards.ts';
import { requestedOrgId } from '../auth/org-context.ts';
import { getReporting, markWhatsNewSeen, setTimezone, setTourState, updateReporting } from '../commands/reporting.ts';
import type { Ctx } from '../context.ts';
import { meResponse } from './auth.ts';
import { typed } from './util.ts';

/** Part B settings: the organization's reporting preferences and the manager's time zone. */
export function reportingRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/reporting', async (req) => {
      const a = await requireOrg(ctx, req);
      return getReporting(ctx, { id: a.orgId, role: a.role });
    });

    app.put('/api/reporting', { schema: { body: UpdateReportingRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return updateReporting(ctx, a.session.user, { id: a.orgId, role: a.role }, req.body);
    });

    app.put('/api/auth/timezone', { schema: { body: UpdateTimezoneRequestSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await setTimezone(ctx, s.user, req.body.timezone);
      return meResponse(ctx, s.user.id, requestedOrgId(req));
    });

    app.put('/api/auth/tour', { schema: { body: UpdateTourRequestSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await setTourState(ctx, s.user, req.body.status, req.body.step);
      return meResponse(ctx, s.user.id, requestedOrgId(req));
    });

    app.put('/api/auth/whats-new-seen', { schema: { body: WhatsNewSeenRequestSchema } }, async (req) => {
      const s = await requireSession(ctx, req); // platform administrators have release notes too
      await markWhatsNewSeen(ctx, s.user, req.body.entryIds);
      return meResponse(ctx, s.user.id, requestedOrgId(req));
    });
  };
}
