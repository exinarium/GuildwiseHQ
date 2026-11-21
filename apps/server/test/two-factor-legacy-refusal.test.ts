import { createHash } from 'node:crypto';
import { LEGACY_TWO_FACTOR_REFUSED, SETTING_LOCKED, TWO_FACTOR_KEY_REQUIRED } from '@aom/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  invalidateSecuritySettings,
  legacyTwoFactorAtBoot,
  securitySettingsView,
  setSecuritySetting,
} from '../src/auth/security-settings.ts';
import { totpCode, totpStep } from '../src/auth/totp.ts';
import { beginEnrollment, confirmEnrollment, verifySecondFactor } from '../src/auth/two-factor.ts';
import { normalizeRecoveryCode } from '../src/auth/two-factor-key.ts';
import { type Config, withConfig } from '../src/config.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

/**
 * "Refuse legacy two-factor" (owner 2026-11-21: Cloud only, locked). Off in core: recovery codes stored before 1.10.0
 * (plain sha256) and seeds sealed with the database-stored key keep working. On (here: locked, as Cloud does): a right
 * legacy factor is refused with `legacy_two_factor_refused` and the way out, nothing is consumed or re-sealed; factors
 * made under the env key keep working. Sign-in, password reset and step-up all check through `verifySecondFactor`.
 */
let t: TestApp;
let original: Config;
const EXPLICIT = 'an-explicit-two-factor-key-of-at-least-32-chars';

