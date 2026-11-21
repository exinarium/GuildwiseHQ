import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encryptSecret } from '../src/auth/secrets.ts';
import { generateTotpSecret, totpCode, totpStep } from '../src/auth/totp.ts';
import { beginEnrollment, confirmEnrollment, verifySecondFactor } from '../src/auth/two-factor.ts';
import { currentTwoFactorKey } from '../src/auth/two-factor-key.ts';
import { type Config, loadConfig, withConfig } from '../src/config.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

/**
 * The two-factor key (R11): new seeds are `t2:<kid>:...` and recovery codes `h2:<kid>:...`; a `v1:` seed is read and
 * re-sealed (with and without `AOM_SECRET_KEY`); switching from the derived key to `AOM_TWO_FACTOR_KEY` keeps seeds and
 * `h2` codes working (and re-seals); the boot refuses a 2FA key equal to `AOM_SECRET_KEY`.
 */
let t: TestApp;
let original: Config;
const EXPLICIT = 'an-explicit-two-factor-key-of-at-least-32-chars';
const SECRET = 'a-server-secret-key-for-the-tests-0123456789';

beforeAll(async () => {
  t = await createTestApp();
  original = t.app.ctx.config;
});
afterEach(() => {
  (t.app.ctx as { config: Config }).config = original;
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const setConfig = (changes: Partial<Config>) => {
  (t.app.ctx as { config: Config }).config = withConfig(original, changes);
};
const seedOf = async (userId: string) =>
  String((await q(`SELECT secret_enc FROM user_totp WHERE user_id=$1`, [userId]))[0]?.secret_enc);
let step = totpStep(new Date());
/** A code the server has not accepted yet (each step works once). */
const nextCode = (secret: string) => {
  const s = Math.max(step + 1, totpStep(t.clock.now()) - 1);
  while (s > totpStep(t.clock.now()) + 1) t.clock.advance(31_000);
  step = s;
  return totpCode(secret, s);
};

/** Enrols through the commands (no QR dance): returns the seed and the recovery codes. */
async function enrol(prefix: string) {
  const email = uniqueEmail(prefix);
  const id = await t.createUser(email);
  const { secret } = await beginEnrollment(t.app.ctx, { id, email });
  const codes = await confirmEnrollment(t.app.ctx, id, nextCode(secret));
  return { id, secret, codes };
}

describe('sealing', () => {
  it('writes t2 seeds and h2 recovery codes under the current key id', async () => {
    const kid = (await currentTwoFactorKey(t.app.ctx)).kid;
    const u = await enrol('t2');
    expect(await seedOf(u.id)).toMatch(new RegExp(`^t2:${kid}:[^:]+:[^:]+:[^:]+$`));
    const hashes = await q(`SELECT code_hash FROM user_recovery_codes WHERE user_id=$1`, [u.id]);
    expect(hashes).toHaveLength(10);
    for (const h of hashes) expect(String(h.code_hash)).toMatch(new RegExp(`^h2:${kid}:[0-9a-f]{64}$`));
    expect(await verifySecondFactor(t.app.ctx, u.id, nextCode(u.secret))).toBe('totp');
    expect(await verifySecondFactor(t.app.ctx, u.id, u.codes[0] as string)).toBe('recovery');
    expect(await verifySecondFactor(t.app.ctx, u.id, u.codes[0] as string)).toBeNull(); // used once
  });

  it('binds a seed to its user (AAD): a seed copied to another account does not open', async () => {
    const a = await enrol('aad-a');
    const b = await enrol('aad-b');
    await q(`UPDATE user_totp SET secret_enc=$2 WHERE user_id=$1`, [b.id, await seedOf(a.id)]);
    expect(await verifySecondFactor(t.app.ctx, b.id, nextCode(a.secret))).toBeNull();
  });
});

describe('v1 seeds from before 1.10.0', () => {
  for (const withSecret of [false, true])
    it(`are read and re-sealed under the current key (${withSecret ? 'with' : 'without'} AOM_SECRET_KEY)`, async () => {
      if (withSecret) setConfig({ secretKey: SECRET });
      const email = uniqueEmail('v1');
      const id = await t.createUser(email);
      const secret = generateTotpSecret();
      await q(
        `INSERT INTO user_totp (user_id, secret_enc, confirmed_at, created_at) VALUES ($1,$2,now(),now())`,
        [id, await encryptSecret(t.app.ctx, secret)],
      );
      expect(await seedOf(id)).toMatch(/^v1:/);
      expect(await verifySecondFactor(t.app.ctx, id, nextCode(secret))).toBe('totp');
      const kid = (await currentTwoFactorKey(t.app.ctx)).kid;
      expect(await seedOf(id)).toMatch(new RegExp(`^t2:${kid}:`));
      expect(await verifySecondFactor(t.app.ctx, id, nextCode(secret))).toBe('totp');
    });
});

describe('a key switch', () => {
  it('from the derived key to AOM_TWO_FACTOR_KEY keeps seeds and h2 codes working, and re-seals', async () => {
    const derived = (await currentTwoFactorKey(t.app.ctx)).kid;
    const u = await enrol('switch');
    expect(await seedOf(u.id)).toMatch(new RegExp(`^t2:${derived}:`));

    setConfig({ twoFactorKey: EXPLICIT });
    const explicit = (await currentTwoFactorKey(t.app.ctx)).kid;
    expect(explicit).not.toBe(derived);
    expect(await verifySecondFactor(t.app.ctx, u.id, nextCode(u.secret))).toBe('totp');
    expect(await seedOf(u.id)).toMatch(new RegExp(`^t2:${explicit}:`));
    // a recovery code hashed under the derived key still verifies, and is re-hashed under the new key on use
    expect(await verifySecondFactor(t.app.ctx, u.id, u.codes[1] as string)).toBe('recovery');
    const used = await q(
      `SELECT code_hash FROM user_recovery_codes WHERE user_id=$1 AND used_at IS NOT NULL`,
      [u.id],
    );
    expect(String(used[0]?.code_hash)).toMatch(new RegExp(`^h2:${explicit}:`));

    // and from a sign-in through the routes
    const login = await t.req('POST', '/api/auth/login', {
      body: {
        email: (await q(`SELECT email FROM users WHERE id=$1`, [u.id]))[0]?.email,
        password: 'correct-horse-battery',
      },
    });
    expect(login.body.twoFactorRequired).toBe(true);
    const r2 = await t.req('POST', '/api/auth/login/2fa', {
      body: { challenge: login.body.challenge, code: u.codes[2] },
    });
    expect(r2.status).toBe(200);
  });

  it('a seed no available key opens is a wrong code, not an error', async () => {
    const u = await enrol('lost');
    setConfig({ twoFactorKey: EXPLICIT });
    await q(`UPDATE user_totp SET secret_enc=$2 WHERE user_id=$1`, [
      u.id,
      (await seedOf(u.id)).replace(/^t2:[0-9a-f]{8}:/, 't2:deadbeef:'),
    ]);
    expect(await verifySecondFactor(t.app.ctx, u.id, nextCode(u.secret))).toBeNull();
  });
});

describe('configuration', () => {
  it('refuses a two-factor key equal to AOM_SECRET_KEY', () => {
    expect(() =>
      loadConfig({ ...process.env, AOM_SECRET_KEY: EXPLICIT, AOM_TWO_FACTOR_KEY: EXPLICIT }),
    ).toThrow(/AOM_TWO_FACTOR_KEY must differ from AOM_SECRET_KEY/);
    expect(() =>
      loadConfig({ ...process.env, AOM_SECRET_KEY: SECRET, AOM_TWO_FACTOR_KEY: EXPLICIT }),
    ).not.toThrow();
  });
});
