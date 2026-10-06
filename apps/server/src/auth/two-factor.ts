import { randomBytes } from 'node:crypto';
import { streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict } from '../errors.ts';
import { decryptSecret, encryptSecret } from './secrets.ts';
import { generateTotpSecret, otpauthUri, totpStep, verifyTotp } from './totp.ts';

/**
 * Two-factor login (owner decision 7): TOTP for everyone, required for the super admin, optional for users and
 * enforceable per organization by its Owner. The seed and the hashed recovery codes live in operational tables
 * (`user_totp`, `user_recovery_codes`); the events only record that it was enabled, disabled or a code was used.
 */

export const RECOVERY_CODE_COUNT = 10;
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789'; // no look-alikes (i l o u 0 1)
const PRODUCT = 'Guildwise HQ';

export function newRecoveryCode(): string {
  const b = randomBytes(10);
  let s = '';
  for (const x of b) s += RECOVERY_ALPHABET[x % RECOVERY_ALPHABET.length];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
export const normalizeRecoveryCode = (c: string): string => c.toLowerCase().replace(/[^a-z0-9]/g, '');
export const looksLikeRecoveryCode = (c: string): boolean => normalizeRecoveryCode(c).length === 10;
const hashRecovery = (c: string) => sha256Hex(normalizeRecoveryCode(c));

const userScope = (userId: string) => ({ orgId: null, projectId: null, audience: 'user', userId }) as const;
const SYSTEM = { kind: 'system', id: null } as const;

export async function hasTwoFactor(db: Queryable, userId: string): Promise<boolean> {
  return Boolean(
    await one(db, 'SELECT 1 FROM user_totp WHERE user_id=$1 AND confirmed_at IS NOT NULL', [userId]),
  );
}

/** Starts (or restarts) enrolment: a fresh secret that is not active until a code from it is confirmed. */
export async function beginEnrollment(
  ctx: Ctx,
  user: { id: string; email: string },
): Promise<{ secret: string; otpauthUri: string }> {
  if (await hasTwoFactor(ctx.pool, user.id))
    throw conflict('two_factor_enabled', 'two-factor login is already on');
  const secret = generateTotpSecret();
  await exec(
    ctx.pool,
    `INSERT INTO user_totp (user_id, secret_enc, confirmed_at, last_used_step, created_at)
     VALUES ($1,$2,NULL,NULL,$3)
     ON CONFLICT (user_id) DO UPDATE SET secret_enc=EXCLUDED.secret_enc, confirmed_at=NULL, last_used_step=NULL, created_at=EXCLUDED.created_at`,
    [user.id, await encryptSecret(ctx, secret), ctx.clock.now()],
  );
  return { secret, otpauthUri: otpauthUri({ issuer: PRODUCT, account: user.email, secret }) };
}

async function writeRecoveryCodes(tx: Queryable, userId: string): Promise<string[]> {
  await exec(tx, 'DELETE FROM user_recovery_codes WHERE user_id=$1', [userId]);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  for (const c of codes)
    await exec(tx, 'INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1,$2)', [
      userId,
      hashRecovery(c),
    ]);
  return codes;
}

/** Confirms the enrolment with a code from the app; returns the recovery codes (shown once). */
export async function confirmEnrollment(ctx: Ctx, userId: string, code: string): Promise<string[]> {
  return withAppendTx(ctx.pool, async (tx) => {
    const row = await one<{ secret_enc: string; confirmed_at: Date | null }>(
      tx,
      'SELECT secret_enc, confirmed_at FROM user_totp WHERE user_id=$1 FOR UPDATE',
      [userId],
    );
    if (!row) throw badRequest('no_enrolment', 'start the setup first');
    if (row.confirmed_at) throw conflict('two_factor_enabled', 'two-factor login is already on');
    const step = verifyTotp(await decryptSecret(ctx, row.secret_enc), code, ctx.clock.now());
    if (step === null)
      throw badRequest('invalid_code', 'that code is not right; check the time on your phone');
    await exec(tx, 'UPDATE user_totp SET confirmed_at=$2, last_used_step=$3 WHERE user_id=$1', [
      userId,
      ctx.clock.now(),
      step,
    ]);
    const codes = await writeRecoveryCodes(tx, userId);
    await ctx.store.append(
      [
        {
          streamId: streamId.user(userId),
          event: { type: 'TwoFactorEnabled', payload: { userId } },
          actor: { kind: 'user', id: userId },
          scope: userScope(userId),
        },
      ],
      { tx },
    );
    return codes;
  });
}

export type SecondFactor = 'totp' | 'recovery';

/**
 * Checks a code from the authenticator app or a recovery code. A TOTP code works once (its step is remembered); a
 * recovery code is consumed. Returns what matched, or null.
 */
export async function verifySecondFactor(
  ctx: Ctx,
  userId: string,
  code: string,
): Promise<SecondFactor | null> {
  return withAppendTx(ctx.pool, async (tx) => {
    const row = await one<{ secret_enc: string; last_used_step: string | null }>(
      tx,
      'SELECT secret_enc, last_used_step FROM user_totp WHERE user_id=$1 AND confirmed_at IS NOT NULL FOR UPDATE',
      [userId],
    );
    if (!row) return null;
    if (looksLikeRecoveryCode(code)) {
      const used = await exec(
        tx,
        `UPDATE user_recovery_codes SET used_at=$3 WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL`,
        [userId, hashRecovery(code), ctx.clock.now()],
      );
      if (!used) return null;
      await ctx.store.append(
        [
          {
            streamId: streamId.user(userId),
            event: { type: 'TwoFactorRecoveryCodeUsed', payload: { userId } },
            actor: { kind: 'user', id: userId },
            scope: userScope(userId),
          },
        ],
        { tx },
      );
      return 'recovery';
    }
    const step = verifyTotp(
      await decryptSecret(ctx, row.secret_enc),
      code,
      ctx.clock.now(),
      row.last_used_step === null ? null : Number(row.last_used_step),
    );
    if (step === null) return null;
    await exec(tx, 'UPDATE user_totp SET last_used_step=$2 WHERE user_id=$1', [userId, step]);
    return 'totp';
  });
}

/** New recovery codes (the old ones stop working). The caller verified the password and a current code. */
export async function regenerateRecoveryCodes(ctx: Ctx, userId: string): Promise<string[]> {
  return withAppendTx(ctx.pool, async (tx) => {
    if (!(await hasTwoFactor(tx, userId))) throw badRequest('two_factor_off', 'two-factor login is not on');
    const codes = await writeRecoveryCodes(tx, userId);
    await ctx.store.append(
      [
        {
          streamId: streamId.user(userId),
          event: { type: 'TwoFactorRecoveryCodesRegenerated', payload: { userId } },
          actor: { kind: 'user', id: userId },
          scope: userScope(userId),
        },
      ],
      { tx },
    );
    return codes;
  });
}

export async function unusedRecoveryCodes(db: Queryable, userId: string): Promise<number> {
  const r = await one<{ n: number }>(
    db,
    'SELECT count(*)::int AS n FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NULL',
    [userId],
  );
  return r?.n ?? 0;
}

/** Switches two-factor off: the user themselves (when nothing requires it), or a reset by an Owner or super admin. */
export async function disableTwoFactorIn(
  ctx: Ctx,
  tx: Tx,
  userId: string,
  by: string,
  reason: 'user' | 'reset',
  actor: { kind: 'user'; id: string } | typeof SYSTEM,
  meta?: { ip?: string; userAgent?: string },
): Promise<void> {
  await exec(tx, 'DELETE FROM user_totp WHERE user_id=$1', [userId]);
  await exec(tx, 'DELETE FROM user_recovery_codes WHERE user_id=$1', [userId]);
  await ctx.store.append(
    [
      {
        streamId: streamId.user(userId),
        event: { type: 'TwoFactorDisabled', payload: { userId, by, reason, ...(meta ? { meta } : {}) } },
        actor,
        scope: userScope(userId),
      },
    ],
    { tx },
  );
}

/** Whether the account must have two-factor: super admin, or a member of an organization that requires it. */
export async function twoFactorRequired(db: Queryable, userId: string, kind: string): Promise<boolean> {
  if (kind === 'super_admin') return true;
  return Boolean(
    await one(
      db,
      `SELECT 1 FROM org_members om JOIN organizations o ON o.id = om.org_id
        WHERE om.user_id=$1 AND om.status='active' AND o.require_two_factor AND o.status IN ('trial','active') LIMIT 1`,
      [userId],
    ),
  );
}

export async function requiringOrgs(
  db: Queryable,
  userId: string,
): Promise<Array<{ id: string; name: string }>> {
  return rows(
    db,
    `SELECT o.id, o.name FROM org_members om JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id=$1 AND om.status='active' AND o.require_two_factor ORDER BY o.name`,
    [userId],
  );
}

export { totpStep };

// --------------------------------------------------------------------------------------- the login challenge

const CHALLENGE_TTL_MS = 5 * 60_000;
export const MAX_CHALLENGE_ATTEMPTS = 5;

/** A password-verified login waiting for its second factor: the token goes to the browser, a hash stays here. */
export async function createLoginChallenge(
  ctx: Ctx,
  userId: string,
  meta: { userAgent?: string | undefined; ip?: string | undefined } = {},
): Promise<string> {
  const token = randomToken(32);
  const now = ctx.clock.now();
  await exec(
    ctx.pool,
    `INSERT INTO login_challenges (id, user_id, created_at, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      sha256Hex(token),
      userId,
      now,
      new Date(now.getTime() + CHALLENGE_TTL_MS),
      meta.userAgent ?? null,
      meta.ip ?? null,
    ],
  );
  await exec(ctx.pool, 'DELETE FROM login_challenges WHERE expires_at < $1', [
    new Date(now.getTime() - 3600_000),
  ]);
  return token;
}

/**
 * Answers a challenge: the user id when the code is right (the challenge is spent), null when it is wrong (the attempt
 * counts; after five the challenge is dead and the user signs in again).
 */
export async function answerLoginChallenge(ctx: Ctx, token: string, code: string): Promise<string | null> {
  const id = sha256Hex(token);
  const c = await one<{ user_id: string; expires_at: Date; attempts: number }>(
    ctx.pool,
    'UPDATE login_challenges SET attempts = attempts + 1 WHERE id=$1 RETURNING user_id, expires_at, attempts',
    [id],
  );
  if (!c || new Date(c.expires_at) <= ctx.clock.now() || c.attempts > MAX_CHALLENGE_ATTEMPTS) return null;
  const ok = await verifySecondFactor(ctx, c.user_id, code);
  if (!ok) return null;
  await exec(ctx.pool, 'DELETE FROM login_challenges WHERE id=$1', [id]);
  return c.user_id;
}
