import { type OrgDetailResponse, type OrgsResponse, SwitchOrgRequestSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg, requireUser } from '../auth/guards.ts';
import { membershipsOf, rememberActiveOrg } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { iso, one } from '../db/sql.ts';
import { HttpError } from '../errors.ts';
import { activeOrgDto } from '../orgs/summary.ts';
import { buildMe, guestOrgs } from '../queries/me.ts';
import { typed } from './util.ts';

/** Organization routes (docs/design/organizations.md section 10). All take the request org (`X-AOM-Org`). */
export function orgRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    /** Memberships (suspended ones flagged by `status`) and the organizations where the user is a guest. */
    app.get('/api/orgs', async (req): Promise<OrgsResponse> => {
      const s = await requireUser(ctx, req);
      const mine = await membershipsOf(ctx.pool, s.user.id);
      return {
        orgs: mine.map((m) => ({ id: m.org_id, name: m.name, role: m.role, status: m.status })),
        guestIn: await guestOrgs(ctx, s.user.id),
      };
    });

    /** Remembers the org as this session's default (the tab keeps its own in sessionStorage) and returns `me`. */
    app.post('/api/orgs/active', { schema: { body: SwitchOrgRequestSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      const mine = await membershipsOf(ctx.pool, s.user.id);
      if (!mine.some((m) => m.org_id === req.body.orgId))
        throw new HttpError(403, 'org_forbidden', 'you are not a member of that organization');
      await rememberActiveOrg(ctx, s, req.body.orgId);
      return buildMe(ctx, { ...s, activeOrgId: req.body.orgId }, req.body.orgId);
    });

    /** The organization of this request: any member (limits and usage for the Owner and Admins only). */
    app.get('/api/org', async (req): Promise<OrgDetailResponse> => {
      const a = await requireOrg(ctx, req);
      const owner = await one<{ id: string; display_name: string; email: string }>(
        ctx.pool,
        'SELECT id, display_name, email FROM users WHERE id=$1',
        [a.org.owner_user_id],
      );
      return {
        ...(await activeOrgDto(ctx, a.org, a.role)),
        owner: {
          id: owner?.id ?? a.org.owner_user_id,
          displayName: owner?.display_name ?? '',
          email: owner?.email ?? '',
        },
        createdAt: iso(a.org.created_at) as string,
      };
    });
  };
}
