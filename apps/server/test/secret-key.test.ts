import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../src/auth/secrets.ts';
import { loadConfig } from '../src/config.ts';
import { createTestApp, type TestApp } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';

describe('AOM_SECRET_KEY in production', () => {
  it('refuses to start in production without it', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/AOM_SECRET_KEY is required in production/);
    expect(() => loadConfig({ NODE_ENV: 'production', AOM_SECRET_KEY: '' })).toThrow(/AOM_SECRET_KEY/);
  });

  it('starts in production with it, and without it outside production', () => {
    expect(loadConfig({ NODE_ENV: 'production', AOM_SECRET_KEY: 'x'.repeat(32) }).secretKey).toBe(
      'x'.repeat(32),
    );
    expect(loadConfig({}).secretKey).toBeUndefined();
    expect(loadConfig({ NODE_ENV: 'test' }).secretKey).toBeUndefined();
  });

  it('still rejects a key that is too short', () => {
    expect(() => loadConfig({ NODE_ENV: 'production', AOM_SECRET_KEY: 'short' })).toThrow();
  });
});

describe('switching from the database key to AOM_SECRET_KEY', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.close();
    await closeAdminPool();
  });

  it('keeps reading what the database key sealed, and seals new values with the variable', async () => {
    const ctx = t.app.ctx;
    const before = await encryptSecret(ctx, 'JBSWY3DPEHPK3PXP'); // sealed with the key in the database
    (ctx.config as { secretKey: string | undefined }).secretKey = 'k'.repeat(40);
    try {
      expect(await decryptSecret(ctx, before)).toBe('JBSWY3DPEHPK3PXP');
      const after = await encryptSecret(ctx, 'NEWSEED');
      expect(await decryptSecret(ctx, after)).toBe('NEWSEED');
      // the new value is NOT readable with the database key alone
      (ctx.config as { secretKey: string | undefined }).secretKey = undefined;
      await expect(decryptSecret(ctx, after)).rejects.toThrow();
    } finally {
      (ctx.config as { secretKey: string | undefined }).secretKey = undefined;
    }
  });
});
