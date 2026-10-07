import {
  isOrgManager,
  isValidTimeZone,
  type OrgRole,
  type ReportingResponse,
  streamId,
  type UpdateReportingRequest,
} from '@aom/shared';
import { orgOwnerId } from '../auth/org-context.ts';
import type { AuthSession } from '../auth/sessions.ts';
import type { Ctx } from '../context.ts';
import { badRequest, forbidden } from '../errors.ts';
import { reportingOf } from '../reporter/settings.ts';
import { orgScope, userActor, userScope } from './common.ts';

/**
 * How the BA reports for an organization: the Owner's and the Admins' to read and set. The preferences live on the
 * Owner's user row (the daily report runs on the Owner's clock); everyone else sees the organization's own settings.
 */
export async function getReporting(
  ctx: Ctx,
  org: { id: string; role: OrgRole | null },
): Promise<ReportingResponse> {
  const r = await reportingOf(ctx.pool, org.id);
  return {
    routeViaBa: r.routeViaBa,
    dailyAt: r.dailyAt,
    interestDigestCap: r.interestDigestCap,
    timezone: r.timezone,
    effectiveTimezone: r.timezone ?? 'UTC',
    canEdit: isOrgManager({ orgRole: org.role }),
  };
}

export async function updateReporting(
  ctx: Ctx,
  user: AuthSession['user'],
  org: { id: string; role: OrgRole | null },
  req: UpdateReportingRequest,
): Promise<ReportingResponse> {
  if (!isOrgManager({ orgRole: org.role }))
    throw forbidden('only the organization Owner and Admins can change how the BA reports');
  const ownerId = await orgOwnerId(ctx.pool, org.id);
  await ctx.store.append([
    {
      streamId: streamId.user(ownerId),
      event: {
        type: 'ReportingPrefsChanged',
        payload: {
          userId: ownerId,
          ...(req.routeViaBa !== undefined ? { routeViaBa: req.routeViaBa } : {}),
          ...(req.dailyAt !== undefined ? { dailyAt: req.dailyAt } : {}),
          ...(req.interestDigestCap !== undefined ? { interestDigestCap: req.interestDigestCap } : {}),
        },
      },
      actor: userActor(user.id),
      scope: orgScope(org.id),
    },
  ]);
  return getReporting(ctx, org);
}

export async function setTourState(
  ctx: Ctx,
  user: AuthSession['user'],
  status: 'in_progress' | 'completed' | 'dismissed',
  step: number,
): Promise<void> {
  await ctx.store.append([
    {
      streamId: streamId.user(user.id),
      event: { type: 'UserTourStateChanged', payload: { userId: user.id, status, step } },
      actor: userActor(user.id),
      scope: userScope(user.id),
    },
  ]);
}

export async function setTimezone(ctx: Ctx, user: AuthSession['user'], timezone: string): Promise<void> {
  if (!isValidTimeZone(timezone)) throw badRequest('invalid_timezone', `${timezone} is not a time zone`);
  await ctx.store.append([
    {
      streamId: streamId.user(user.id),
      event: { type: 'UserTimezoneChanged', payload: { userId: user.id, timezone } },
      actor: userActor(user.id),
      scope: userScope(user.id),
    },
  ]);
}
