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
import { one } from '../db/sql.ts';
import { diagnosticsConsentAvailable } from './diagnostics.ts';
import { limitState, orgLimits, orgUsage } from './limits.ts';

/** Banners under the top bar (section 11.1). Warnings about limits are for the Owner and Admins only. */
export function orgBanners(
  org: { name: string; status: OrgStatus; status_reason: string | null },
  role: OrgRole,
  limits: OrgLimits,
  usage: OrgUsage,
): Banner[] {
  const out: Banner[] = [];
  if (org.status === 'suspended') {
    out.push({
      kind: 'suspended',
      severity: 'danger',
      audience: 'all',
      message: `${org.name} is suspended. Agents are not picking up work and only the Owner can sign in. Contact your platform administrator to resume.`,
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
export async function activeOrgDto(
  ctx: Ctx,
  org: OrgRow,
  role: OrgRole,
  userId?: string,
): Promise<ActiveOrg> {
  const manager = isOrgManager({ orgRole: role });
  const limits = await orgLimits(ctx, ctx.pool, org.id);
  const usage = await orgUsage(ctx.pool, org.id);
  const banners = orgBanners(
    { name: org.name, status: org.status, status_reason: org.status_reason ?? null },
    role,
    limits,
    usage,
  );
  const dto: ActiveOrg = {
    id: org.id,
    name: org.name,
    role,
    status: org.status,
    plan: org.plan,
    planName: planDefinition(org.plan).name,
    features: effectiveFeatures(org.plan, org.features),
    ...(manager ? { limits, usage } : {}),
    mode: org.mode === 'business' ? 'business' : 'dev',
    viewOverride: userId ? await memberViewOverride(ctx, org.id, userId) : null,
    requireTwoFactor: Boolean(org.require_two_factor),
    diagnosticsSharing: Boolean(org.diagnostics_sharing),
    diagnosticsSharingAvailable: await diagnosticsConsentAvailable(ctx, org.id),
    simulation: Boolean(org.simulation),
    banners,
    gate: null,
  };
  // Extensions add to the block: a plan name, a billing banner or gate, trial dates.
  for (const e of ctx.ext.list) await e.decorateActiveOrg?.(ctx, org, role, dto);
  // Members see "suspended" and "cancelled" only.
  dto.banners = dto.banners.filter((b) => manager || b.audience === 'all');
  return dto;
}

/** The member's own view for the organization, or null (follow the organization default). */
async function memberViewOverride(
  ctx: Ctx,
  orgId: string,
  userId: string,
): Promise<'dev' | 'business' | null> {
  const m = await one<{ view: string | null }>(
    ctx.pool,
    `SELECT view FROM org_members WHERE org_id=$1 AND user_id=$2 AND status='active'`,
    [orgId, userId],
  );
  return m?.view === 'business' ? 'business' : m?.view === 'dev' ? 'dev' : null;
}
