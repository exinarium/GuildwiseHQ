import {
  AgentDraftRequestSchema,
  AgentDraftStartedSchema,
  AgentDraftStatusSchema,
  ClampDraftRequestSchema,
  ClampDraftResponseSchema,
  FollowUpSettingsSchema,
  HireFromDraftRequestSchema,
  IdParamsSchema,
  MentionableResponseSchema,
  MentionPolicySchema,
  SnoozeRequestSchema,
  StarterDraftResponseSchema,
  StarterGalleryResponseSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg, requireUser } from '../auth/guards.ts';
import { whoOf } from '../auth/org-context.ts';
import {
  clampDraftFor,
  getAgentDraft,
  hireFromDraft,
  startAgentDraft,
  starterGallery,
  starterPersonaDraft,
} from '../commands/agent-draft.ts';
import { getMentionPolicy, listMentionable, setMentionPolicy } from '../commands/agent-mentions.ts';
import { followUpDays, setFollowUpDays, snoozeDeskItem } from '../commands/follow-up.ts';
import type { Ctx } from '../context.ts';
import { notFound } from '../errors.ts';
import { getAgentDto } from '../queries/agents.ts';
import { typed } from './util.ts';

/** Agent UX (S-B2, docs/ARCHITECTURE.md section 38.12): mentions, describe-an-agent, the starter gallery, follow-up. */
export function agentUxRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    // ---- @agent in card comments
    app.get(
      '/api/cards/:id/mentionable',
      {
        schema: { params: z.object({ id: z.string().min(1) }), response: { 200: MentionableResponseSchema } },
      },
      async (req) => {
        const s = await requireUser(ctx, req);
        return { agents: await listMentionable(ctx, s.user, req.params.id) };
      },
    );
    app.get(
      '/api/agents/:id/mention-policy',
      { schema: { params: IdParamsSchema, response: { 200: MentionPolicySchema } } },
      async (req) => {
        const s = await requireOrg(ctx, req, { min: 'member' });
        return getMentionPolicy(ctx, s.session.user, req.params.id);
      },
    );
    app.put(
      '/api/agents/:id/mention-policy',
      {
        schema: { params: IdParamsSchema, body: MentionPolicySchema, response: { 200: MentionPolicySchema } },
      },
      async (req) => {
        const s = await requireOrg(ctx, req, { min: 'member' });
        return setMentionPolicy(ctx, s.session.user, req.params.id, req.body);
      },
    );

    // ---- describe-an-agent quick hire
    app.post(
      '/api/agents/draft',
      { schema: { body: AgentDraftRequestSchema, response: { 202: AgentDraftStartedSchema } } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        reply.code(202);
        return startAgentDraft(ctx, whoOf(a), req.body);
      },
    );
    app.get(
      '/api/agents/draft/:id',
      { schema: { params: IdParamsSchema, response: { 200: AgentDraftStatusSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return getAgentDraft(ctx, whoOf(a), req.params.id);
      },
    );
    app.post(
      '/api/agents/draft-clamp',
      { schema: { body: ClampDraftRequestSchema, response: { 200: ClampDraftResponseSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return { draft: await clampDraftFor(ctx, whoOf(a), req.body.draft) };
      },
    );
    app.post(
      '/api/agents/hire-from-draft',
      { schema: { body: HireFromDraftRequestSchema } },
      async (req, reply) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        const id = await hireFromDraft(ctx, a.session.user, { id: a.orgId }, req.body);
        const agent = await getAgentDto(ctx, a.session.user.id, id);
        if (!agent) throw notFound('agent not found');
        reply.code(201);
        return agent;
      },
    );

    // ---- starter gallery
    app.get(
      '/api/starter-gallery',
      { schema: { response: { 200: StarterGalleryResponseSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return starterGallery(ctx, whoOf(a));
      },
    );
    app.get(
      '/api/starter-gallery/:key/draft',
      {
        schema: {
          params: z.object({ key: z.string().min(1).max(130) }),
          response: { 200: StarterDraftResponseSchema },
        },
      },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return { draft: await starterPersonaDraft(ctx, whoOf(a), req.params.key) };
      },
    );

    // ---- follow-up and chase
    app.get('/api/org/follow-up', { schema: { response: { 200: FollowUpSettingsSchema } } }, async (req) => {
      const a = await requireOrg(ctx, req, { min: 'member' });
      return { days: await followUpDays(ctx.pool, a.orgId) };
    });
    app.put(
      '/api/org/follow-up',
      { schema: { body: FollowUpSettingsSchema, response: { 200: FollowUpSettingsSchema } } },
      async (req) => {
        const a = await requireOrg(ctx, req, { min: 'member' });
        return { days: await setFollowUpDays(ctx, whoOf(a), req.body.days) };
      },
    );
    app.post(
      '/api/desk/:id/snooze',
      { schema: { params: IdParamsSchema, body: SnoozeRequestSchema } },
      async (req) => {
        const s = await requireUser(ctx, req);
        return snoozeDeskItem(ctx, s.user, req.params.id, req.body.days);
      },
    );
  };
}
