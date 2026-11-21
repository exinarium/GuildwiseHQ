import {
  PatchSecuritySettingsRequestSchema,
  SECURITY_SETTING_KEYS,
  SETTING_LOCKED,
  StepUpRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireSession, requireSuperAdmin } from '../auth/guards.ts';
import { SlidingLimit } from '../auth/limits.ts';
import { securitySettingsView, setSecuritySetting } from '../auth/security-settings.ts';
import { answerStepUp, requireStepUp } from '../auth/step-up.ts';
import type { Ctx } from '../context.ts';
import { conflict } from '../errors.ts';
import { typed } from './util.ts';

const metaOf = (req: { ip: string; headers: Record<string, unknown> }) => {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, ...(typeof ua === 'string' ? { userAgent: ua.slice(0, 400) } : {}) };
};

/** "Confirm it's you" (R5) and the platform security settings (R27, R28). */
export function securityRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    const stepUpPerUser = new SlidingLimit(8, 60_000);

    // A fresh second factor (or the password, for accounts without two-factor login) for the guarded actions.
    app.post('/api/auth/step-up', { schema: { body: StepUpRequestSchema } }, async (req) => {
      const s = await requireSession(ctx, req);
      if (ctx.config.rateLimit) stepUpPerUser.hit(s.user.id);
      return answerStepUp(ctx, s, req.body, metaOf(req));
    });

    app.get('/api/platform/security-settings', async (req) => {
      await requireSuperAdmin(ctx, req);
      return securitySettingsView(ctx);
    });

    app.patch(
      '/api/platform/security-settings',
      { schema: { body: PatchSecuritySettingsRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        requireStepUp(ctx, s);
        // a locked key refuses the whole request, before anything is written
        for (const key of SECURITY_SETTING_KEYS)
          if (req.body[key] !== undefined && ctx.ext.lockedSecuritySettings[key])
            throw conflict(
              SETTING_LOCKED,
              'this setting is set by the hosting platform and cannot be changed here',
              {
                key,
              },
            );
        for (const key of SECURITY_SETTING_KEYS) {
          const value = req.body[key];
          if (value === undefined) continue;
          await setSecuritySetting(ctx, s.user, key, value, {
            confirmUnlink: req.body.confirmUnlink,
            meta: metaOf(req),
          });
        }
        return securitySettingsView(ctx);
      },
    );
  };
}
