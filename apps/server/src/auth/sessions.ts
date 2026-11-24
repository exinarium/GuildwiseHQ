import { type SessionMethod, sessionMethodProvesFactor, streamId } from '@aom/shared';
import { notifySuperAdmins } from '../commands/platform-notify.ts';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { exec, one, type Queryable } from '../db/sql.ts';
import { afterCommit, withAppendTx, withTx } from '../db/tx.ts';
import { HttpError } from '../errors.ts';
import { newSignInMail } from '../mail/templates.ts';
import { sendSecurityMail } from './security-mail.ts';
import { securitySetting } from './security-settings.ts';
import { type SealedRow, sessionMac, sessionMacValid } from './session-mac.ts';
import { uaFamily } from './ua-family.ts';

export const SESSION_COOKIE = 'aom_sid';
const ABSOLUTE_MS = 30 * 24 * 3600_000;
const IDLE_MS = 7 * 24 * 3600_000;
/** Super admin sessions are short (R4): absolute 8 h, idle `AOM_SUPER_ADMIN_IDLE_SEC` (default 30 min). */
export const SUPER_ADMIN_ABSOLUTE_MS = 8 * 3600_000;
const superAdminIdleMs = (ctx: Ctx) => ctx.config.superAdminIdleSec * 1000;
/** A sign-in from an IP plus browser family not seen for the user in this long is a new device (R4). */
const NEW_DEVICE_MS = 180 * 24 * 3600_000;
/** At most one "forged session" mail to the super admins per this long (per process). */
const REJECT_MAIL_MS = 10 * 60_000;
const TOUCH_MS = 5 * 60_000;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string;
  /** The retired app-wide role (still read by the legacy /api/admin routes until they go). */
  role: 'admin' | 'member';
  kind: 'user' | 'super_admin';
  status: 'active' | 'deactivated';
  createdAt: Date;
  lastLoginAt: Date | null;
  lastOrgId: string | null;
}

export interface SessionTwoFactor {
  enabled: boolean;
  /** Super admin, or a member of an organization whose Owner requires it. */
  required: boolean;
  /** Required and not set up yet: the session reaches the setup endpoints only. */
  setupRequired: boolean;
}

export interface AuthSession {
  sessionId: string;
  user: SessionUser;
  /** The organization remembered for this session (the request header wins). */
  activeOrgId: string | null;
  twoFactor: SessionTwoFactor;
  /** An Owner set a temporary password: until the user chooses their own, the session reaches `/api/auth/*` only. */
  mustChangePassword: boolean;
  /** How the session was started (null: a session from before 1.10.0, or one built without a cookie). */
  method: SessionMethod | null;
  /** When the user last proved a second factor (or, without 2FA, the password) in this session: step-up freshness (R5). */
  secondFactorAt: Date | null;
}

/**
 * Starts a session. `method` says how (R4): only the `password*` methods make the session fresh for step-up
 * (`second_factor_at` = now); `invitation`, `email_verification` and `demo` never do [rv 9]. The row and its
 * `SessionStarted` event (projected into `sign_ins`) are written in one append transaction, so every session has its
 * sign-in record; a super-admin session without one is refused as forged (`lookupSession`). A sign-in from a new device
 * mails the user (`AOM_SIGNIN_NOTICES`; never for `demo`).
 */
