import type { OrgFeature, OrgRole } from '@aom/shared';
import type { FastifyRequest } from 'fastify';
import type { Ctx } from '../context.ts';
import { forbidden, HttpError, notFound, unauthorized } from '../errors.ts';
import {
  loadOrg,
  type OrgAccess,
  orgAccessFor,
  orgRoleOf,
  type RequireOrgOptions,
  requestedOrgId,
  requireFeature,
  resolveOrgId,
} from './org-context.ts';
import { type AuthSession, lookupSession, SESSION_COOKIE } from './sessions.ts';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthSession | null;
  }
}

/** The session of the request, whoever it belongs to (the auth routes and the platform guard build on it). */
export async function requireSession(ctx: Ctx, req: FastifyRequest): Promise<AuthSession> {
  if (req.auth) return req.auth;
  const s = await lookupSession(ctx, req.cookies[SESSION_COOKIE]);
  if (!s) throw unauthorized();
  req.auth = s;
  return s;
}

const path = (req: FastifyRequest): string => (req.url.split('?')[0] ?? '').toLowerCase();

/**
 * Authenticated user session or 401. The user is always `active` (deactivated users have no valid session). A super
 * admin has no business in the app routes (403 `super_admin_platform_only`), and an account that must have two-factor
 * login but has not set it up yet only reaches `/api/auth/*` until it has (403 `two_factor_setup_required`).
 */
export async function requireUser(ctx: Ctx, req: FastifyRequest): Promise<AuthSession> {
  const s = await requireSession(ctx, req);
  if (s.user.kind === 'super_admin')
    throw new HttpError(403, 'super_admin_platform_only', 'platform accounts use the platform area only');
  assertTwoFactorSetUp(s, req);
  return s;
}

function assertTwoFactorSetUp(s: AuthSession, req: FastifyRequest): void {
  if (s.twoFactor.setupRequired && !path(req).startsWith('/api/auth/'))
    throw new HttpError(403, 'two_factor_setup_required', 'set up two-factor login to continue', {
      required: true,
    });
}

/** Super admin session or 404: the platform routes do not advertise themselves to anyone else. */
export async function requireSuperAdmin(ctx: Ctx, req: FastifyRequest): Promise<AuthSession> {
  let s: AuthSession;
  try {
    s = await requireSession(ctx, req);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) throw notFound();
    throw e;
  }
  if (s.user.kind !== 'super_admin') throw notFound();
  assertTwoFactorSetUp(s, req);
  return s;
}

/**
 * A member of the request's organization (docs/design/organizations.md section 4.4): the `X-AOM-Org` header, else the
 * session's default. 403 `org_forbidden` (not a member), `org_suspended`, `org_role_required`, `feature_disabled`;
 * 403 `no_organization` for an account without any membership.
 */
export async function requireOrg(
  ctx: Ctx,
  req: FastifyRequest,
  opts: RequireOrgOptions = {},
): Promise<OrgAccess> {
  const s = await requireUser(ctx, req);
  const orgId = await resolveOrgId(ctx, s, requestedOrgId(req));
  if (!orgId) throw new HttpError(403, 'no_organization', 'you do not belong to an organization');
  return orgAccessFor(ctx, s, orgId, opts);
}

/**
 * A signed-in user on a route that belongs to a feature (interests, phases, research, outbound): 403 `feature_disabled`
 * when the tab's organization has it switched off. A user without membership in the tab's organization (a guest working
 * in someone else's project) is not blocked by it.
 */
export async function requireUserWithFeature(
  ctx: Ctx,
  req: FastifyRequest,
  feature: OrgFeature,
): Promise<AuthSession> {
  const s = await requireUser(ctx, req);
  const orgId = await resolveOrgId(ctx, s, requestedOrgId(req));
  if (!orgId) return s;
  const org = await loadOrg(ctx.pool, orgId);
  if (org && (await orgRoleOf(ctx.pool, s.user.id, orgId))) requireFeature(org, feature);
  return s;
}

/** `requireOrg` with a minimum role. */
export const requireOrgRole = (ctx: Ctx, req: FastifyRequest, min: OrgRole) => requireOrg(ctx, req, { min });

/** Retired with the app-wide administrator role: only the legacy /api/admin routes still call it. */
export async function requireAdmin(ctx: Ctx, req: FastifyRequest): Promise<AuthSession> {
  const s = await requireUser(ctx, req);
  if (s.user.role !== 'admin') throw forbidden('administrator access required');
  return s;
}

export { notFound };
