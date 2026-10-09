import {
  ChangePasswordRequestSchema,
  IdParamsSchema,
  Login2faRequestSchema,
  LoginRequestSchema,
  type MeResponse,
  PasswordResetConfirmSchema,
  PasswordResetRequestSchema,
  PasswordResetTokenParamsSchema,
  SetMyAvatarRequestSchema,
  streamId,
  TwoFactorConfirmRequestSchema,
  TwoFactorEnableRequestSchema,
  TwoFactorSetupRequestSchema,
} from '@aom/shared';
import type { FastifyInstance } from 'fastify';
import { requireSession } from '../auth/guards.ts';
import { SlidingLimit } from '../auth/limits.ts';
import { requestedOrgId } from '../auth/org-context.ts';
import { verifyPassword } from '../auth/password.ts';
import { createSession, deleteSession, SESSION_COOKIE, sessionOfUser } from '../auth/sessions.ts';
import {
  answerLoginChallenge,
  beginEnrollment,
  confirmEnrollment,
  createLoginChallenge,
  disableTwoFactorIn,
  hasTwoFactor,
  regenerateRecoveryCodes,
  requiringOrgs,
  unusedRecoveryCodes,
  verifySecondFactor,
} from '../auth/two-factor.ts';
import { changePassword, verifyLogin } from '../commands/auth.ts';
import { avatarImageFor, setMyAvatar } from '../commands/avatar.ts';
import { requestPasswordReset, resetLinkState, resetPassword } from '../commands/password-reset.ts';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { withAppendTx } from '../db/tx.ts';
import { badRequest, conflict, unauthorized } from '../errors.ts';
import { buildMe } from '../queries/me.ts';
import { typed } from './util.ts';

/** `me` for a user without a request in hand (right after login or accept): the default organization applies. */
export async function meResponse(
  ctx: Ctx,
  userId: string,
  requestedOrg: string | null = null,
): Promise<MeResponse> {
  return buildMe(ctx, await sessionOfUser(ctx, userId), requestedOrg);
}

export function setSessionCookie(ctx: Ctx, reply: { setCookie: Function }, token: string, maxAgeSec: number) {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ctx.config.secureCookies,
    path: '/',
    maxAge: maxAgeSec,
  });
}

/** A password (and second factor) accepted: the session cookie, the audit entry of a super admin, and `me`. */
async function startSession(
  ctx: Ctx,
  reply: { setCookie: Function },
  userId: string,
  meta: { userAgent?: string | undefined; ip?: string | undefined },
  requestedOrg: string | null,
): Promise<MeResponse> {
  const s = await createSession(ctx, userId, meta);
  setSessionCookie(ctx, reply, s.token, s.maxAgeSec);
  const kind = await one<{ kind: string }>(ctx.pool, 'SELECT kind FROM users WHERE id=$1', [userId]);
  if (kind?.kind === 'super_admin')
    await ctx.store.append([
      {
        streamId: streamId.user(userId),
        event: {
          type: 'SuperAdminSignedIn',
          payload: {
            userId,
            meta: {
              ...(meta.ip ? { ip: meta.ip } : {}),
              ...(meta.userAgent ? { userAgent: meta.userAgent.slice(0, 400) } : {}),
            },
          },
        },
        actor: { kind: 'user', id: userId },
        scope: { orgId: null, projectId: null, audience: 'admin' },
      },
    ]);
  return meResponse(ctx, userId, requestedOrg);
}

