import { ListCapabilitiesQuerySchema, ReviewProjectSkillRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import { effectiveRegistry } from '../capabilities/registry.ts';
import { listProjectSkills, reviewProjectSkill } from '../commands/project-skills.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** Capability Registry v0: the effective registry of the tab's organization (metadata only). */
export function capabilityRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    app.get('/api/capabilities', { schema: { querystring: ListCapabilitiesQuerySchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'member' });
      return effectiveRegistry(ctx.pool, a.orgId, {
        userId: a.session.user.id,
        ...(req.query.kind ? { kind: req.query.kind } : {}),
        ...(req.query.projectId ? { projectId: req.query.projectId } : {}),
        ...(req.query.usable === 'true' ? { usableOnly: true } : {}),
      });
    });

    // The review list of capabilities found in project repositories (Owners and Admins).
    app.get('/api/capabilities/project-skills', async (req) =>
      listProjectSkills(ctx, whoOf(await requireOrg(ctx, req, { min: 'admin' }))),
    );
    app.post(
      '/api/capabilities/project-skills/review',
      { schema: { body: ReviewProjectSkillRequestSchema } },
      async (req) => reviewProjectSkill(ctx, whoOf(await requireOrg(ctx, req, { min: 'admin' })), req.body),
    );
  };
}
