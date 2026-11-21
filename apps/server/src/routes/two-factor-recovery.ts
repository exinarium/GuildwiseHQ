import {
  StartTwoFactorRecoveryRequestSchema,
  TwoFactorRecoveryStatusSchema,
  TwoFactorRecoveryTokenRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { SlidingLimit } from '../auth/limits.ts';
import {
  cancelTwoFactorRecovery,
  confirmTwoFactorRecovery,
  startTwoFactorRecovery,
  twoFactorRecoveryStatus,
} from '../commands/two-factor-recovery.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/**
 * "Lost your authenticator?" (R17-2): the user's own two-factor recovery. Public routes (the user cannot sign in); the
 * start needs the challenge of a sign-in whose password was right, the others the mailed token. Tokens travel in the
 * body, never in a URL (the page keeps it in the fragment).
 */
export function twoFactorRecoveryRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const perIp = new SlidingLimit(10, 60 * 60_000);
    const tokenPerIp = new SlidingLimit(30, 60_000);
    const metaOf = (req: { ip: string; headers: Record<string, unknown> }) => {
      const ua = req.headers['user-agent'];
      return { ip: req.ip, ...(typeof ua === 'string' ? { userAgent: ua.slice(0, 400) } : {}) };
    };

    app.post(
      '/api/auth/2fa/recovery/start',
      { schema: { body: StartTwoFactorRecoveryRequestSchema } },
      async (req) => {
        if (ctx.config.rateLimit) perIp.hit(req.ip);
        return TwoFactorRecoveryStatusSchema.parse(
          await startTwoFactorRecovery(ctx, req.body.challenge, metaOf(req)),
        );
      },
    );
    app.post(
      '/api/auth/2fa/recovery/status',
      { schema: { body: TwoFactorRecoveryTokenRequestSchema } },
      async (req) => {
        if (ctx.config.rateLimit) tokenPerIp.hit(req.ip);
        return TwoFactorRecoveryStatusSchema.parse(await twoFactorRecoveryStatus(ctx, req.body.token));
      },
    );
    app.post(
      '/api/auth/2fa/recovery/confirm',
      { schema: { body: TwoFactorRecoveryTokenRequestSchema } },
      async (req) => {
        if (ctx.config.rateLimit) tokenPerIp.hit(req.ip);
        return TwoFactorRecoveryStatusSchema.parse(await confirmTwoFactorRecovery(ctx, req.body.token));
      },
    );
    app.post(
      '/api/auth/2fa/recovery/cancel',
      { schema: { body: TwoFactorRecoveryTokenRequestSchema } },
      async (req) => {
        if (ctx.config.rateLimit) tokenPerIp.hit(req.ip);
        return TwoFactorRecoveryStatusSchema.parse(await cancelTwoFactorRecovery(ctx, req.body.token));
      },
    );
  };
}
