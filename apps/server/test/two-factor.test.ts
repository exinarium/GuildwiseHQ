import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode, totpStep } from '../src/auth/totp.ts';
import { createTestApp, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const codeFor = (secret: string, ahead = 0) => totpCode(secret, totpStep(t.app.ctx.clock.now()) + ahead);

describe('two-factor login (TOTP) with recovery codes', () => {
  it('enrols with the password and a code, then signing in needs a second step; a recovery code works once', async () => {
    const email = uniqueEmail('twofa');
    const u = await t.userSession(email);

    // setup needs the password, and the secret is not active until a code confirms it
    expect(
      (
        await t.req('POST', '/api/auth/2fa/setup', {
          cookie: u.cookie,
          body: { password: 'wrong-password-123' },
        })
      ).status,
    ).toBe(400);
    const setup = await ok<any>(
      t.req('POST', '/api/auth/2fa/setup', { cookie: u.cookie, body: { password: PASSWORD } }),
    );
    expect(setup.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(
      (await t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).body
        .twoFactorRequired,
    ).toBeUndefined();
    expect(
      (await t.req('POST', '/api/auth/2fa/enable', { cookie: u.cookie, body: { code: '000000' } })).status,
    ).toBeGreaterThanOrEqual(400);
    const enabled = await ok<any>(
      t.req('POST', '/api/auth/2fa/enable', { cookie: u.cookie, body: { code: codeFor(setup.secret) } }),
    );
    expect(enabled.recoveryCodes).toHaveLength(10);
    expect((await ok<any>(t.req('GET', '/api/auth/2fa', { cookie: u.cookie }))).recoveryCodesLeft).toBe(10);

    // a password alone now yields a challenge, not a session
    const first = await t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ twoFactorRequired: true });
    expect(first.cookie).toBeUndefined();
    const challenge = first.body.challenge as string;

    // a wrong code is refused; the right one opens the session
    expect((await t.req('POST', '/api/auth/login/2fa', { body: { challenge, code: '123456' } })).status).toBe(
      401,
    );
    t.app.ctx.clock.advance?.(31_000);
    const good = await t.req('POST', '/api/auth/login/2fa', {
      body: { challenge, code: codeFor(setup.secret) },
    });
    expect(good.status).toBe(200);
    expect(good.cookie).toBeTruthy();
    expect((await t.req('GET', '/api/auth/me', { cookie: good.cookie })).status).toBe(200);

    // the same code cannot be replayed
    const again = await t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    const replay = await t.req('POST', '/api/auth/login/2fa', {
      body: { challenge: again.body.challenge, code: codeFor(setup.secret) },
    });
    expect(replay.status).toBe(401);

    // a recovery code signs in once
    const [rc] = enabled.recoveryCodes as string[];
    const c2 = await t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    const viaRecovery = await t.req('POST', '/api/auth/login/2fa', {
      body: { challenge: c2.body.challenge, code: rc },
    });
    expect(viaRecovery.status).toBe(200);
    const c3 = await t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    expect(
      (await t.req('POST', '/api/auth/login/2fa', { body: { challenge: c3.body.challenge, code: rc } }))
        .status,
    ).toBe(401);
    expect(
      (await ok<any>(t.req('GET', '/api/auth/2fa', { cookie: viaRecovery.cookie }))).recoveryCodesLeft,
    ).toBe(9);
  });

  it('switches off with the password and a code, unless an organization or the platform requires it', async () => {
    const owner = await t.userSession(uniqueEmail('twofa-owner'));
    const secret = await t.enableTwoFactor(owner.id);
    expect(secret).toBeTruthy();
    const org = await t.createOrg(owner.id, 'Twofa Inc');
    await ok(
      t.req('PATCH', '/api/org', {
        cookie: owner.cookie,
        headers: { 'x-aom-org': org },
        body: { requireTwoFactor: true },
      }),
    );
    const refused = await t.req('POST', '/api/auth/2fa/disable', {
      cookie: owner.cookie,
      body: { password: PASSWORD, code: await t.totpCode(owner.id) },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('two_factor_required');

    const free = await t.userSession(uniqueEmail('twofa-free'));
    await t.enableTwoFactor(free.id);
    await ok(
      t.req('POST', '/api/auth/2fa/disable', {
        cookie: free.cookie,
        body: { password: PASSWORD, code: await t.totpCode(free.id) },
      }),
    );
    expect((await ok<any>(t.req('GET', '/api/auth/2fa', { cookie: free.cookie }))).enabled).toBe(false);
  });
});