beforeAll(async () => {
  t = await createTestApp();
  original = t.app.ctx.config;
});
afterEach(async () => {
  (t.app.ctx as { config: Config }).config = original;
  delete t.app.ctx.ext.lockedSecuritySettings.refuseLegacyTwoFactor;
  await q(`DELETE FROM platform_settings WHERE key='security.refuse_legacy_two_factor'`);
  invalidateSecuritySettings(t.app.ctx);
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const setConfig = (changes: Partial<Config>) => {
  (t.app.ctx as { config: Config }).config = withConfig(original, changes);
};
const lockOn = () => {
  t.app.ctx.ext.lockedSecuritySettings.refuseLegacyTwoFactor = true;
  invalidateSecuritySettings(t.app.ctx);
};
const seedOf = async (userId: string) =>
  String((await q(`SELECT secret_enc FROM user_totp WHERE user_id=$1`, [userId]))[0]?.secret_enc);
let step = totpStep(new Date());
const nextCode = (secret: string) => {
  const s = Math.max(step + 1, totpStep(t.clock.now()) - 1);
  while (s > totpStep(t.clock.now()) + 1) t.clock.advance(31_000);
  step = s;
  return totpCode(secret, s);
};

/** Enrols under whatever key is current; `legacyCode` turns one recovery code into the sha256 form of before 1.10.0. */
async function enrol(prefix: string, opts: { legacyCode?: boolean } = {}) {
  const email = uniqueEmail(prefix);
  const id = await t.createUser(email);
  const { secret } = await beginEnrollment(t.app.ctx, { id, email });
  const codes = await confirmEnrollment(t.app.ctx, id, nextCode(secret));
  const legacy = codes[9] as string;
  if (opts.legacyCode) {
    await q(`DELETE FROM user_recovery_codes WHERE user_id=$1`, [id]);
    await q(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1,$2)`, [
      id,
      createHash('sha256').update(normalizeRecoveryCode(legacy)).digest('hex'),
    ]);
  }
  return { id, secret, codes, legacy };
}

const refusal = async (p: Promise<unknown>) => {
  const err = (await p.then(
    () => null,
    (e: unknown) => e,
  )) as { status?: number; code?: string; message?: string; details?: unknown } | null;
  return err;
};

describe('refuse legacy two-factor: off (core default)', () => {
  it('is off, unlocked, by default', async () => {
    expect((await securitySettingsView(t.app.ctx)).refuseLegacyTwoFactor).toEqual({
      value: false,
      locked: false,
      source: 'default',
    });
  });

  it('a legacy recovery code and a seed of the database-stored key keep working', async () => {
    const u = await enrol('legacy-off', { legacyCode: true }); // sealed with the database key (no env key here)
    setConfig({ twoFactorKey: EXPLICIT });
    expect(await verifySecondFactor(t.app.ctx, u.id, u.legacy)).toBe('recovery');
    expect(await verifySecondFactor(t.app.ctx, u.id, nextCode(u.secret))).toBe('totp');
  });
});

describe('refuse legacy two-factor: on (locked, as Guildwise Cloud does)', () => {
  it('refuses a right code from a seed of the database-stored key, with the way out; nothing is re-sealed', async () => {
    const u = await enrol('legacy-totp');
    const before = await seedOf(u.id);
    setConfig({ twoFactorKey: EXPLICIT });
    lockOn();
    const err = await refusal(verifySecondFactor(t.app.ctx, u.id, nextCode(u.secret)));
    expect(err).toMatchObject({ status: 403, code: LEGACY_TWO_FACTOR_REFUSED });
    expect(err?.message).toContain('Reset two-factor login by email');
    expect(err?.details).toEqual({ reenrol: '/api/auth/2fa/recovery/start' });
    expect(await seedOf(u.id)).toBe(before);
    // a wrong code is just wrong
    expect(await verifySecondFactor(t.app.ctx, u.id, '000000')).toBeNull();
  });

  it('refuses a right legacy recovery code and leaves it unused; a wrong one is just wrong', async () => {
    setConfig({ twoFactorKey: EXPLICIT });
    const u = await enrol('legacy-rec', { legacyCode: true });
    lockOn();
    const err = await refusal(verifySecondFactor(t.app.ctx, u.id, u.legacy));
    expect(err).toMatchObject({ status: 403, code: LEGACY_TWO_FACTOR_REFUSED });
    expect(err?.message).toContain('made before Guildwise 1.10.0');
    const rows = await q(`SELECT used_at FROM user_recovery_codes WHERE user_id=$1`, [u.id]);
    expect(rows.map((r) => r.used_at)).toEqual([null]);
    expect(await verifySecondFactor(t.app.ctx, u.id, 'aaaa-bbbb-cccc')).toBeNull();
  });

  it('accepts factors made under the env key', async () => {
    setConfig({ twoFactorKey: EXPLICIT });
    const u = await enrol('legacy-new');
    lockOn();
    expect(await verifySecondFactor(t.app.ctx, u.id, nextCode(u.secret))).toBe('totp');
    expect(await verifySecondFactor(t.app.ctx, u.id, u.codes[0] as string)).toBe('recovery');
  });

  it('a lock shows as locked and refuses a change', async () => {
    const root = await t.superAdminSession(); // signed in before the lock (its seed is under the database key)
    lockOn();
    expect((await securitySettingsView(t.app.ctx)).refuseLegacyTwoFactor).toEqual({
      value: true,
      locked: true,
      source: 'locked',
    });
    const err = await refusal(setSecuritySetting(t.app.ctx, { id: root.id }, 'refuseLegacyTwoFactor', false));
    expect(err).toMatchObject({ code: SETTING_LOCKED });
  });

  it('a platform admin turns it on only with an env two-factor key (else everyone would be refused)', async () => {
    setConfig({ twoFactorKey: undefined, secretKey: undefined });
    const err = await refusal(
      setSecuritySetting(t.app.ctx, { id: (await t.superAdminSession()).id }, 'refuseLegacyTwoFactor', true),
    );
    expect(err).toMatchObject({ status: 409, code: TWO_FACTOR_KEY_REQUIRED });
    setConfig({ twoFactorKey: EXPLICIT });
    expect(
      (
        await setSecuritySetting(
          t.app.ctx,
          { id: (await t.superAdminSession()).id },
          'refuseLegacyTwoFactor',
          true,
        )
      ).changed,
    ).toBe(true);
    expect((await securitySettingsView(t.app.ctx)).refuseLegacyTwoFactor.value).toBe(true);
  });
});

describe('refuse legacy two-factor never runs with every two-factor login refused (boot)', () => {
  const noKey = () => setConfig({ twoFactorKey: undefined, secretKey: undefined });

  it('boot refuses with the lock on and no key outside the database', async () => {
    noKey();
    lockOn();
    await expect(legacyTwoFactorAtBoot(t.app.ctx)).rejects.toThrow(
      /Refuse legacy two-factor" is on \(locked by the hosting platform\).*Set AOM_TWO_FACTOR_KEY/,
    );
  });

  it('boot refuses with the env default on and no key', async () => {
    setConfig({
      twoFactorKey: undefined,
      secretKey: undefined,
      securityDefaults: { ...original.securityDefaults, refuseLegacyTwoFactor: true },
    });
    invalidateSecuritySettings(t.app.ctx);
    await expect(legacyTwoFactorAtBoot(t.app.ctx)).rejects.toThrow(/AOM_REFUSE_LEGACY_TWO_FACTOR/);
  });

  it('boot refuses with the platform setting stored on after the key was removed', async () => {
    setConfig({ twoFactorKey: EXPLICIT });
    await setSecuritySetting(
      t.app.ctx,
      { id: (await t.superAdminSession()).id },
      'refuseLegacyTwoFactor',
      true,
    );
    noKey();
    invalidateSecuritySettings(t.app.ctx);
    await expect(legacyTwoFactorAtBoot(t.app.ctx)).rejects.toThrow(
      /platform setting.*or turn the setting off/,
    );
    // and if it ran anyway, nobody is refused: with only the database key the setting does not apply
    const u = await enrol('nokey');
    expect(await verifySecondFactor(t.app.ctx, u.id, nextCode(u.secret))).toBe('totp');
  });

  it('boot goes on with a key, or with the setting off', async () => {
    noKey();
    await expect(legacyTwoFactorAtBoot(t.app.ctx)).resolves.toBeUndefined();
    setConfig({ twoFactorKey: EXPLICIT });
    lockOn();
    await expect(legacyTwoFactorAtBoot(t.app.ctx)).resolves.toBeUndefined();
  });
});
