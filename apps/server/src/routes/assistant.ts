import { PassThrough } from 'node:stream';
import {
  AssistantChallengeSchema,
  AssistantChatRequestSchema,
  AssistantStatusSchema,
  PlatformAssistantSchema,
  UpdatePlatformAssistantRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { newChallenge } from '../assistant/limits.ts';
import {
  type AnthropicLike,
  admit,
  answer,
  availability,
  platformAssistant,
  setAdminEnabled,
} from '../assistant/service.ts';
import { requireSuperAdmin } from '../auth/guards.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/**
 * The public landing-page assistant (docs/design/ai-assistant.md, section 2.1) and its super admin switch. Anonymous
 * and without tools: it can read nothing of anyone's data. No conversation is stored; only counters.
 * `client` is null when no API key is configured.
 */
export function assistantRoutes(ctx: Ctx, client: AnthropicLike | null) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const limited = {
      rateLimit: ctx.config.rateLimit ? { max: 30, timeWindow: '1 minute' } : (false as const),
    };

    app.get('/api/public/assistant/status', { config: limited }, async (_req, reply) => {
      const a = await availability(ctx, client);
      reply.header('cache-control', 'no-store');
      return AssistantStatusSchema.parse(
        a.available
          ? { available: true }
          : { available: false, ...(a.reason === 'busy' ? { reason: 'busy' } : {}) },
      );
    });

    app.get('/api/public/assistant/challenge', { config: limited }, async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      return AssistantChallengeSchema.parse(newChallenge(ctx));
    });

    app.post(
      '/api/public/assistant/chat',
      { schema: { body: AssistantChatRequestSchema }, bodyLimit: 64 * 1024, config: limited },
      async (req, reply) => {
        // Every refusal (switch, cap, limits, proof of work) is an ordinary JSON error before the stream starts.
        await admit(ctx, client, req.ip, req.body);
        const out = new PassThrough();
        const control = { aborted: false, abort: undefined as (() => void) | undefined };
        reply.raw.on('close', () => {
          if (!reply.raw.writableFinished) {
            control.aborted = true;
            control.abort?.();
          }
        });
        void (async () => {
          try {
            for await (const ev of answer(ctx, client as AnthropicLike, req.body, {
              get aborted() {
                return control.aborted;
              },
              onAbort: (fn) => {
                control.abort = fn;
              },
            }))
              out.write(`data: ${JSON.stringify(ev)}\n\n`);
          } finally {
            out.end();
          }
        })();
        reply
          .header('content-type', 'text/event-stream; charset=utf-8')
          .header('cache-control', 'no-store, no-transform')
          .header('x-accel-buffering', 'no');
        return reply.send(out);
      },
    );

    app.get('/api/platform/assistant', async (req) => {
      await requireSuperAdmin(ctx, req);
      return PlatformAssistantSchema.parse(await platformAssistant(ctx, client));
    });

    app.put(
      '/api/platform/assistant',
      { schema: { body: UpdatePlatformAssistantRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        await setAdminEnabled(ctx, s.user.id, req.body.enabled);
        return PlatformAssistantSchema.parse(await platformAssistant(ctx, client));
      },
    );
  };
}
