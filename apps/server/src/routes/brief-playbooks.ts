import {
  InstallBriefPlaybookRequestSchema,
  IdParamsSchema,
  PatchBriefPlaybookRequestSchema,
} from '@aom/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../auth/guards.ts';
import { orgRoleOf, requestedOrgId, resolveOrgId } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import {
  installBriefPlaybook,
  listBriefPlaybooks,
  patchBriefPlaybook,
} from '../commands/brief-playbooks.ts';
import type { OrgCtx } from '../commands/schedules.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** The ready-made Brief playbooks of a business organization (not the `/` playbooks of the capabilities). */
export function briefPlaybookRoutes(ctx: Ctx) {
  const orgOf = async (req: FastifyRequest, s: AuthSession): Promise<OrgCtx | null> => {
    try {
      const orgId = await resolveOrgId(ctx, s, requestedOrgId(req));
      if (!orgId) return null;
      const role = await orgRoleOf(ctx.pool, s.user.id, orgId);
      return role ? { orgId, role } : null;
    } catch {
      return null;
    }
  };

  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/brief-playbooks', async (req) => {
      const s = await requireUser(ctx, req);
      return { playbooks: await listBriefPlaybooks(ctx, await orgOf(req, s)) };
    });

    app.post(
      '/api/brief-playbooks/:key/install',
      {
        schema: {
          params: z.object({ key: z.string().min(1).max(60) }),
          body: InstallBriefPlaybookRequestSchema,
        },
      },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        const r = await installBriefPlaybook(ctx, s.user, await orgOf(req, s), req.params.key, req.body);
        reply.code(201);
        return r;
      },
    );

    app.patch(
      '/api/brief-playbooks/schedules/:id',
      { schema: { params: IdParamsSchema, body: PatchBriefPlaybookRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return patchBriefPlaybook(ctx, s.user, await orgOf(req, s), req.params.id, req.body);
      },
    );
  };
}
