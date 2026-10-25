import { PatchPlatformSettingsRequestSchema, PlatformSettingsSchema } from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireSuperAdmin } from '../auth/guards.ts';
import { patchPlatformSettings, platformSettings } from '../commands/platform-settings.ts';
import type { Ctx } from '../context.ts';
import { typed } from './util.ts';

/** The platform administrator's notification settings (who is mailed about new organizations and audit events). */
export function platformSettingsRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);

    app.get('/api/platform/settings', async (req) => {
      await requireSuperAdmin(ctx, req);
      return PlatformSettingsSchema.parse(await platformSettings(ctx));
    });

    app.patch(
      '/api/platform/settings',
      { schema: { body: PatchPlatformSettingsRequestSchema } },
      async (req) => {
        const s = await requireSuperAdmin(ctx, req);
        return PlatformSettingsSchema.parse(await patchPlatformSettings(ctx, s.user, req.body));
      },
    );
  };
}
