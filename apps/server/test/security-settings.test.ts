import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { screenAddress } from '../src/auth/address-policy.ts';
import { securitySetting, setSecuritySetting } from '../src/auth/security-settings.ts';
import { createExtensionHost, type ServerExtension } from '../src/extension.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { releaseDirWith, TEST_PUBKEY } from './helpers/signed-release.ts';

/**
 * Security settings (R27, R28): "Only signed runners" and "Require two-factor login". Off by default; the env default;
 * the platform toggle (super admin, step-up, audited); a hosted lock that neither the API nor the config can undo; the
 * confirmation before signed runners unlink workstations. Plus the `screenAddress` extension point next to the lock.
 */
let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
afterAll(closeAdminPool);

const HOSTED: ServerExtension = {
  name: 'hosted-test',
  lockedSecuritySettings: { requireSignedRunners: true, enforceTwoFactor: true },
};

async function pairWorkstation(app: TestApp, userId: string): Promise<string> {
  const workstationId = randomUUID();
  await app.app.ctx.store.append([
    {
      streamId: streamId.workstation(workstationId),
      event: {
        type: 'WorkstationPaired',
        payload: {
          workstationId,
          userId,
          name: 'laptop',
          platform: 'linux',
          hostname: 'laptop',
          runnerVersion: '0.1.0',
          tokenHash: randomUUID(),
        },
      },
      actor: { kind: 'user', id: userId },
      scope: { orgId: null, projectId: null, audience: 'user', userId },
    },
  ]);
  return workstationId;
}