export function authRoutes(ctx: Ctx) {
  return async (fastify: FastifyInstance) => {
    const app = typed(fastify);
    // Beyond the per-(IP, email) limit on login: one IP cannot walk through many accounts (credential stuffing),
    // and a stolen session cannot be used to guess the current password.
    const loginPerIp = new SlidingLimit(30, 60_000);
    const passwordPerAccount = new SlidingLimit(5, 60_000);
    // "Forgot password?": per address (no mail bombing), whether or not the address has an account.
    const resetPerEmail = new SlidingLimit(3, 60 * 60_000);
    const resetPerIp = new SlidingLimit(10, 60 * 60_000);

    app.post(
      '/api/auth/login',
      {
        schema: { body: LoginRequestSchema },
        config: {
          rateLimit: {
            max: 10,
            timeWindow: '1 minute',
            keyGenerator: (req: { ip: string; body?: unknown }) =>
              `${req.ip}|${String((req.body as { email?: string } | undefined)?.email ?? '').toLowerCase()}`,
          },
        },
      },
      async (req, reply) => {
        if (ctx.config.rateLimit) loginPerIp.hit(req.ip);
        const userId = await verifyLogin(ctx, req.body.email, req.body.password);
        const meta = { userAgent: req.headers['user-agent'], ip: req.ip };
        // Two-factor accounts get a challenge, not a session, until the code is right.
        if (await hasTwoFactor(ctx.pool, userId)) {
          const challenge = await createLoginChallenge(ctx, userId, meta);
          return {
            twoFactorRequired: true as const,
            challenge,
            methods: ['totp', 'recovery'] as Array<'totp' | 'recovery'>,
          };
        }
        return startSession(ctx, reply, userId, meta, requestedOrgId(req));
      },
    );

    // The second step of a two-factor login: a 6-digit code (or a recovery code) answers the challenge.
    app.post(
      '/api/auth/login/2fa',
      {
        schema: { body: Login2faRequestSchema },
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (req, reply) => {
        if (ctx.config.rateLimit) loginPerIp.hit(req.ip);
        const userId = await answerLoginChallenge(ctx, req.body.challenge, req.body.code);
        if (!userId) throw unauthorized('that code is not right, or the sign-in expired: sign in again');
        return startSession(
          ctx,
          reply,
          userId,
          { userAgent: req.headers['user-agent'], ip: req.ip },
          requestedOrgId(req),
        );
      },
    );

    app.post('/api/auth/logout', async (req, reply) => {
      const s = await requireSession(ctx, req);
      await deleteSession(ctx, s.sessionId);
      ctx.services.browser.closeSession(s.sessionId);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.post('/api/auth/password', { schema: { body: ChangePasswordRequestSchema } }, async (req) => {
      const s = await requireSession(ctx, req);
      if (ctx.config.rateLimit) passwordPerAccount.hit(s.user.id);
      await changePassword(ctx, s, req.body.current, req.body.new);
      return { ok: true };
    });

    // ---- forgot password: a one-time link by email. It never signs anyone in (the next sign-in asks for 2FA).
    app.post(
      '/api/auth/password-reset/request',
      {
        schema: { body: PasswordResetRequestSchema },
        config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      },
      async (req) => {
        if (ctx.config.rateLimit) {
          resetPerIp.hit(req.ip);
          resetPerEmail.hit(req.body.email.toLowerCase());
        }
        await requestPasswordReset(ctx, req.body.email, req.ip);
        return { ok: true };
      },
    );

    app.get(
      '/api/auth/password-reset/:token',
      {
        schema: { params: PasswordResetTokenParamsSchema },
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      },
      async (req) => resetLinkState(ctx, req.params.token),
    );

    app.post(
      '/api/auth/password-reset/confirm',
      {
        schema: { body: PasswordResetConfirmSchema },
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      },
      async (req) => {
        await resetPassword(ctx, req.body.token, req.body.password);
        return { ok: true };
      },
    );

    // ---- two-factor login (owner decision 7): set up, confirm, switch off, new recovery codes.
    // These work in a session that still has to set it up (a super admin's first sign-in).
    const mustPassword = async (userId: string, password: string) => {
      const u = await one(ctx.pool, 'SELECT password_hash FROM users WHERE id=$1', [userId]);
      if (!u || !(await verifyPassword(u.password_hash, password)))
        throw badRequest('wrong_password', 'the password is incorrect');
    };
    const twoFactorLimit = new SlidingLimit(8, 60_000);

    app.get('/api/auth/2fa', async (req) => {
      const s = await requireSession(ctx, req);
      return {
        ...s.twoFactor,
        recoveryCodesLeft: await unusedRecoveryCodes(ctx.pool, s.user.id),
        requiredBy: await requiringOrgs(ctx.pool, s.user.id),
      };
    });

    app.post('/api/auth/2fa/setup', { schema: { body: TwoFactorSetupRequestSchema } }, async (req) => {
      const s = await requireSession(ctx, req);
      if (ctx.config.rateLimit) twoFactorLimit.hit(s.user.id);
      await mustPassword(s.user.id, req.body.password);
      return beginEnrollment(ctx, s.user);
    });

    app.post('/api/auth/2fa/enable', { schema: { body: TwoFactorEnableRequestSchema } }, async (req) => {
      const s = await requireSession(ctx, req);
      if (ctx.config.rateLimit) twoFactorLimit.hit(s.user.id);
      return { recoveryCodes: await confirmEnrollment(ctx, s.user.id, req.body.code) };
    });

    app.post('/api/auth/2fa/disable', { schema: { body: TwoFactorConfirmRequestSchema } }, async (req) => {
      const s = await requireSession(ctx, req);
      if (ctx.config.rateLimit) twoFactorLimit.hit(s.user.id);
      if (s.twoFactor.required)
        throw conflict(
          'two_factor_required',
          s.user.kind === 'super_admin'
            ? 'platform accounts must keep two-factor login on'
            : 'an organization you belong to requires two-factor login',
        );
      await mustPassword(s.user.id, req.body.password);
      if (!(await verifySecondFactor(ctx, s.user.id, req.body.code)))
        throw badRequest('invalid_code', 'that code is not right');
      await withAppendTx(ctx.pool, (tx) =>
        disableTwoFactorIn(ctx, tx, s.user.id, s.user.id, 'user', { kind: 'user', id: s.user.id }),
      );
      return { ok: true };
    });

    app.post(
      '/api/auth/2fa/recovery-codes',
      { schema: { body: TwoFactorConfirmRequestSchema } },
      async (req) => {
        const s = await requireSession(ctx, req);
        if (ctx.config.rateLimit) twoFactorLimit.hit(s.user.id);
        await mustPassword(s.user.id, req.body.password);
        if (!(await verifySecondFactor(ctx, s.user.id, req.body.code)))
          throw badRequest('invalid_code', 'that code is not right');
        return { recoveryCodes: await regenerateRecoveryCodes(ctx, s.user.id) };
      },
    );

    // The signed-in user's own picture: a generated face, an uploaded (cropped, 256 px) image, or none.
    app.put('/api/me/avatar', { schema: { body: SetMyAvatarRequestSchema } }, async (req) => {
      const s = await requireSession(ctx, req);
      await setMyAvatar(ctx, s.user, req.body);
      return meResponse(ctx, s.user.id, requestedOrgId(req));
    });

    // An uploaded picture, for the people who may see that user (themselves, an administrator, project mates).
    app.get('/api/users/:id/avatar', { schema: { params: IdParamsSchema } }, async (req, reply) => {
      const s = await requireSession(ctx, req);
      const img = await avatarImageFor(ctx, s.user, req.params.id);
      if (!img) return reply.code(404).send({ error: { code: 'not_found', message: 'no picture' } });
      return reply
        .header('content-type', img.mime)
        .header('cache-control', 'private, max-age=86400')
        .header('etag', `"${img.id}"`)
        .header('x-content-type-options', 'nosniff')
        .send(img.data);
    });

    app.get('/api/auth/me', async (req) => {
      const s = await requireSession(ctx, req);
      return buildMe(ctx, s, requestedOrgId(req));
    });
  };
}
