import {
  CeoActionsQuerySchema,
  CeoChatResponseSchema,
  CeoIdParamsSchema,
  CreateCeoMemoryRequestSchema,
  CreateCeoTaskRequestSchema,
  DEFAULT_CEO_POLICY,
  MoveCeoRequestSchema,
  PatchCeoMemoryRequestSchema,
  PatchCeoTaskRequestSchema,
  PauseCeoRequestSchema,
  UpdateCeoPolicyRequestSchema,
  UpdateCeoSettingsRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import {
  pauseCeo,
  resetCeoPolicy,
  resumeCeo,
  undoCeoAction,
  updateCeoPolicy,
  updateCeoSettings,
} from '../ceo/commands.ts';
import { ceoChatThread, moveCeo } from '../ceo/home.ts';
import {
  addOwnerRule,
  confirmMemory,
  editMemory,
  forgetMemory,
  listMemories,
  retireMemory,
} from '../ceo/memory.ts';
import { loadCeo } from '../ceo/state.ts';
import { createTask, listTasks, updateTask } from '../ceo/tasks.ts';
import { enqueueWake } from '../ceo/wakes.ts';
import type { Ctx } from '../context.ts';
import { forbidden, notFound } from '../errors.ts';
import { actionsCsv, ceoStatus, listActions } from '../queries/ceo.ts';
import { typed } from './util.ts';

/**
 * The CEO page API (docs/design/ceo-agent-v2.md section 8): the Owner configures and talks to the CEO, Admins read the
 * status, the policy and the activity log and may pause it. Memories and tasks are the Owner's alone.
 */
export function ceoRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const owner = async (req: Parameters<typeof requireOrg>[1]) => {
      const a = await requireOrg(ctx, req, { min: 'owner' });
      return a;
    };

    app.get('/api/ceo/status', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return ceoStatus(ctx, a.orgId, a.role === 'owner' ? 'owner' : 'admin');
    });

    app.get('/api/ceo/settings', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      const c = await loadCeo(ctx.pool, a.orgId);
      if (!c) throw notFound('this organization has no CEO');
      return { settings: c.settings, canEdit: a.role === 'owner' };
    });

    app.put('/api/ceo/settings', { schema: { body: UpdateCeoSettingsRequestSchema } }, async (req) => {
      const a = await owner(req);
      return { settings: await updateCeoSettings(ctx, a.session.user, a.orgId, req.body), canEdit: true };
    });

    app.get('/api/ceo/policy', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      const c = await loadCeo(ctx.pool, a.orgId);
      if (!c) throw notFound('this organization has no CEO');
      return { policy: c.policy, defaults: DEFAULT_CEO_POLICY, canEdit: a.role === 'owner' };
    });

    app.put('/api/ceo/policy', { schema: { body: UpdateCeoPolicyRequestSchema } }, async (req) => {
      const a = await owner(req);
      const policy = await updateCeoPolicy(ctx, a.session.user, a.orgId, req.body.policy, {
        ...(req.body.confirmDelegation ? { confirmDelegation: true } : {}),
        ...(req.body.note ? { note: req.body.note } : {}),
      });
      return { policy, defaults: DEFAULT_CEO_POLICY, canEdit: true };
    });

    app.post('/api/ceo/policy/reset', async (req) => {
      const a = await owner(req);
      return {
        policy: await resetCeoPolicy(ctx, a.session.user, a.orgId),
        defaults: DEFAULT_CEO_POLICY,
        canEdit: true,
      };
    });

    app.post('/api/ceo/pause', { schema: { body: PauseCeoRequestSchema.optional() } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await pauseCeo(ctx, a.session.user, a.orgId, req.body?.reason);
      return { ok: true };
    });

    app.post('/api/ceo/resume', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      await resumeCeo(ctx, a.session.user, a.orgId);
      return { ok: true };
    });

    app.post('/api/ceo/workstation', { schema: { body: MoveCeoRequestSchema } }, async (req) => {
      const a = await owner(req);
      await moveCeo(ctx, a.session.user, a.orgId, req.body);
      return { ok: true };
    });

    app.post('/api/ceo/chat', async (req) => {
      const a = await owner(req);
      return CeoChatResponseSchema.parse({ threadId: await ceoChatThread(ctx, a.session.user, a.orgId) });
    });

    // ----------------------------------------------------------------------------------------- activity log
    app.get('/api/ceo/actions', { schema: { querystring: CeoActionsQuerySchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return listActions(ctx.pool, a.orgId, req.query);
    });

    app.get(
      '/api/ceo/actions/export.csv',
      { schema: { querystring: CeoActionsQuerySchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        const r = await listActions(ctx.pool, a.orgId, { ...req.query, limit: 200 });
        reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', 'attachment; filename="ceo-activity.csv"');
        return actionsCsv(r.actions);
      },
    );

    app.post('/api/ceo/actions/:id/undo', { schema: { params: CeoIdParamsSchema } }, async (req) => {
      const a = await owner(req);
      return undoCeoAction(ctx, a.session.user, a.orgId, req.params.id);
    });

    // --------------------------------------------------------------------------------------------- memory
    app.get('/api/ceo/memories', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      // Admins see that memories exist, never their content (owner decision Q5).
      const list = await listMemories(ctx, a.orgId, { includeRetired: true });
      return {
        memories: a.role === 'owner' ? list : list.map((m) => ({ ...m, text: '', quote: '' })),
        canView: a.role === 'owner',
      };
    });

    app.post('/api/ceo/memories', { schema: { body: CreateCeoMemoryRequestSchema } }, async (req, reply) => {
      const a = await owner(req);
      const id = await addOwnerRule(ctx, a.orgId, a.session.user.id, req.body.text, req.body.scope);
      reply.code(201);
      return { id };
    });

    app.patch(
      '/api/ceo/memories/:id',
      { schema: { params: CeoIdParamsSchema, body: PatchCeoMemoryRequestSchema } },
      async (req) => {
        const a = await owner(req);
        await editMemory(ctx, a.orgId, a.session.user.id, req.params.id, req.body);
        return { ok: true };
      },
    );

    app.post('/api/ceo/memories/:id/confirm', { schema: { params: CeoIdParamsSchema } }, async (req) => {
      const a = await owner(req);
      await confirmMemory(ctx, a.orgId, a.session.user.id, req.params.id);
      return { ok: true };
    });

    app.post('/api/ceo/memories/:id/retire', { schema: { params: CeoIdParamsSchema } }, async (req) => {
      const a = await owner(req);
      await retireMemory(ctx, a.orgId, a.session.user.id, req.params.id);
      return { ok: true };
    });

    app.delete('/api/ceo/memories/:id', { schema: { params: CeoIdParamsSchema } }, async (req, reply) => {
      const a = await owner(req);
      await forgetMemory(ctx, a.orgId, a.session.user.id, req.params.id);
      reply.code(204);
    });

    // ----------------------------------------------------------------------------------------------- tasks
    app.get('/api/ceo/tasks', async (req) => {
      const a = await owner(req);
      return { tasks: await listTasks(ctx, a.orgId) };
    });

    app.post('/api/ceo/tasks', { schema: { body: CreateCeoTaskRequestSchema } }, async (req, reply) => {
      const a = await owner(req);
      const c = await loadCeo(ctx.pool, a.orgId);
      if (!c?.enabled) throw forbidden('there is no CEO to give a task to');
      const id = await createTask(ctx, a.orgId, {
        title: req.body.title,
        request: req.body.request,
        due: req.body.due,
        by: { kind: 'owner', userId: a.session.user.id },
      });
      await enqueueWake(
        ctx.pool,
        a.orgId,
        {
          reason: 'owner_task',
          urgency: 'normal',
          subjectKind: 'task',
          subjectId: id,
          subjectLabel: req.body.title,
        },
        ctx.clock.now(),
      );
      ctx.services.dispatcher.trigger();
      reply.code(201);
      return { id };
    });

    app.patch(
      '/api/ceo/tasks/:id',
      { schema: { params: CeoIdParamsSchema, body: PatchCeoTaskRequestSchema } },
      async (req) => {
        const a = await owner(req);
        await updateTask(ctx, a.orgId, req.params.id, req.body, 'owner', {
          kind: 'user',
          id: a.session.user.id,
        });
        return { ok: true };
      },
    );
  };
}
