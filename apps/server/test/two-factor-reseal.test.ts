import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/auth/secrets.ts';
import { generateTotpSecret, totpCode, totpStep } from '../src/auth/totp.ts';
import { currentTwoFactorKey } from '../src/auth/two-factor-key.ts';
import {
  DATA_MIGRATIONS,
  migrateTwoFactorReseal,
  TWO_FACTOR_RESEAL_MIGRATION,
} from '../src/data-migrations/index.ts';
import type { DataMigrationEnv } from '../src/data-migrations/orgs.ts';
import type { PgEventStore } from '../src/eventstore/pg-event-store.ts';
import { createTestApp, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

/**
 * `two-factor-reseal` (R11, R29): on a populated database with `v1:` seeds and legacy recovery codes, the boot data
 * migration re-seals every seed under the current key; afterwards every user still signs in with the same app and the
 * same codes; a seed no key opens is left as it is and logged (its user id, never the seed); a second run does nothing.
 */
let t: TestApp;
const logs: string[] = [];

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const env = (): DataMigrationEnv => ({
  pool: t.app.ctx.pool,
  store: t.app.ctx.store as PgEventStore,
  clock: t.clock,
  log: (m) => logs.push(m),
  secretKey: t.app.ctx.config.secretKey,
  twoFactorKey: t.app.ctx.config.twoFactorKey,
});

const recovery = () => {
  const raw = randomBytes(5).toString('hex');
  return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, hash: createHash('sha256').update(raw).digest('hex') };
};

/** A user of an older release: a `v1:` seed and legacy sha256 recovery codes, written straight into the tables. */
async function legacyUser(prefix: string) {
  const email = uniqueEmail(prefix);
  const id = await t.createUser(email);
  const secret = generateTotpSecret();
  await q(
    `INSERT INTO user_totp (user_id, secret_enc, confirmed_at, created_at) VALUES ($1,$2,now(),now())`,
    [id, await encryptSecret(t.app.ctx, secret)],
  );
  await q(`UPDATE users SET two_factor_enabled=true WHERE id=$1`, [id]);
  const codes = [recovery(), recovery()];
  for (const c of codes)
    await q(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1,$2)`, [id, c.hash]);
  return { id, email, secret, codes };
}

const signIn = async (email: string, code: string) => {
  const r1 = await t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  expect(r1.body.twoFactorRequired).toBe(true);
  return t.req('POST', '/api/auth/login/2fa', { body: { challenge: r1.body.challenge, code } });
};

describe('two-factor-reseal', () => {
  it('is registered as a boot data migration', () => {
    expect(DATA_MIGRATIONS.map((m) => m.name)).toContain('two-factor-reseal-2026-11');
  });

  it('re-seals every v1 seed; users keep signing in with the same app and codes; unreadable seeds are left and logged', async () => {
    const users = [await legacyUser('old-a'), await legacyUser('old-b'), await legacyUser('old-c')];
    const broken = await legacyUser('old-broken');
    const brokenBlob = 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA';
    await q(`UPDATE user_totp SET secret_enc=$2 WHERE user_id=$1`, [broken.id, brokenBlob]);

    const report = await migrateTwoFactorReseal(env());
    expect(report).toMatchObject({ resealed: 3, unreadable: [broken.id] });
    const kid = (await currentTwoFactorKey(t.app.ctx)).kid;
    for (const u of users) {
      const blob = String(
        (await q(`SELECT secret_enc FROM user_totp WHERE user_id=$1`, [u.id]))[0]?.secret_enc,
      );
      expect(blob).toMatch(new RegExp(`^t2:${kid}:`));
      expect(blob).not.toContain(u.secret);
    }
    expect((await q(`SELECT secret_enc FROM user_totp WHERE user_id=$1`, [broken.id]))[0]?.secret_enc).toBe(
      brokenBlob,
    );
    expect(logs.some((l) => l.includes(broken.id))).toBe(true);
    expect(logs.join('\n')).not.toContain(users[0]?.secret as string);
    const summary = (
      await q(`SELECT summary FROM data_migrations WHERE name=$1`, [TWO_FACTOR_RESEAL_MIGRATION])
    )[0]?.summary;
    expect(summary).toMatchObject({ resealed: 3, current: 0, unreadable: [broken.id] });

    // the same authenticator app
    const [a, b, c] = users as [(typeof users)[0], (typeof users)[0], (typeof users)[0]];
    expect((await signIn(a.email, totpCode(a.secret, totpStep(t.clock.now())))).status).toBe(200);
    // the same legacy recovery codes, re-hashed to h2 on use
    expect((await signIn(b.email, b.codes[0]?.code as string)).status).toBe(200);
    const used = await q(
      `SELECT code_hash FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NOT NULL`,
      [b.id],
    );
    expect(String(used[0]?.code_hash)).toMatch(/^h2:/);
    expect((await signIn(c.email, c.codes[1]?.code as string)).status).toBe(200);

    // idempotent: recorded once, a second run does nothing
    expect(await migrateTwoFactorReseal(env())).toBeNull();
  });

  it('skips seeds already sealed with the current key (a fresh run on a database already re-sealed)', async () => {
    await q(`DELETE FROM data_migrations WHERE name=$1`, [TWO_FACTOR_RESEAL_MIGRATION]);
    await q(`DELETE FROM user_totp WHERE secret_enc LIKE 'v1:%'`);
    const report = await migrateTwoFactorReseal(env());
    expect(report?.resealed).toBe(0);
    expect(report?.current).toBeGreaterThanOrEqual(3);
  });

  it('does nothing on an empty database', async () => {
    await q(`DELETE FROM data_migrations WHERE name=$1`, [TWO_FACTOR_RESEAL_MIGRATION]);
    await q(`DELETE FROM user_totp`);
    expect(await migrateTwoFactorReseal(env())).toEqual({ resealed: 0, current: 0, unreadable: [] });
  });
});