describe('security settings', () => {
  it('are off by default, with the counts', async () => {
    t = await createTestApp();
    const root = await t.superAdminSession();
    await t.createUser(uniqueEmail('no2fa'));
    const r = await t.req('GET', '/api/platform/security-settings', { cookie: root.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      requireSignedRunners: { value: false, locked: false, source: 'default' },
      enforceTwoFactor: { value: false, locked: false, source: 'default' },
      refuseLegacyTwoFactor: { value: false, locked: false, source: 'default' },
      unsignedWorkstations: 0,
      usersWithout2fa: 1,
    });
  });

  it('take the env default, and the platform setting wins over it', async () => {
    t = await createTestApp({ env: { AOM_REQUIRE_SIGNED_RUNNERS: 'true', AOM_ENFORCE_TWO_FACTOR: 'true' } });
    const root = await t.superAdminSession();
    const r = await t.req('GET', '/api/platform/security-settings', { cookie: root.cookie });
    expect(r.body.requireSignedRunners).toEqual({ value: true, locked: false, source: 'env' });
    expect(r.body.enforceTwoFactor).toEqual({ value: true, locked: false, source: 'env' });
    const off = await t.req('PATCH', '/api/platform/security-settings', {
      cookie: root.cookie,
      body: { enforceTwoFactor: false },
    });
    expect(off.status).toBe(200);
    expect(off.body.enforceTwoFactor).toEqual({ value: false, locked: false, source: 'platform' });
    expect(await securitySetting(t.app.ctx, 'enforceTwoFactor')).toBe(false);
  });

  it('toggle through PATCH: one audited event per change, nothing for a repeat', async () => {
    t = await createTestApp();
    const root = await t.superAdminSession();
    const on = await t.req('PATCH', '/api/platform/security-settings', {
      cookie: root.cookie,
      body: { enforceTwoFactor: true },
    });
    expect(on.status).toBe(200);
    expect(on.body.enforceTwoFactor).toEqual({ value: true, locked: false, source: 'platform' });
    expect(await securitySetting(t.app.ctx, 'enforceTwoFactor')).toBe(true);
    await t.req('PATCH', '/api/platform/security-settings', {
      cookie: root.cookie,
      body: { enforceTwoFactor: true },
    });
    const events = await q(`SELECT payload FROM events WHERE type = 'SecuritySettingChanged' ORDER BY seq`);
    expect(events.map((e) => [e.payload.key, e.payload.value, e.payload.by])).toEqual([
      ['enforceTwoFactor', true, root.id],
    ]);
    const audit = await q(
      `SELECT summary, actor_user_id FROM platform_audit_log WHERE action = 'SecuritySettingChanged'`,
    );
    expect(audit).toEqual([{ summary: 'Require two-factor login turned on', actor_user_id: root.id }]);
  });

  it('are for super admins only (404), and a stale session must step up first', async () => {
    t = await createTestApp();
    const member = await t.userSession(uniqueEmail('m'));
    expect((await t.req('GET', '/api/platform/security-settings', { cookie: member.cookie })).status).toBe(
      404,
    );
    expect(
      (
        await t.req('PATCH', '/api/platform/security-settings', {
          cookie: member.cookie,
          body: { enforceTwoFactor: true },
        })
      ).status,
    ).toBe(404);
    const root = await t.superAdminSession();
    t.clock.advance(601_000);
    const stale = await t.req('PATCH', '/api/platform/security-settings', {
      cookie: root.cookie,
      body: { enforceTwoFactor: true },
    });
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('step_up_required');
    expect(await securitySetting(t.app.ctx, 'enforceTwoFactor')).toBe(false);
  });

  it('turning signed runners on with unsigned workstations needs confirmUnlink', async () => {
    // The served runner release must verify before the setting can go on (signed-runner-setting.test.ts).
    t = await createTestApp({
      env: { AOM_RUNNER_RELEASE_PUBKEY: TEST_PUBKEY, AOM_RUNNER_RELEASE_DIR: releaseDirWith() },
    });
    const root = await t.superAdminSession();
    const owner = await t.createUser(uniqueEmail('owner'));
    await pairWorkstation(t, owner);
    const refused = await t.req('PATCH', '/api/platform/security-settings', {
      cookie: root.cookie,
      body: { requireSignedRunners: true },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatchObject({
      code: 'confirm_unlink_required',
      details: { unsignedWorkstations: 1 },
    });
    expect(await securitySetting(t.app.ctx, 'requireSignedRunners')).toBe(false);
    const ok = await t.req('PATCH', '/api/platform/security-settings', {
      cookie: root.cookie,
      body: { requireSignedRunners: true, confirmUnlink: true },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.requireSignedRunners.value).toBe(true);
    const ev = await q(`SELECT payload FROM events WHERE type = 'SecuritySettingChanged'`);
    expect(ev[0]?.payload).toMatchObject({ key: 'requireSignedRunners', value: true, unlinked: 1 });
  });
});

describe('the hosted lock (lockedSecuritySettings)', () => {
  it('shows both locked on; PATCH gives 409 setting_locked; the env cannot unset it', async () => {
    t = await createTestApp({
      extensions: [HOSTED],
      env: { AOM_REQUIRE_SIGNED_RUNNERS: 'false', AOM_ENFORCE_TWO_FACTOR: 'false' },
    });
    const root = await t.superAdminSession();
    const r = await t.req('GET', '/api/platform/security-settings', { cookie: root.cookie });
    expect(r.body.requireSignedRunners).toEqual({ value: true, locked: true, source: 'locked' });
    expect(r.body.enforceTwoFactor).toEqual({ value: true, locked: true, source: 'locked' });
    for (const body of [
      { requireSignedRunners: false },
      { enforceTwoFactor: false },
      { enforceTwoFactor: true },
    ]) {
      const p = await t.req('PATCH', '/api/platform/security-settings', { cookie: root.cookie, body });
      expect(p.status).toBe(409);
      expect(p.body.error.code).toBe('setting_locked');
    }
    await expect(
      setSecuritySetting(t.app.ctx, { id: root.id }, 'enforceTwoFactor', false),
    ).rejects.toMatchObject({
      status: 409,
      code: 'setting_locked',
    });
    // a stored platform value (written before the lock arrived) does not beat the lock either
    await q(
      `INSERT INTO platform_settings (key, value, updated_at) VALUES ('security.enforce_two_factor', 'false', now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    );
    const { invalidateSecuritySettings } = await import('../src/auth/security-settings.ts');
    invalidateSecuritySettings(t.app.ctx);
    expect(await securitySetting(t.app.ctx, 'enforceTwoFactor')).toBe(true);
    expect(await q(`SELECT 1 FROM events WHERE type = 'SecuritySettingChanged'`)).toEqual([]);
  });

  it('accepts only true: a lock can never make an install less strict', () => {
    const loose = {
      name: 'loose',
      lockedSecuritySettings: { enforceTwoFactor: false },
    } as unknown as ServerExtension;
    expect(() => createExtensionHost([loose])).toThrow(/only lock/);
    const odd = {
      name: 'odd',
      lockedSecuritySettings: { somethingElse: true },
    } as unknown as ServerExtension;
    expect(() => createExtensionHost([odd])).toThrow(/unknown security setting/);
    const two = createExtensionHost([
      { name: 'a', lockedSecuritySettings: { enforceTwoFactor: true } },
      { name: 'b', lockedSecuritySettings: { requireSignedRunners: true } },
    ]);
    expect(two.lockedSecuritySettings).toEqual({ enforceTwoFactor: true, requireSignedRunners: true });
  });
});

describe('screenAddress (address policy)', () => {
  it('checks the block list first, then the extensions unless an allowed domain matches', async () => {
    const seen: string[] = [];
    t = await createTestApp({
      extensions: [
        {
          name: 'disposable',
          async screenAddress(_ctx, input) {
            seen.push(`${input.purpose}:${input.email}`);
            return input.email.endsWith('@throwaway.test') || input.email.endsWith('@ok.throwaway.test')
              ? { reason: 'disposable domain' }
              : null;
          },
        },
      ],
    });
    const root = await t.superAdminSession();
    const add = async (kind: string, value: string) =>
      t!.app.ctx.store.append([
        {
          streamId: streamId.platformSecurity(),
          event: {
            type: 'PlatformBlockAdded',
            payload: { blockId: randomUUID(), kind: kind as 'domain', value, note: '', by: root.id },
          },
          actor: { kind: 'user', id: root.id },
          scope: { orgId: null, projectId: null, audience: 'admin' },
        },
      ]);
    await add('domain', 'evil.test');
    await add('email', 'bad@good.test');
    await add('ip', '203.0.113.0/24');
    await add('allow_domain', 'ok.throwaway.test');
    const ctx = t.app.ctx;
    const s = (email: string, ip: string | null = null) =>
      screenAddress(ctx, { email, ip, purpose: 'invite' });
    expect(await s('a@evil.test')).toMatchObject({ source: 'blocklist', kind: 'domain' });
    expect(await s('a@mail.evil.test')).toMatchObject({ source: 'blocklist', kind: 'domain' });
    expect(await s('a@notevil.test')).toBeNull();
    expect(await s(' BAD@good.test ')).toMatchObject({ source: 'blocklist', kind: 'email' });
    expect(await s('fine@good.test', '203.0.113.7')).toMatchObject({ source: 'blocklist', kind: 'ip' });
    expect(await s('fine@good.test', '198.51.100.7')).toBeNull();
    expect(await s('x@throwaway.test')).toMatchObject({ source: 'disposable', kind: 'extension' });
    expect(await s('x@ok.throwaway.test')).toBeNull();
    expect(seen).toContain('invite:x@throwaway.test');
    expect(seen).not.toContain('invite:x@ok.throwaway.test');
    const audit = await q(`SELECT action FROM platform_audit_log WHERE action LIKE 'PlatformBlock%'`);
    expect(audit).toHaveLength(4);
  });
});
