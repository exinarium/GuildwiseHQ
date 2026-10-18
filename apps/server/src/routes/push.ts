import {
  type PushConfig,
  type PushPayload,
  PushPreferencesSchema,
  PushPreferencesUpdateSchema,
  PushSubscribeRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg, requireUser } from '../auth/guards.ts';
import type { Ctx } from '../context.ts';
import { exec, iso, one, rows } from '../db/sql.ts';
import { notFound } from '../errors.ts';
import { loadPreferences, savePreferences } from '../push/prefs.ts';
import { addSubscription, badgeCountFor, deviceLabel, sendToUser } from '../push/sender.ts';
import { typed } from './util.ts';

/** Web Push: the public key, this person's devices, their preferences and a test send. */
export function pushRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/push/config', async (req): Promise<PushConfig> => {
      await requireUser(ctx, req);
      const p = ctx.config.push;
      return p.enabled && p.publicKey ? { enabled: true, publicKey: p.publicKey } : { enabled: false };
    });

    app.get('/api/push/subscriptions', async (req) => {
      const s = await requireUser(ctx, req);
      const r = await rows(
        ctx.pool,
        `SELECT id, label, endpoint, created_at, last_success_at, last_failure_at, failure_count
           FROM push_subscriptions WHERE user_id=$1 ORDER BY created_at`,
        [s.user.id],
      );
      return {
        devices: r.map((d) => ({
          id: d.id,
          label: d.label,
          endpoint: d.endpoint,
          createdAt: iso(d.created_at),
          lastSuccessAt: iso(d.last_success_at),
          lastFailureAt: iso(d.last_failure_at),
          failureCount: d.failure_count,
        })),
      };
    });

    app.post(
      '/api/push/subscriptions',
      { schema: { body: PushSubscribeRequestSchema } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        if (!ctx.config.push.enabled)
          return reply.code(409).send({
            error: { code: 'push_disabled', message: 'push notifications are not set up on this server' },
          });
        const id = await addSubscription(ctx, s.user.id, {
          endpoint: req.body.endpoint,
          p256dh: req.body.keys.p256dh,
          auth: req.body.keys.auth,
          label: req.body.label ?? deviceLabel(req.headers['user-agent']),
        });
        return reply.code(201).send({ id });
      },
    );

    app.delete(
      '/api/push/subscriptions/:id',
      { schema: { params: z.object({ id: z.uuid() }) } },
      async (req, reply) => {
        const s = await requireUser(ctx, req);
        // Own devices only: another person's id is indistinguishable from none.
        const n = await exec(ctx.pool, 'DELETE FROM push_subscriptions WHERE id=$1 AND user_id=$2', [
          req.params.id,
          s.user.id,
        ]);
        if (n === 0) throw notFound();
        return reply.code(204).send();
      },
    );

    app.get('/api/push/preferences', async (req) => {
      const a = await requireOrg(ctx, req);
      return PushPreferencesSchema.parse(await loadPreferences(ctx, a.session.user.id, a.orgId));
    });

    app.put('/api/push/preferences', { schema: { body: PushPreferencesUpdateSchema } }, async (req) => {
      const a = await requireOrg(ctx, req);
      return PushPreferencesSchema.parse(await savePreferences(ctx, a.session.user.id, a.orgId, req.body));
    });

    app.post('/api/push/test', async (req) => {
      const s = await requireUser(ctx, req);
      if (!ctx.config.push.enabled) return { sent: 0, failed: 0 };
      const count = await one<{ n: string }>(
        ctx.pool,
        'SELECT count(*) AS n FROM push_subscriptions WHERE user_id=$1',
        [s.user.id],
      );
      if (Number(count?.n ?? 0) === 0) return { sent: 0, failed: 0 };
      const payload: PushPayload = {
        title: 'Test notification',
        body: 'Push notifications work on this device.',
        url: '/settings',
        tag: 'test',
        badge: await badgeCountFor(ctx, s.user.id),
      };
      return sendToUser(ctx, s.user.id, payload, { urgency: 'high', ttlSeconds: 300 });
    });
  };
}
