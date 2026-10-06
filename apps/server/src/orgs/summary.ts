import {
  type ActiveOrg,
  type Banner,
  effectiveFeatures,
  isOrgManager,
  type OrgLimits,
  type OrgRole,
  type OrgStatus,
  type OrgUsage,
  planDefinition,
} from '@aom/shared';
import type { OrgRow } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { iso } from '../db/sql.ts';
import { limitState, orgLimits, orgUsage } from './limits.ts';

const DAY = 24 * 3600_000;
export const WARN_DAYS = 14;

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

/** Banners under the top bar (section 11.1). Warnings about dates and limits are for the Owner and Admins only. */
export function orgBanners(
  org: {
    name: string;
    status: OrgStatus;
    status_reason: string | null;
    trial_ends_at: Date | null;
    license_expires_at: Date | null;
    grace_days: number;
  },
  role: OrgRole,
  now: Date,
  limits: OrgLimits,
  usage: OrgUsage,
): Banner[] {
  const out: Banner[] = [];
  if (org.status === 'suspended') {
    const why =
      org.status_reason === 'trial_ended'
        ? 'the trial ended'
        : org.status_reason === 'license_expired'
          ? 'the licence expired'
          : null;
    out.push({
      kind: 'suspended',
      severity: 'danger',
      audience: 'all',
      message: `${org.name} is suspended${why ? ` (${why})` : ''}. Agents are not picking up work and only the Owner can sign in. Contact support to resume.`,
    });
  } else if (org.status === 'cancelled') {
    out.push({
      kind: 'cancelled',
      severity: 'danger',
      audience: 'all',
      message: `${org.name} is cancelled. It is read-only for the Owner and nothing runs.`,
    });
  }
  if (!isOrgManager({ orgRole: role })) return out;
  if (org.trial_ends_at && org.status === 'trial') {
    const left = org.trial_ends_at.getTime() - now.getTime();
    if (left <= WARN_DAYS * DAY)
      out.push({
        kind: 'trial_ending',
        severity: 'warning',
        audience: 'managers',
        message:
          left > 0
            ? `The trial of ${org.name} ends on ${fmtDate(org.trial_ends_at)} (${Math.max(1, Math.ceil(left / DAY))} days left).`
            : `The trial of ${org.name} has ended.`,
      });
  }
  if (org.license_expires_at && org.status !== 'suspended' && org.status !== 'cancelled') {
    const left = org.license_expires_at.getTime() - now.getTime();
    if (left <= WARN_DAYS * DAY) {
      const graceEnd = new Date(org.license_expires_at.getTime() + org.grace_days * DAY);
      out.push({
        kind: 'license_ending',
        severity: 'warning',
        audience: 'managers',
        message:
          left > 0
            ? `The licence of ${org.name} expires on ${fmtDate(org.license_expires_at)}.`
            : `The licence of ${org.name} expired on ${fmtDate(org.license_expires_at)}; it keeps working until ${fmtDate(graceEnd)}.`,
      });
    }
  }
  const over = limitState(usage, limits).filter((l) => l.over);
  if (over.length)
    out.push({
      kind: 'over_limit',
      severity: 'warning',
      audience: 'managers',
      message: `${org.name} is over its limit of ${over.map((o) => `${o.max} ${o.kind}`).join(', ')}. Nothing is removed, but more cannot be added.`,
    });
  return out;
}

/** The `activeOrg` block of `me` and `GET /api/org` for a member in `role`. */
export async function activeOrgDto(ctx: Ctx, org: OrgRow, role: OrgRole): Promise<ActiveOrg> {
  const manager = isOrgManager({ orgRole: role });
  const limits = await orgLimits(ctx.pool, org.id);
  const usage = await orgUsage(ctx.pool, org.id);
  const banners = orgBanners(
    {
      name: org.name,
      status: org.status,
      status_reason: org.status_reason ?? null,
      trial_ends_at: org.trial_ends_at ? new Date(org.trial_ends_at) : null,
      license_expires_at: org.license_expires_at ? new Date(org.license_expires_at) : null,
      grace_days: org.grace_days,
    },
    role,
    ctx.clock.now(),
    limits,
    usage,
  );
  return {
    id: org.id,
    name: org.name,
    role,
    status: org.status,
    plan: org.plan,
    planName: planDefinition(org.plan).name,
    features: effectiveFeatures(org.plan, org.features),
    ...(manager
      ? {
          limits,
          usage,
          trialEndsAt: iso(org.trial_ends_at),
          licenseExpiresAt: iso(org.license_expires_at),
          graceDays: org.grace_days,
        }
      : {}),
    requireTwoFactor: Boolean(org.require_two_factor),
    // Members see "suspended" and "cancelled" only.
    banners: banners.filter((b) => manager || b.audience === 'all'),
  };
}
