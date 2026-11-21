import { randomBytes } from 'node:crypto';
import { streamId } from '@aom/shared';
import type { Ctx } from '../context.ts';
import { randomToken, sha256Hex } from '../crypto.ts';
import { exec, one, type Queryable, rows } from '../db/sql.ts';
import { type Tx, withAppendTx } from '../db/tx.ts';
import { badRequest, conflict } from '../errors.ts';
import { secondFactorFailedMail } from '../mail/templates.ts';
import { enforceLoginGuard, recordFailedSignIn } from './login-guard.ts';
import { claimSecurityNotice, sendSecurityMail } from './security-mail.ts';
import { hasEnvTwoFactorKey, legacyTwoFactorRefused, securitySetting } from './security-settings.ts';
import { generateTotpSecret, otpauthUri, totpStep, verifyTotp } from './totp.ts';
import {
  hashRecoveryCode,
  normalizeRecoveryCode,
  openSeed,
  recoveryCodeForms,
  sealSeed,
} from './two-factor-key.ts';

/**
 * Two-factor login (owner decision 7): TOTP for everyone, required for the super admin, optional for users and
 * enforceable per organization by its Owner. The seed and the hashed recovery codes live in operational tables
 * (`user_totp`, `user_recovery_codes`); the events only record that it was enabled, disabled or a code was used.
 * Seeds are sealed with the two-factor key and recovery codes keyed by it (`two-factor-key.ts`, R11); a value read with
 * an older key is re-sealed under the row lock.
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
export { normalizeRecoveryCode };
export const looksLikeRecoveryCode = (c: string): boolean => normalizeRecoveryCode(c).length === 10;

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
    [user.id, await sealSeed(ctx, user.id, secret), ctx.clock.now()],
  );
  return { secret, otpauthUri: otpauthUri({ issuer: PRODUCT, account: user.email, secret }) };
}

async function writeRecoveryCodes(ctx: Ctx, tx: Queryable, userId: string): Promise<string[]> {
  await exec(tx, 'DELETE FROM user_recovery_codes WHERE user_id=$1', [userId]);
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  for (const c of codes)
    await exec(tx, 'INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1,$2)', [
      userId,
      await hashRecoveryCode(ctx, c),
    ]);
  return codes;
}

/**
 * Opens the user's seed and, when an older key sealed it, re-seals it under the current key (the caller holds the row
 * lock). Null when no available key opens it (the key was lost): the code is then never right, and the user recovers
 * by email (R17-2).
 */
async function seedOf(ctx: Ctx, tx: Queryable, userId: string, blob: string): Promise<string | null> {
  return (await openSeedOf(ctx, tx, userId, blob))?.seed ?? null;
}

/** `seedOf` plus whether the seed is legacy; `reseal: false` leaves a legacy seed as it is (it is about to be refused). */
async function openSeedOf(
  ctx: Ctx,
  tx: Queryable,
  userId: string,
  blob: string,
  opts: { reseal?: boolean } = {},
): Promise<{ seed: string; legacy: boolean } | null> {
  let opened: { seed: string; reseal: boolean; legacy: boolean };
  try {
    opened = await openSeed(ctx, userId, blob);
  } catch (err) {
    ctx.log.warn({ userId, err: (err as Error).message }, 'two-factor seed opens with no available key');
    return null;
  }
  const { seed, reseal, legacy } = opened;
  if (reseal && (opts.reseal !== false || !legacy))
    await exec(tx, 'UPDATE user_totp SET secret_enc=$2 WHERE user_id=$1', [
      userId,
      await sealSeed(ctx, userId, seed),
    ]);
  return { seed, legacy };
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
    const seed = await seedOf(ctx, tx, userId, row.secret_enc);
    const step = seed === null ? null : verifyTotp(seed, code, ctx.clock.now());
    if (step === null)
      throw badRequest('invalid_code', 'that code is not right; check the time on your phone');
    await exec(tx, 'UPDATE user_totp SET confirmed_at=$2, last_used_step=$3 WHERE user_id=$1', [
      userId,
      ctx.clock.now(),
      step,
    ]);
    const codes = await writeRecoveryCodes(ctx, tx, userId);
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
    // never refuse with only the database key (boot refuses that combination; this is the second line)
    const refuseLegacy =
      hasEnvTwoFactorKey(ctx.config) && (await securitySetting(ctx, 'refuseLegacyTwoFactor', tx));
    if (looksLikeRecoveryCode(code)) {
      // Every stored form the code may have (each available key, and the legacy sha256); the used row is re-hashed
      // under the current key. With "Refuse legacy two-factor" on, only the env keys' forms count; a right legacy
      // code is refused with the way out, and stays unused.
      const forms = await recoveryCodeForms(ctx, code);
      const used = await exec(
        tx,
        `UPDATE user_recovery_codes SET used_at=$3, code_hash=$4
          WHERE ctid = (SELECT ctid FROM user_recovery_codes
                         WHERE user_id=$1 AND code_hash = ANY($2) AND used_at IS NULL LIMIT 1)`,
        [
          userId,
          refuseLegacy ? forms.current : [...forms.current, ...forms.legacy],
          ctx.clock.now(),
          await hashRecoveryCode(ctx, code),
        ],
      );
      if (!used) {
        if (
          refuseLegacy &&
          (await one(
            tx,
            'SELECT 1 FROM user_recovery_codes WHERE user_id=$1 AND code_hash = ANY($2) AND used_at IS NULL',
            [userId, forms.legacy],
          ))
        )
          throw legacyTwoFactorRefused('recovery');
        return null;
      }
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
    const opened = await openSeedOf(ctx, tx, userId, row.secret_enc, { reseal: !refuseLegacy });
    if (opened === null) return null;
    const step = verifyTotp(
      opened.seed,
      code,
      ctx.clock.now(),
      row.last_used_step === null ? null : Number(row.last_used_step),
    );
    if (step === null) return null;
    // a right code from an app set up with the database-stored key: refused with the way out (nothing is recorded)
    if (refuseLegacy && opened.legacy) throw legacyTwoFactorRefused('totp');
    await exec(tx, 'UPDATE user_totp SET last_used_step=$2 WHERE user_id=$1', [userId, step]);
    return 'totp';
  });
}

