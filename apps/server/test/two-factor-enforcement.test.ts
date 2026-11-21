import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invalidateSecuritySettings } from '../src/auth/security-settings.ts';
import { totpCode, totpStep } from '../src/auth/totp.ts';
import type { Config } from '../src/config.ts';
import { withConfig } from '../src/config.ts';
import { createTestApp, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

/**
 * "Require two-factor login" (R28): with the setting on, every account without two-factor login is held at the
 * enrolment (403 `two_factor_setup_required` outside `/api/auth/*`) until it sets it up; confirming the enrolment makes
 * the session fresh for step-up; switching 2FA off is refused; users whose only memberships are simulation
 * organizations are exempt. Off (the default), nothing changes.
 */
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

/** As a freshly signed-in super admin (the PATCH needs a fresh step-up proof). */
const setEnforced = async (value: boolean) => {
  const root = await t.superAdminSession();
  const r = await t.req('PATCH', '/api/platform/security-settings', {
    cookie: root.cookie,
    body: { enforceTwoFactor: value },
  });
  expect(r.status).toBe(200);
};

describe('Require two-factor login', () => {
  it('off by default: an account without two-factor works as before', async () => {
    const u = await t.userSession(uniqueEmail('free'));
    expect((await t.req('GET', '/api/projects', { cookie: u.cookie })).status).toBe(200);
    const me = await t.req('GET', '/api/auth/me', { cookie: u.cookie });
    expect(me.body.twoFactor).toMatchObject({ enabled: false, required: false, setupRequired: false });
  });

  it('on: holds every account without two-factor at the enrolment until it is set up', async () => {
    const u = await t.userSession(uniqueEmail('held'));
    await setEnforced(true);
    try {
      const blocked = await t.req('GET', '/api/projects', { cookie: u.cookie });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe('two_factor_setup_required');
      const me = await t.req('GET', '/api/auth/me', { cookie: u.cookie });
      expect(me.status).toBe(200);
      expect(me.body.twoFactor).toMatchObject({ enabled: false, required: true, setupRequired: true });

      // the enrolment endpoints are open
      const setup = await t.req('POST', '/api/auth/2fa/setup', {
        cookie: u.cookie,
        body: { password: PASSWORD },
      });
      expect(setup.status).toBe(200);
      t.clock.advance(11 * 60_000); // the sign-in proof is stale now
      const enable = await t.req('POST', '/api/auth/2fa/enable', {
        cookie: u.cookie,
        body: { code: totpCode(setup.body.secret, totpStep(t.clock.now())) },
      });
      expect(enable.status).toBe(200);
      expect((await t.req('GET', '/api/projects', { cookie: u.cookie })).status).toBe(200);
      // confirming the enrolment made the session fresh for step-up (R5)
      const s = await q(`SELECT second_factor_at FROM auth_sessions WHERE user_id=$1`, [u.id]);
      expect(Math.abs(new Date(s[0]?.second_factor_at).getTime() - t.clock.now().getTime())).toBeLessThan(
        10_000,
      );

      // switching it off is refused while the setting is on
      const off = await t.req('POST', '/api/auth/2fa/disable', {
        cookie: u.cookie,
        body: { password: PASSWORD, code: totpCode(setup.body.secret, totpStep(t.clock.now()) + 1) },
      });
      expect(off.status).toBe(409);
      expect(off.body.error.code).toBe('two_factor_required');
    } finally {
      await setEnforced(false);
    }
    // off again: a new account without two-factor is free again
    const v = await t.userSession(uniqueEmail('after'));
    expect((await t.req('GET', '/api/projects', { cookie: v.cookie })).status).toBe(200);
  });

  it('exempts users whose only memberships are simulation organizations', async () => {
    const sim = await t.userSession(uniqueEmail('sim'));
    await q(
      `UPDATE organizations SET simulation=true WHERE id IN (SELECT org_id FROM org_members WHERE user_id=$1)`,
      [sim.id],
    );
    const real = await t.userSession(uniqueEmail('real'));
    await setEnforced(true);
    try {
      const me = await t.req('GET', '/api/auth/me', { cookie: sim.cookie });
      expect(me.body.twoFactor).toMatchObject({ required: false, setupRequired: false });
      expect((await t.req('GET', '/api/auth/me', { cookie: real.cookie })).body.twoFactor.setupRequired).toBe(
        true,
      );
      // a simulation user who also joins a real organization is no longer exempt
      const owner = await t.createUser(uniqueEmail('owner'));
      const org = await t.createOrg(owner, 'Real Co');
      await t.addOrgMember(org, sim.id);
      expect((await t.req('GET', '/api/auth/me', { cookie: sim.cookie })).body.twoFactor.setupRequired).toBe(
        true,
      );
    } finally {
      await setEnforced(false);
    }
  });

  it('the env default (AOM_ENFORCE_TWO_FACTOR) turns it on when the platform setting was never written', async () => {
    await q(`DELETE FROM platform_settings WHERE key='security.enforce_two_factor'`);
    const before = t.app.ctx.config;
    const u = await t.userSession(uniqueEmail('envdefault'));
    try {
      (t.app.ctx as { config: Config }).config = withConfig(before, {
        securityDefaults: { ...before.securityDefaults, enforceTwoFactor: true },
      });
      invalidateSecuritySettings(t.app.ctx);
      expect((await t.req('GET', '/api/projects', { cookie: u.cookie })).status).toBe(403);
    } finally {
      (t.app.ctx as { config: Config }).config = before;
      invalidateSecuritySettings(t.app.ctx);
    }
    expect((await t.req('GET', '/api/projects', { cookie: u.cookie })).status).toBe(200);
  });
});

describe('Rework 1', () => {
  it('an account held at the enrolment cannot accept an invitation to an organization', async () => {
    const owner = await t.userSession(uniqueEmail('inv-owner'));
    const org = await t.createOrg(owner.id, 'Joinable Co');
    const u = await t.userSession(uniqueEmail('joiner'));
    await t.req('POST', '/api/org/invitations', {
      cookie: owner.cookie,
      headers: { 'x-aom-org': org },
      body: { email: u.email, role: 'member' },
    });
    const { latestInviteToken } = await import('./helpers/mailpit.ts');
    const token = await latestInviteToken(u.email, 'http://aom.test');
    await setEnforced(true);
    try {
      const r = await t.req('POST', `/api/invitations/${token}/accept-existing`, {
        cookie: u.cookie,
        body: {},
      });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('two_factor_setup_required');
      expect(await q(`SELECT 1 FROM org_members WHERE org_id=$1 AND user_id=$2`, [org, u.id])).toHaveLength(
        0,
      );
    } finally {
      await setEnforced(false);
    }
    expect(
      (await t.req('POST', `/api/invitations/${token}/accept-existing`, { cookie: u.cookie, body: {} }))
        .status,
    ).toBe(201);
  });
});
