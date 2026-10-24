import { AgentMayDoSchema, AuditExportQuerySchema, SetAgentGateRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../auth/guards.ts';
import type { Ctx } from '../context.ts';
import { auditExport } from '../governance/audit-export.ts';
import { setAgentGate } from '../governance/gates.ts';
import { getAgentMayDo } from '../governance/may-do.ts';
import { typed } from './util.ts';

/** S-B1: "What it may do" for an agent and its approval gates. */
export function governanceRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const Params = z.object({ id: z.uuid() });

    app.get(
      '/api/agents/:id/may-do',
      { schema: { params: Params, response: { 200: AgentMayDoSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return getAgentMayDo(ctx, a.session.user, req.params.id);
      },
    );
    // Org admins export the organization's audit log (CSV or JSON), streamed; the export is itself an event.
    app.get(
      '/api/org/audit/export',
      { schema: { querystring: AuditExportQuerySchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        const out = await auditExport(ctx, a.orgId, a.session.user.id, req.query);
        return reply
          .header('content-type', out.contentType)
          .header('content-disposition', `attachment; filename="${out.filename}"`)
          .header('cache-control', 'no-store')
          .header('x-content-type-options', 'nosniff')
          .send(out.stream);
      },
    );
    app.put(
      '/api/agents/:id/gates',
      { schema: { params: Params, body: SetAgentGateRequestSchema, response: { 200: AgentMayDoSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        await setAgentGate(ctx, a.session.user, req.params.id, req.body);
        return getAgentMayDo(ctx, a.session.user, req.params.id);
      },
    );
  };
}