/** New recovery codes (the old ones stop working). The caller verified the password and a current code. */
export async function regenerateRecoveryCodes(ctx: Ctx, userId: string): Promise<string[]> {
  return withAppendTx(ctx.pool, async (tx) => {
    if (!(await hasTwoFactor(tx, userId))) throw badRequest('two_factor_off', 'two-factor login is not on');
    const codes = await writeRecoveryCodes(ctx, tx, userId);
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

/**
 * Switches two-factor off: the user themselves (when nothing requires it), or a reset by an Owner or super admin. The
 * notice to the user about an admin-initiated reset is sent by the caller (orgs workstream), so it is not mailed twice;
 * the console reset mails from `consoleResetSuperAdminPassword`.
 */
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

/**
 * Whether the account must have two-factor: super admin, a member of an organization that requires it, or anyone while
 * "Require two-factor login" is on (`enforced`, R28) unless all their memberships are simulation organizations.
 */
export async function twoFactorRequired(
  db: Queryable,
  userId: string,
  kind: string,
  enforced = false,
): Promise<boolean> {
  if (kind === 'super_admin') return true;
  if (
    await one(
      db,
      `SELECT 1 FROM org_members om JOIN organizations o ON o.id = om.org_id
        WHERE om.user_id=$1 AND om.status='active' AND o.require_two_factor AND o.status IN ('trial','active') LIMIT 1`,
      [userId],
    )
  )
    return true;
  if (!enforced) return false;
  const m = await one<{ any: boolean; real: boolean }>(
    db,
    `SELECT EXISTS (SELECT 1 FROM org_members WHERE user_id=$1 AND status='active') AS any,
            EXISTS (SELECT 1 FROM org_members om JOIN organizations o ON o.id = om.org_id
                     WHERE om.user_id=$1 AND om.status='active' AND NOT o.simulation) AS real`,
    [userId],
  );
  return !m?.any || !!m.real;
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
 * counts; after five the challenge is dead and the user signs in again). A wrong code on a live challenge is a
 * `second_factor` failure (R2) and mails the user that the password was right and the code was not (at most once an
 * hour).
 */
export async function answerLoginChallenge(
  ctx: Ctx,
  token: string,
  code: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined } = {},
): Promise<{ userId: string; factor: SecondFactor } | null> {
  const id = sha256Hex(token);
  const c = await one<{ user_id: string; expires_at: Date; attempts: number }>(
    ctx.pool,
    'UPDATE login_challenges SET attempts = attempts + 1 WHERE id=$1 RETURNING user_id, expires_at, attempts',
    [id],
  );
  if (!c || new Date(c.expires_at) <= ctx.clock.now() || c.attempts > MAX_CHALLENGE_ATTEMPTS) return null;
  // R2: the account and IP locks hold at the second step too, so challenges fetched before a lock cannot be spent on
  // guesses after it (429 `too_many_attempts`, the code is not checked).
  const owner = await one<{ email: string }>(ctx.pool, 'SELECT email FROM users WHERE id=$1', [c.user_id]);
  if (owner)
    await enforceLoginGuard(ctx, { email: owner.email, ip: meta.ip ?? null, userAgent: meta.userAgent });
  const factor = await verifySecondFactor(ctx, c.user_id, code);
  if (!factor) {
    await secondFactorFailed(ctx, c.user_id, meta);
    return null;
  }
  await exec(ctx.pool, 'DELETE FROM login_challenges WHERE id=$1', [id]);
  return { userId: c.user_id, factor };
}

const SECOND_FACTOR_NOTICE_MS = 3600_000;

async function secondFactorFailed(
  ctx: Ctx,
  userId: string,
  meta: { ip?: string | undefined; userAgent?: string | undefined },
): Promise<void> {
  const u = await one<{ email: string; display_name: string }>(
    ctx.pool,
    'SELECT email, display_name FROM users WHERE id=$1',
    [userId],
  );
  await recordFailedSignIn(ctx, {
    reason: 'second_factor',
    email: u?.email ?? null,
    userId,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  if (!u || !(await claimSecurityNotice(ctx, userId, 'second_factor_failed', SECOND_FACTOR_NOTICE_MS)))
    return;
  await sendSecurityMail(
    ctx,
    secondFactorFailedMail({
      to: u.email,
      name: u.display_name,
      when: ctx.clock.now(),
      ip: meta.ip ?? null,
      origin: ctx.config.publicOrigin,
    }),
  );
}