export async function createSession(
  ctx: Ctx,
  userId: string,
  meta: { userAgent?: string | undefined; ip?: string | undefined },
  method: SessionMethod,
): Promise<{ token: string; maxAgeSec: number; sessionId: string }> {
  const token = randomToken(32);
  const sessionId = sha256Hex(token);
  const now = ctx.clock.now();
  const family = uaFamily(meta.userAgent);
  const out = await withAppendTx(ctx.pool, async (tx) => {
    const u = await one<{ kind: string; last_org_id: string | null; email: string; display_name: string }>(
      tx,
      'SELECT kind, last_org_id, email, display_name FROM users WHERE id=$1',
      [userId],
    );
    const absolute = u?.kind === 'super_admin' ? SUPER_ADMIN_ABSOLUTE_MS : ABSOLUTE_MS;
    const expiresAt = new Date(now.getTime() + absolute);
    const secondFactorAt = sessionMethodProvesFactor(method) ? now : null;
    // the seal over exactly the values written (release-readiness O5)
    const mac = await sessionMac(ctx, { id: sessionId, userId, expiresAt, secondFactorAt, method });
    await exec(
      tx,
      `INSERT INTO auth_sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent, ip, active_org_id, method,
         second_factor_at, mac)
       VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        sessionId,
        userId,
        now,
        expiresAt,
        meta.userAgent ?? null,
        meta.ip ?? null,
        u?.last_org_id ?? null,
        method,
        secondFactorAt,
        mac,
      ],
    );
    await exec(tx, 'UPDATE users SET last_login_at=$2 WHERE id=$1', [userId, now]);
    const seen = await deviceSeen(tx, userId, meta.ip ?? null, family, now);
    const newDevice = !seen.device;
    await ctx.store.append(
      [
        {
          streamId: streamId.user(userId),
          event: {
            type: 'SessionStarted',
            payload: {
              userId,
              method,
              sessionRef: sessionId,
              newDevice,
              uaFamily: family,
              meta: {
                ...(meta.ip ? { ip: meta.ip.slice(0, 64) } : {}),
                ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 400) } : {}),
              },
            },
          },
          actor: { kind: 'user', id: userId },
          scope: { orgId: null, projectId: null, audience: 'user', userId },
        },
      ],
      { tx },
    );
    // No mail for the very first sign-in of an account (nothing to compare with), nor for demo sessions [rv 9].
    if (u && newDevice && seen.any && method !== 'demo' && signInNoticeFor(ctx, u.kind))
      afterCommit(tx, () =>
        sendSecurityMail(
          ctx,
          newSignInMail({
            to: u.email,
            name: u.display_name,
            when: now,
            ip: meta.ip ?? null,
            device: describeFamily(family),
            origin: ctx.config.publicOrigin,
          }),
        ),
      );
    return { absolute };
  });
  return { token, maxAgeSec: out.absolute / 1000, sessionId };
}

/** Whether the user signed in before at all, and from this IP plus browser family within 180 days. */
async function deviceSeen(
  db: Queryable,
  userId: string,
  ip: string | null,
  family: string,
  now: Date,
): Promise<{ any: boolean; device: boolean }> {
  const r = await one<{ any: boolean; device: boolean }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM sign_ins WHERE user_id=$1) AS any,
            EXISTS (SELECT 1 FROM sign_ins WHERE user_id=$1 AND ip IS NOT DISTINCT FROM $2 AND ua_family=$3 AND at > $4)
              AS device`,
    [userId, ip, family, new Date(now.getTime() - NEW_DEVICE_MS)],
  );
  return { any: !!r?.any, device: !!r?.device };
}

/** `AOM_SIGNIN_NOTICES`: everyone (D2), super admins only, or nobody. */
const signInNoticeFor = (ctx: Ctx, kind: string): boolean =>
  ctx.config.signinNotices === 'all' ||
  (ctx.config.signinNotices === 'super_admin' && kind === 'super_admin');

/** `chrome/linux` -> "Chrome on Linux", for mails and the Security page. */
export function describeFamily(family: string): string {
  const [b = 'other', o = 'other'] = family.split('/');
  const name: Record<string, string> = {
    chrome: 'Chrome',
    edge: 'Edge',
    firefox: 'Firefox',
    safari: 'Safari',
    opera: 'Opera',
    samsung: 'Samsung Internet',
    curl: 'curl',
    script: 'a script',
    test: 'a test client',
    other: 'an unknown browser',
    unknown: 'an unknown browser',
  };
  const os: Record<string, string> = {
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
    ios: 'iOS',
    android: 'Android',
    chromeos: 'ChromeOS',
    other: 'an unknown system',
  };
  return `${name[b] ?? b} on ${os[o] ?? o}`;
}

/** Returns the session for a cookie token, or null if unknown/expired/idle/deactivated. Slides `last_seen_at`. */
export async function lookupSession(ctx: Ctx, token: string | undefined): Promise<AuthSession | null> {
  if (!token) return null;
  const id = sha256Hex(token);
  const r = await one(
    ctx.pool,
    `SELECT s.id AS sid, s.user_id AS s_user_id, s.last_seen_at, s.expires_at, s.active_org_id, s.method, s.second_factor_at, s.mac, s.ip AS s_ip,
            s.user_agent AS s_user_agent, u.id, u.email, u.display_name, u.legacy_role,
            u.kind, u.status, u.created_at, u.last_login_at, u.last_org_id, u.two_factor_enabled, u.must_change_password,
            ${TWO_FACTOR_REQUIRED_SQL} AS two_factor_required
       FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [id, await securitySetting(ctx, 'enforceTwoFactor')],
  );
  if (!r) return null;
  const now = ctx.clock.now();
  const idle = r.kind === 'super_admin' ? superAdminIdleMs(ctx) : IDLE_MS;
  if (
    new Date(r.expires_at) <= now ||
    now.getTime() - new Date(r.last_seen_at).getTime() > idle ||
    r.status !== 'active'
  ) {
    if (r.status !== 'active' || new Date(r.expires_at) <= now) await deleteSession(ctx, id);
    return null;
  }
  // R4 per-request check [rv 2]: a super-admin session must have the sign-in that created it. That catches a row
  // inserted with SQL (12:25) and a row whose user_id was rewritten to a super admin (09:51).
  if (r.kind === 'super_admin' && !(await superAdminSessionGenuine(ctx, r, id))) return null;
  // Release-readiness O5: the row's seal. A row without one is a session from before migration 3025: it ends quietly
  // (everyone signs in once after the upgrade; one info line, no alarm). A row inserted with SQL has no sign-in and was
  // refused by R4 above if it named a super admin, so the quiet path loses no alarm for that case.
  if (!r.mac) {
    await deleteSession(ctx, id);
    ctx.services.browser.closeSession(id);
    ctx.log.info(
      { sessionRef: id.slice(0, 12) },
      'ended a session from before the sign-in seal: sign in again',
    );
    return null;
  }
  // A seal that does not match: the row was edited outside the app.
  if (!(await sessionMacValid(ctx, { ...sealedOf(r), id }))) {
    if (r.kind === 'super_admin') await rejectSuperAdminSession(ctx, r, id, 'bad_mac');
    else {
      await deleteSession(ctx, id);
      ctx.services.browser.closeSession(id);
      ctx.log.warn({ sessionRef: id.slice(0, 12) }, 'refused a session whose seal does not match');
    }
    return null;
  }
  if (now.getTime() - new Date(r.last_seen_at).getTime() > TOUCH_MS) {
    await exec(ctx.pool, 'UPDATE auth_sessions SET last_seen_at=$2 WHERE id=$1', [id, now]);
  }
  return toSession(r, id);
}

const lastRejectMail = new WeakMap<Ctx, number>();

/**
 * True when a `sign_ins` row exists for this session and this user (one indexed query, super-admin requests only).
 * Otherwise the session is deleted, `SuperAdminSessionRejected` is appended (platform audit `always`), every super
 * admin is mailed (at most once per 10 min) and the request gets a 401.
 */
async function superAdminSessionGenuine(
  ctx: Ctx,
  r: Record<string, unknown>,
  sessionId: string,
): Promise<boolean> {
  const userId = String(r.s_user_id);
  if (await one(ctx.pool, 'SELECT 1 FROM sign_ins WHERE session_ref=$1 AND user_id=$2', [sessionId, userId]))
    return true;
  const other = await one(ctx.pool, 'SELECT 1 FROM sign_ins WHERE session_ref=$1 LIMIT 1', [sessionId]);
  await rejectSuperAdminSession(ctx, r, sessionId, other ? 'user_mismatch' : 'no_sign_in');
  return false;
}

/**
 * Refuses a super-admin session (R4): deleted, `SuperAdminSessionRejected` appended (platform audit `always`), every
 * super admin mailed (at most once per 10 min).
 */
async function rejectSuperAdminSession(
  ctx: Ctx,
  r: Record<string, unknown>,
  sessionId: string,
  reason: 'no_sign_in' | 'user_mismatch' | 'bad_mac',
): Promise<void> {
  const userId = String(r.s_user_id);
  const deleted = await exec(ctx.pool, 'DELETE FROM auth_sessions WHERE id=$1', [sessionId]);
  if (!deleted) return; // a concurrent request already refused it
  ctx.services.browser.closeSession(sessionId);
  const meta = {
    ...(r.s_ip ? { ip: String(r.s_ip).slice(0, 64) } : {}),
    ...(r.s_user_agent ? { userAgent: String(r.s_user_agent).slice(0, 400) } : {}),
  };
  await ctx.store.append([
    {
      streamId: streamId.user(userId),
      event: { type: 'SuperAdminSessionRejected', payload: { userId, sessionRef: sessionId, reason, meta } },
      actor: { kind: 'system', id: null },
      scope: { orgId: null, projectId: null, audience: 'admin' },
    },
  ]);
  ctx.log.warn({ userId, reason }, 'refused a super-admin session that no sign-in created');
  const now = ctx.clock.now().getTime();
  const last = lastRejectMail.get(ctx);
  if (last === undefined || now - last >= REJECT_MAIL_MS) {
    lastRejectMail.set(ctx, now);
    void notifySuperAdmins(ctx, {
      subject: 'A forged super-admin session was refused',
      heading: 'A super-admin session no sign-in created was refused',
      facts: [
        ['Account', String(r.email)],
        [
          'Why',
          reason === 'user_mismatch'
            ? 'the session belongs to another sign-in'
            : reason === 'bad_mac'
              ? 'the session record was changed outside the app'
              : 'no sign-in created it',
        ],
        ['When', new Date(now).toISOString()],
        ...(meta.ip ? ([['Address of the session', meta.ip]] as Array<[string, string]>) : []),
      ],
      path: '/platform/audit',
      linkLabel: 'Open the audit log',
    });
  }
}

/**
 * Whether the account must have two-factor login (`$2` = "Require two-factor login" is on, R28): a super admin, a member
 * of an organization whose Owner requires it, or anyone while the setting is on, except users whose only memberships
 * are simulation organizations (demos, e2e).
 */
const TWO_FACTOR_REQUIRED_SQL = `(u.kind = 'super_admin' OR EXISTS (
     SELECT 1 FROM org_members om JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id = u.id AND om.status = 'active' AND o.require_two_factor AND o.status IN ('trial','active'))
   OR ($2::boolean AND NOT (
     EXISTS (SELECT 1 FROM org_members om WHERE om.user_id = u.id AND om.status = 'active')
     AND NOT EXISTS (SELECT 1 FROM org_members om JOIN organizations o ON o.id = om.org_id
                      WHERE om.user_id = u.id AND om.status = 'active' AND NOT o.simulation))))`;

function toSession(r: Record<string, any>, sessionId: string): AuthSession {
  const enabled = Boolean(r.two_factor_enabled);
  const required = Boolean(r.two_factor_required);
  return {
    sessionId,
    activeOrgId: r.active_org_id ?? null,
    twoFactor: { enabled, required, setupRequired: required && !enabled },
    mustChangePassword: Boolean(r.must_change_password),
    method: r.method ?? null,
    secondFactorAt: r.second_factor_at ? new Date(r.second_factor_at) : null,
    user: {
      id: r.id,
      email: r.email,
      displayName: r.display_name,
      role: r.legacy_role ?? 'member',
      kind: r.kind,
      status: r.status,
      createdAt: new Date(r.created_at),
      lastLoginAt: r.last_login_at ? new Date(r.last_login_at) : null,
      lastOrgId: r.last_org_id ?? null,
    },
  };
}

/** The user's account part of a session (no cookie): for responses built right after login, accept or setup. */
export async function sessionOfUser(ctx: Ctx, userId: string): Promise<AuthSession> {
  const r = await one(
    ctx.pool,
    `SELECT NULL::text AS active_org_id, NULL::text AS method, NULL::timestamptz AS second_factor_at, u.id, u.email, u.display_name, u.legacy_role, u.kind, u.status, u.created_at,
            u.last_login_at, u.last_org_id, u.two_factor_enabled, u.must_change_password, ${TWO_FACTOR_REQUIRED_SQL} AS two_factor_required
       FROM users u WHERE u.id = $1`,
    [userId, await securitySetting(ctx, 'enforceTwoFactor')],
  );
  if (!r) throw new Error('user not found');
  return toSession(r, '');
}

export const deleteSession = (ctx: Ctx, sessionId: string) =>
  exec(ctx.pool, 'DELETE FROM auth_sessions WHERE id=$1', [sessionId]);

/** The covered columns of a looked-up row (`lookupSession`'s aliases). */
const sealedOf = (r: Record<string, any>) => ({
  user_id: String(r.s_user_id),
  expires_at: r.expires_at,
  second_factor_at: r.second_factor_at ?? null,
  method: r.method ?? null,
  mac: r.mac ?? null,
});

/**
 * Records a fresh second-factor proof in the session (step-up, a confirmed 2FA enrolment) and re-seals the row
 * (release-readiness O5). Under the row lock it first checks the STORED seal over the current values and that the row
 * still belongs to the signed-in user with the same method (design review R2-S1): a row rewritten between the request's
 * lookup and here is deleted and refused (401), never re-sealed. One UPDATE writes both columns, so a concurrent request
 * never sees a half-written row.
 */
export async function markSecondFactor(
  ctx: Ctx,
  s: Pick<AuthSession, 'sessionId' | 'method'> & { user: Pick<SessionUser, 'id'> },
  at: Date,
): Promise<void> {
  const ok = await withTx(ctx.pool, async (tx) => {
    const row = await one<SealedRow>(
      tx,
      'SELECT id, user_id, expires_at, second_factor_at, method, mac FROM auth_sessions WHERE id=$1 FOR UPDATE',
      [s.sessionId],
    );
    if (!row) return false;
    const genuine =
      row.user_id === s.user.id &&
      (row.method ?? null) === (s.method ?? null) &&
      (await sessionMacValid(ctx, row));
    if (!genuine) {
      await exec(tx, 'DELETE FROM auth_sessions WHERE id=$1', [s.sessionId]);
      return false;
    }
    const expiresAt = new Date(row.expires_at);
    const mac = await sessionMac(ctx, {
      id: row.id,
      userId: row.user_id,
      expiresAt,
      secondFactorAt: at,
      method: row.method ?? null,
    });
    await exec(
      tx,
      'UPDATE auth_sessions SET second_factor_at=$2, mac=$3 WHERE id=$1 AND user_id=$4 AND expires_at=$5',
      [s.sessionId, at, mac, row.user_id, expiresAt],
    );
    return true;
  });
  if (!ok) {
    ctx.services.browser.closeSession(s.sessionId);
    ctx.log.warn(
      { sessionRef: s.sessionId.slice(0, 12) },
      'refused to re-seal a session whose record changed',
    );
    throw new HttpError(401, 'session_ended', 'your session ended: sign in again');
  }
}
