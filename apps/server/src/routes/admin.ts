import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../context.ts';

/**
 * `/api/admin/*` (the app-wide administrator) is gone: it answers 410 with where its pieces went, for one release
 * (docs/design/organizations.md section 10). Members and invitations live under `/api/org`, accounts and organizations
 * under `/api/platform` (super admin only).
 */
export function adminRoutes(_ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    fastify.all('/api/admin/*', async (req, reply) => {
      const url = req.url.split('?')[0] ?? '';
      const to = url.startsWith('/api/admin/workstations')
        ? '/workstations'
        : url.includes('invit')
          ? '/settings/org'
          : '/platform';
      return reply
        .code(410)
        .send({ error: { code: 'moved', message: 'this endpoint moved', details: { to } } });
    });
  };
}
