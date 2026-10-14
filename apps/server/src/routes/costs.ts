import {
  CostsQuerySchema,
  CostsReportSchema,
  IdParamsSchema,
  SetBudgetRequestSchema,
  UpdateCostSettingsRequestSchema,
  UpdateValueSettingsRequestSchema,
  ValueQuerySchema,
  ValueReportSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg, requireUser } from '../auth/guards.ts';
import {
  overrideProjectBudget,
  setCostSettings,
  setProjectBudget,
  setValueSettings,
} from '../commands/budgets.ts';
import type { Ctx } from '../context.ts';
import { costSettings, costsCsv, costsReport, csvField } from '../costs/report.ts';
import { valueCsv, valueReport } from '../costs/value.ts';
import { one } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { typed } from './util.ts';

/** The backing project of an interest the user can see (they are a member of it); 404 otherwise. */
async function backingProjectOf(ctx: Ctx, userId: string, interestId: string): Promise<string> {
  const r = await one(
    ctx.pool,
    `SELECT i.project_id FROM interests i JOIN project_members pm ON pm.project_id = i.project_id
      WHERE i.id = $1 AND pm.user_id = $2 AND pm.status = 'active'`,
    [interestId, userId],
  );
  if (!r?.project_id) throw notFound('interest not found');
  return r.project_id;
}

/** Cost tracking and budgets: the org-level Costs page (Owner and Admin), the currency, and the project budget. */
export function costRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/costs', { schema: { querystring: CostsQuerySchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return CostsReportSchema.parse(await costsReport(ctx.pool, a.orgId, req.query, ctx.clock.now()));
    });

    app.get('/api/costs/export.csv', { schema: { querystring: CostsQuerySchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      const r = await costsCsv(ctx.pool, a.orgId, req.query, ctx.clock.now());
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="aom-costs-${r.from}-to-${r.to}.csv"`);
      return r.csv;
    });

    // The value report (backlog #37): finished cards, estimated human hours, usage and return, for Owner and Admin.
    app.get('/api/value', { schema: { querystring: ValueQuerySchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return ValueReportSchema.parse(await valueReport(ctx.pool, a.orgId, req.query, ctx.clock.now(), true));
    });

    app.get('/api/value/export.csv', { schema: { querystring: ValueQuerySchema } }, async (req, reply) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      const r = await valueCsv(ctx.pool, a.orgId, req.query, ctx.clock.now(), csvField);
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="aom-value-${r.month}.csv"`);
      return r.csv;
    });

    app.put('/api/value/settings', { schema: { body: UpdateValueSettingsRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await setValueSettings(ctx, a.session.user, a.orgId, req.body);
      return ValueReportSchema.parse(await valueReport(ctx.pool, a.orgId, {}, ctx.clock.now(), true));
    });

    app.get('/api/costs/settings', async (req) => {
      const a = await requireOrg(ctx, req);
      return costSettings(ctx.pool, a.orgId, a.role === 'owner' || a.role === 'admin');
    });

    app.put('/api/costs/settings', { schema: { body: UpdateCostSettingsRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await setCostSettings(ctx, a.session.user, a.orgId, req.body);
      return costSettings(ctx.pool, a.orgId, true);
    });

    // The project's own organization decides who may (the tab's active organization may be another one).
    app.put(
      '/api/projects/:id/budget',
      { schema: { params: IdParamsSchema, body: SetBudgetRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setProjectBudget(ctx, s.user, req.params.id, req.body.monthly);
        return { ok: true };
      },
    );

    // An interest's budget is its hidden backing project's: the same rule (Owner and Admin of the organization).
    app.put(
      '/api/interests/:id/budget',
      { schema: { params: IdParamsSchema, body: SetBudgetRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        await setProjectBudget(
          ctx,
          s.user,
          await backingProjectOf(ctx, s.user.id, req.params.id),
          req.body.monthly,
        );
        return { ok: true };
      },
    );

    app.post('/api/interests/:id/budget/override', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await overrideProjectBudget(ctx, s.user, await backingProjectOf(ctx, s.user.id, req.params.id));
      return { ok: true };
    });

    app.post('/api/projects/:id/budget/override', { schema: { params: IdParamsSchema } }, async (req) => {
      const s = await requireUser(ctx, req);
      await overrideProjectBudget(ctx, s.user, req.params.id);
      return { ok: true };
    });
  };
}
