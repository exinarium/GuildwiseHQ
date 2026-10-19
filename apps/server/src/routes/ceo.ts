import { randomUUID } from 'node:crypto';
import {
  AnswerPermissionRequestSchema,
  AskIdParamsSchema,
  CeoActionsQuerySchema,
  CeoChatResponseSchema,
  CeoIdParamsSchema,
  ConfirmTurnRequestSchema,
  CorrectCeoRequestSchema,
  CreateCeoMemoryRequestSchema,
  CreateCeoTaskRequestSchema,
  DEFAULT_CEO_POLICY,
  EditCorrectionRequestSchema,
  MoveCeoRequestSchema,
  PatchCeoMemoryRequestSchema,
  PatchCeoTaskRequestSchema,
  PauseCeoRequestSchema,
  QueuedTurnDecisionSchema,
  ResolveRepeatRequestSchema,
  SetThreadModelRequestSchema,
  streamId,
  UpdateCeoPolicyRequestSchema,
  UpdateCeoSettingsRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireOrg } from '../auth/guards.ts';
import { ceoChatState, setThreadModel } from '../ceo/chat-state.ts';
import {
  pauseCeo,
  resetCeoPolicy,
  resumeCeo,
  undoCeoAction,
  updateCeoPolicy,
  updateCeoSettings,
} from '../ceo/commands.ts';
import { editCorrection, listCorrections, recordCorrection, redoCorrection } from '../ceo/corrections.ts';
import { ceoChatThread, moveCeo } from '../ceo/home.ts';
import { listOpenRepeats } from '../ceo/jobs.ts';
import {
  addOwnerRule,
  confirmMemory,
  editMemory,
  forgetMemory,
  listMemories,
  retireMemory,
} from '../ceo/memory.ts';
import { listOrderTurns } from '../ceo/order-turns.ts';
import { answerPermission } from '../ceo/permissions.ts';
import { loadCeo } from '../ceo/state.ts';
import { createTask, listTasks, updateTask } from '../ceo/tasks.ts';
import { enqueueWake } from '../ceo/wakes.ts';
import { orgScope, SYSTEM_ACTOR } from '../commands/common.ts';
import { resolveDeskItem } from '../commands/desk.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
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

    // ------------------------------------------------------------------- the chat as a full session (step 1)
    app.get('/api/ceo/chat/state', async (req) => {
      const a = await owner(req);
      return ceoChatState(ctx, a.orgId);
    });

    app.put('/api/ceo/chat/model', { schema: { body: SetThreadModelRequestSchema } }, async (req) => {
      const a = await owner(req);
      await setThreadModel(ctx, a.session.user, a.orgId, req.body.choice);
      return { ok: true };
    });

    /** A stale queued message: send it anyway, or drop it. */
    app.post(
      '/api/ceo/queue/:id',
      { schema: { params: AskIdParamsSchema, body: QueuedTurnDecisionSchema } },
      async (req) => {
        const a = await owner(req);
        const t = await one(ctx.pool, 'SELECT org_id FROM ceo_turns WHERE id=$1', [req.params.id]);
        if (!t || t.org_id !== a.orgId) throw notFound('queued message not found');
        await ctx.services.chat.decideQueued(a.session.user.id, req.params.id, req.body.decision);
        return { ok: true };
      },
    );

    /** "Authorize this execution": any Owner or Admin (docs section 14.1). */
    app.post(
      '/api/ceo/permissions/:id',
      { schema: { params: AskIdParamsSchema, body: AnswerPermissionRequestSchema } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'admin' });
        await answerPermission(ctx, a.session.user, req.params.id, req.body.decision);
        return { ok: true };
      },
    );

    /**
     * The Owner's own answer to an inline confirmation card of an owner turn (docs section 6.2): Approve runs the recommended
     * action with his say-so, No declines it. Answered by his session, never by text the model relays.
     */
    app.post(
      '/api/ceo/turns/:id/confirm',
      { schema: { params: AskIdParamsSchema, body: ConfirmTurnRequestSchema } },
      async (req) => {
        const a = await owner(req);
        const item = await one(
          ctx.pool,
          `SELECT d.id, d.title FROM desk_items d
            WHERE d.org_id=$1 AND d.subkind='ceo_recommendation' AND d.status='open'
              AND d.data->>'actionId'=$2 AND d.data->>'inlineTurnId'=$3`,
          [a.orgId, req.body.actionId, req.params.id],
        );
        if (!item) throw notFound('that confirmation is not open any more');
        await resolveDeskItem(ctx, a.session.user, item.id, {
          resolution: req.body.approve ? 'approved' : 'rejected',
        });
        const turn = await one(ctx.pool, 'SELECT thread_id FROM ceo_turns WHERE id=$1', [req.params.id]);
        if (turn)
          await ctx.store.append([
            {
              streamId: streamId.thread(turn.thread_id),
              event: {
                type: 'ThreadMessagePosted',
                payload: {
                  threadId: turn.thread_id,
                  messageId: randomUUID(),
                  authorKind: 'system',
                  kind: 'system',
                  body: `${req.body.approve ? 'You approved' : 'You declined'}: ${String(item.title).slice(0, 200)}`,
                  data: {
                    confirmation: req.body.approve ? 'approved' : 'declined',
                    actionId: req.body.actionId,
                  },
                },
              },
              actor: SYSTEM_ACTOR,
              scope: orgScope(a.orgId),
            },
          ]);
        return { ok: true };
      },
    );

    // ----------------------------------------------------------------------------------------------- corrections
    app.post('/api/ceo/corrections', { schema: { body: CorrectCeoRequestSchema } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return recordCorrection(ctx, a.session.user, a.orgId, req.body);
    });

    app.get('/api/ceo/corrections', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return { corrections: await listCorrections(ctx.pool, a.orgId, { limit: 50 }) };
    });

    app.patch(
      '/api/ceo/corrections/:id',
      { schema: { params: AskIdParamsSchema, body: EditCorrectionRequestSchema } },
      async (req) => {
        const a = await owner(req);
        await editCorrection(ctx, a.session.user, a.orgId, req.params.id, req.body.rule);
        return { ok: true };
      },
    );

    /** "Redo it as ...": the corrected call (stored with the correction) runs with the Owner's say-so. */
    app.post('/api/ceo/corrections/:id/redo', { schema: { params: AskIdParamsSchema } }, async (req) => {
      const a = await owner(req);
      return { message: await redoCorrection(ctx, a.session.user, a.orgId, req.params.id) };
    });

    // ------------------------------------------------------------------------------ the job log and its repeats
    app.get('/api/ceo/repeats', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return { repeats: await listOpenRepeats(ctx.pool, a.orgId) };
    });

    app.post(
      '/api/ceo/repeats/:id/resolve',
      { schema: { params: AskIdParamsSchema, body: ResolveRepeatRequestSchema } },
      async (req) => {
        const a = await owner(req);
        const r = await one(
          ctx.pool,
          `SELECT 1 FROM ceo_repeats WHERE id=$1 AND org_id=$2 AND status='open'`,
          [req.params.id, a.orgId],
        );
        if (!r) throw notFound('that repeat is not open');
        await ctx.store.append([
          {
            streamId: streamId.ceo(a.orgId),
            event: {
              type: 'CeoRepeatResolved',
              payload: {
                repeatId: req.params.id,
                orgId: a.orgId,
                decision: req.body.decision,
                by: a.session.user.id,
              },
            },
            actor: { kind: 'user', id: a.session.user.id },
            scope: orgScope(a.orgId),
          },
        ]);
        return { ok: true };
      },
    );

    app.get('/api/ceo/order-turns', async (req) => {
      const a = await requireOrg(ctx, req, { min: 'admin' });
      return { turns: await listOrderTurns(ctx.pool, a.orgId) };
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
