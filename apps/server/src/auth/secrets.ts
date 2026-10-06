import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Ctx } from '../context.ts';
import { one } from '../db/sql.ts';

/**
 * Encrypts small secrets (the TOTP seeds) at rest with AES-256-GCM. The key is `AOM_SECRET_KEY` (any string, hashed
 * to 32 bytes) when set, which keeps the seeds unreadable from a database dump alone. Without it a random key is
 * generated on first use and kept in `server_secrets` (documented in docs/DEPLOY.md: set the variable in production).
 */
async function key(ctx: Ctx): Promise<Buffer> {
  const env = ctx.config.secretKey;
  if (env) return createHash('sha256').update(env).digest();
  const row = await one<{ value: string }>(
    ctx.pool,
    `SELECT value FROM server_secrets WHERE name='totp_key'`,
  );
  if (row) return Buffer.from(row.value, 'base64url');
  await ctx.pool.query(
    `INSERT INTO server_secrets (name, value) VALUES ('totp_key', $1) ON CONFLICT (name) DO NOTHING`,
    [randomBytes(32).toString('base64url')],
  );
  const stored = await one<{ value: string }>(
    ctx.pool,
    `SELECT value FROM server_secrets WHERE name='totp_key'`,
  );
  return Buffer.from((stored as { value: string }).value, 'base64url');
}

export async function encryptSecret(ctx: Ctx, plain: string): Promise<string> {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', await key(ctx), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${enc.toString('base64url')}`;
}

export async function decryptSecret(ctx: Ctx, blob: string): Promise<string> {
  const [v, iv, tag, enc] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', await key(ctx), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}
