import { isValidTimeZone, type ReportingResponse, streamId, type UpdateReportingRequest } from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { badRequest } from '../errors.ts';
import { reportingOf } from '../reporter/settings.ts';
import { orgScope, userActor } from './common.ts';

export async function getReporting(ctx: Ctx, userId: string): Promise<ReportingResponse> {
  const r = await reportingOf(ctx.pool, userId);
  return {
    routeViaBa: r.routeViaBa,
    dailyAt: r.dailyAt,
    timezone: r.timezone,
    effectiveTimezone: r.timezone ?? 'UTC',
    canEdit: true,
  };
}

/** The signed-in user is the owner of their own organization: they set its routing and its report time. */
export async function updateReporting(
  ctx: Ctx,
  user: AuthSession['user'],
  req: UpdateReportingRequest,
): Promise<ReportingResponse> {
  await ctx.store.append([
    {
      streamId: streamId.user(user.id),
      event: {
        type: 'ReportingPrefsChanged',
        payload: {
          userId: user.id,
          ...(req.routeViaBa !== undefined ? { routeViaBa: req.routeViaBa } : {}),
          ...(req.dailyAt !== undefined ? { dailyAt: req.dailyAt } : {}),
        },
      },
      actor: userActor(user.id),
      scope: orgScope(user.id),
    },
  ]);
  return getReporting(ctx, user.id);
}

export async function setTimezone(ctx: Ctx, user: AuthSession['user'], timezone: string): Promise<void> {
  if (!isValidTimeZone(timezone)) throw badRequest('invalid_timezone', `${timezone} is not a time zone`);
  await ctx.store.append([
    {
      streamId: streamId.user(user.id),
      event: { type: 'UserTimezoneChanged', payload: { userId: user.id, timezone } },
      actor: userActor(user.id),
      scope: orgScope(user.id),
    },
  ]);
}
