import { createHmac, timingSafeEqual } from 'node:crypto';
import { currentTwoFactorKey, type TwoFactorKeyEnv } from './two-factor-key.ts';

/**
 * The session seal (release-readiness O5, design follow-up (2) of 1.10.0): `auth_sessions.mac` = HMAC-SHA256 over the
 * JSON `[id, userId, expiresAt ISO, secondFactorAt ISO | null, method]`. The key is HMAC(current two-factor key,
 * `auth-session-v1`), so it is never in the database and never `AOM_SECRET_KEY` itself (which the video worker holds).
 * A server without `AOM_TWO_FACTOR_KEY` derives it from `AOM_SECRET_KEY` or the database key, and then the seal adds
 * nothing against a database writer (SELF-HOSTING). Changing the two-factor key signs everyone out.
 *
 * Every write of a covered column computes the seal from values it wrote or read under a row lock, never from memory
 * and never with SQL `now()`.
 */
export interface SessionSealed {
  id: string;
  userId: string;
  expiresAt: Date;
  secondFactorAt: Date | null;
  method: string | null;
}

/** The derived key, memoized per config object (no database read per request when the key comes from the database). */
const keys = new WeakMap<object, Promise<Buffer>>();

export function sessionMacKey(env: TwoFactorKeyEnv): Promise<Buffer> {
  let k = keys.get(env.config);
  if (!k) {
    k = currentTwoFactorKey(env).then((key) =>
      createHmac('sha256', key.bytes).update('auth-session-v1').digest(),
    );
    // a failed read (the database is down) is not remembered
    k.catch(() => keys.delete(env.config));
    keys.set(env.config, k);
  }
  return k;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export async function sessionMac(env: TwoFactorKeyEnv, s: SessionSealed): Promise<string> {
  const payload = JSON.stringify([s.id, s.userId, iso(s.expiresAt), iso(s.secondFactorAt), s.method ?? null]);
  return createHmac('sha256', await sessionMacKey(env))
    .update(payload)
    .digest('base64url');
}

/** The covered columns of an `auth_sessions` row, plus its stored seal. */
export interface SealedRow {
  id: string;
  user_id: string;
  expires_at: Date | string;
  second_factor_at: Date | string | null;
  method: string | null;
  mac: string | null;
}

/** Whether a row's stored seal matches its covered columns (constant-time compare). */
export async function sessionMacValid(env: TwoFactorKeyEnv, row: SealedRow): Promise<boolean> {
  if (!row.mac) return false;
  const want = Buffer.from(
    await sessionMac(env, {
      id: row.id,
      userId: row.user_id,
      expiresAt: new Date(row.expires_at),
      secondFactorAt: row.second_factor_at ? new Date(row.second_factor_at) : null,
      method: row.method,
    }),
  );
  const have = Buffer.from(row.mac);
  return have.length === want.length && timingSafeEqual(have, want);
}
