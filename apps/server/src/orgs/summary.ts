import {
  type ActiveOrg,
  type Banner,
  effectiveFeatures,
  isBillingReason,
  isOrgManager,
  type OrgLimits,
  type OrgRole,
  type OrgStatus,
  type OrgUsage,
  planDefinition,
} from '@aom/shared';
import type { OrgRow } from '../auth/org-context.ts';
import type { Ctx } from '../context.ts';
import { iso, one } from '../db/sql.ts';
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
  if (org.status === 'suspended' && isBillingReason(org.status_reason)) {
    const owner = role === 'owner';
    const what = org.status_reason?.slice('billing:'.length);
    const text: Record<string, string> = {
      setup: `Add a card to start the 7-day free trial of ${org.name}.`,
      payment_failed: `${org.name} is paused because the last payment failed.`,
      cancelled: `${org.name} is paused because the subscription was cancelled.`,
      admin: `${org.name} is paused by the platform administrator.`,
    };
    out.push({
      kind: 'suspended',
      severity: 'danger',
      audience: 'all',
      message: `${text[what ?? ''] ?? `${org.name} is paused.`} Agents are not picking up work and only the Owner can sign in. ${owner ? 'Open Billing to resubscribe.' : 'Ask the Owner to resubscribe.'}`,
      ...(owner ? { link: '/settings/org?tab=billing' } : {}),
    });
  } else if (org.status === 'suspended') {
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

/** The full-page billing screen an Owner gets instead of the app (see `ActiveOrg.gate`); null for everything else. */
export function billingGate(
  org: { status: OrgStatus; status_reason: string | null; plan: string; simulation?: boolean | null },
  role: OrgRole,
): ActiveOrg['gate'] {
  if (role !== 'owner' || org.status !== 'suspended' || org.simulation || org.plan === 'unlimited')
    return null;
  switch (org.status_reason) {
    case 'billing:setup':
      return { kind: 'setup', reason: 'setup' };
    case 'billing:payment_failed':
      return { kind: 'resubscribe', reason: 'payment_failed' };
    case 'billing:cancelled':
      return { kind: 'resubscribe', reason: 'cancelled' };
    default:
      return null;
  }
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
    planName:
      (await one(ctx.pool, 'SELECT name FROM billing_plans WHERE key=$1', [org.plan]))?.name ??
      planDefinition(org.plan).name,
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
    simulation: Boolean(org.simulation),
    // Members see "suspended" and "cancelled" only.
    banners: banners.filter((b) => manager || b.audience === 'all'),
    gate: billingGate(
      { status: org.status, status_reason: org.status_reason ?? null, plan: org.plan, simulation: org.simulation },
      role,
    ),
  };
}
