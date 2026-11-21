import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';
import { decryptSecret } from './secrets.ts';

/**
 * The two-factor key (R11 [rv 4]). Seeds are sealed as `t2:<kid>:<iv>:<tag>:<ct>` (AES-256-GCM, AAD = the user id), and
 * recovery codes are stored as `h2:<kid>:<hmac>`. `kid` = the first 8 hex of sha256(`kid|` + key bytes), so a stored
 * value names the key that made it.
 *
 * - The current key is `AOM_TWO_FACTOR_KEY`; without it, HMAC(the `secrets.ts` key, `totp-v2`), where the secrets key
 *   is `AOM_SECRET_KEY` or, without that, the database key (`server_secrets.totp_key`).
 * - On read every available key is a candidate: the explicit key, the one derived from `AOM_SECRET_KEY`, and the one
 *   derived from the database key (when that row exists; reading never creates it). A `v1:` blob (before 1.10.0) opens
 *   with the legacy `decryptSecret`.
 * - Anything read with a key that is not the current one is re-sealed by the caller under the row lock. So setting the
 *   key later, after the production warning, locks nobody out.
 */

/** Only what the key needs: the boot data migration has no full `Ctx`. */
export interface TwoFactorKeyEnv {
  pool: Pool;
  config: { secretKey?: string | undefined; twoFactorKey?: string | undefined };
}

interface Key {
  kid: string;
  bytes: Buffer;
  source: 'explicit' | 'secret' | 'db';
}

const kidOf = (bytes: Buffer): string =>
  createHash('sha256')
    .update(Buffer.concat([Buffer.from('kid|'), bytes]))
    .digest('hex')
    .slice(0, 8);
const key = (bytes: Buffer, source: Key['source']): Key => ({ kid: kidOf(bytes), bytes, source });
const derive = (base: Buffer): Buffer => createHmac('sha256', base).update('totp-v2').digest();
const sha = (s: string): Buffer => createHash('sha256').update(s).digest();

async function storedDbKey(env: TwoFactorKeyEnv): Promise<Buffer | null> {
  const row = await one<{ value: string }>(
    env.pool,
    `SELECT value FROM server_secrets WHERE name='totp_key'`,
  );
  return row ? Buffer.from(row.value, 'base64url') : null;
}

/** The database key, created on first use (what `secrets.ts` does for a server without `AOM_SECRET_KEY`). */
async function ensureDbKey(env: TwoFactorKeyEnv): Promise<Buffer> {
  const have = await storedDbKey(env);
  if (have) return have;
  await env.pool.query(
    `INSERT INTO server_secrets (name, value) VALUES ('totp_key', $1) ON CONFLICT (name) DO NOTHING`,
    [randomBytes(32).toString('base64url')],
  );
  return (await storedDbKey(env)) as Buffer;
}

/** The key new seeds and codes are sealed with. */
export async function currentTwoFactorKey(env: TwoFactorKeyEnv): Promise<Key> {
  if (env.config.twoFactorKey) return key(sha(env.config.twoFactorKey), 'explicit');
  if (env.config.secretKey) return key(derive(sha(env.config.secretKey)), 'secret');
  return key(derive(await ensureDbKey(env)), 'db');
}

/** Every key a stored value may have been sealed with: explicit, derived from `AOM_SECRET_KEY`, derived from the DB key. */
async function candidateKeys(env: TwoFactorKeyEnv): Promise<Key[]> {
  const out: Key[] = [];
  if (env.config.twoFactorKey) out.push(key(sha(env.config.twoFactorKey), 'explicit'));
  if (env.config.secretKey) out.push(key(derive(sha(env.config.secretKey)), 'secret'));
  const db = await storedDbKey(env);
  if (db) out.push(key(derive(db), 'db'));
  else if (!env.config.twoFactorKey && !env.config.secretKey)
    out.push(key(derive(await ensureDbKey(env)), 'db'));
  return out;
}

/** Seals a TOTP seed for `userId` under the current key. */
export async function sealSeed(env: TwoFactorKeyEnv, userId: string, seed: string): Promise<string> {
  const k = await currentTwoFactorKey(env);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k.bytes, iv);
  c.setAAD(Buffer.from(userId, 'utf8'));
  const ct = Buffer.concat([c.update(seed, 'utf8'), c.final()]);
  return `t2:${k.kid}:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

/**
 * Opens a stored seed. `reseal` is true when it was not sealed with the current key (a `v1:` blob, or a `t2:` blob of an
 * older key): the caller writes `sealSeed(...)` back under its row lock. Throws when no available key opens it.
 */
export async function openSeed(
  env: TwoFactorKeyEnv,
  userId: string,
  blob: string,
): Promise<{ seed: string; reseal: boolean; legacy: boolean }> {
  if (blob.startsWith('v1:')) {
    // `decryptSecret` reads `ctx.pool` and `ctx.config.secretKey` only.
    const seed = await decryptSecret(env as unknown as Ctx, blob);
    return { seed, reseal: true, legacy: true };
  }
  const [v, kid, iv, tag, ct] = blob.split(':');
  if (v !== 't2' || !kid || !iv || !tag || !ct) throw new Error('unknown two-factor seed format');
  const current = await currentTwoFactorKey(env);
  const k = (await candidateKeys(env)).find((c) => c.kid === kid);
  if (!k) throw new Error(`no available key opens this two-factor seed (key ${kid})`);
  const d = createDecipheriv('aes-256-gcm', k.bytes, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(userId, 'utf8'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  const seed = Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
  // legacy (what "Refuse legacy two-factor" refuses): sealed with the database-stored key
  return { seed, reseal: k.kid !== current.kid, legacy: k.source === 'db' };
}

/** Whether a stored seed is already sealed with the current key (nothing to re-seal). */
export async function sealedWithCurrent(env: TwoFactorKeyEnv, blob: string): Promise<boolean> {
  return blob.startsWith(`t2:${(await currentTwoFactorKey(env)).kid}:`);
}

export const normalizeRecoveryCode = (c: string): string => c.toLowerCase().replace(/[^a-z0-9]/g, '');

const hmacCode = (k: Key, code: string) =>
  `h2:${k.kid}:${createHmac('sha256', k.bytes)
    .update(`recovery|${normalizeRecoveryCode(code)}`)
    .digest('hex')}`;

/** How a new recovery code is stored: `h2:<kid>:<hmac>` under the current key. */
export async function hashRecoveryCode(env: TwoFactorKeyEnv, code: string): Promise<string> {
  return hmacCode(await currentTwoFactorKey(env), code);
}

/** Every stored form this code may have: `h2` under each available key, plus the legacy sha256 (before 1.10.0). */
export async function recoveryCodeCandidates(env: TwoFactorKeyEnv, code: string): Promise<string[]> {
  const { current, legacy } = await recoveryCodeForms(env, code);
  return [...current, ...legacy];
}

/**
 * The stored forms of a code, split: `legacy` = the sha256 of before 1.10.0 and the `h2` under the database-stored key
 * (what "Refuse legacy two-factor" refuses); `current` = the `h2` under the env keys.
 */
export async function recoveryCodeForms(
  env: TwoFactorKeyEnv,
  code: string,
): Promise<{ current: string[]; legacy: string[] }> {
  const keys = await candidateKeys(env);
  return {
    current: keys.filter((k) => k.source !== 'db').map((k) => hmacCode(k, code)),
    legacy: [
      ...keys.filter((k) => k.source === 'db').map((k) => hmacCode(k, code)),
      createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex'),
    ],
  };
}
