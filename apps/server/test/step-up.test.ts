import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, lookupSession } from '../src/auth/sessions.ts';
import { isStepUpFresh, requireStepUp } from '../src/auth/step-up.ts';
import { loadConfig, withConfig } from '../src/config.ts';
import { HttpError } from '../src/errors.ts';
import { createTestApp, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

/**
 * "Confirm it's you" (R5): freshness of `second_factor_at`, `POST /api/auth/step-up` with a code (two-factor accounts)
 * or the password (D1), the guarded platform write, sessions that are never fresh, five wrong answers, and the production
 * ceiling of the windows. The per-route list of guarded routes is covered by the routes' own workstream.
 */
let t: TestApp;
const WINDOW_MS = 600_000;
const token = (cookie: string) => cookie.split('=')[1] as string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('session methods and freshness', () => {
  it('records how each sign-in started: password, password_totp, password_recovery', async () => {
    const plain = await t.userSession(uniqueEmail('plain'));
    const s1 = await lookupSession(t.app.ctx, token(plain.cookie));
    expect(s1?.method).toBe('password');
    expect(s1?.secondFactorAt).not.toBeNull();

    const root = await t.superAdminSession();
    expect((await lookupSession(t.app.ctx, token(root.cookie)))?.method).toBe('password_totp');

    // a recovery code at the second step
    const email = uniqueEmail('rec');
    const id = await t.createUser(email);
    await t.enableTwoFactor(id);
    const code = 'abcde12345';
    const { createHash } = await import('node:crypto');
    await q(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
      id,
      createHash('sha256').update(code).digest('hex'),
    ]);
    const r1 = await t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
    const r2 = await t.req('POST', '/api/auth/login/2fa', { body: { challenge: r1.body.challenge, code } });
    expect(r2.status).toBe(200);
    expect((await lookupSession(t.app.ctx, token(r2.cookie as string)))?.method).toBe('password_recovery');
  });

  it('invitation, email verification and demo sessions are never fresh; password sessions are', async () => {
    const id = await t.createUser(uniqueEmail('m'));
    for (const method of ['invitation', 'email_verification', 'demo'] as const) {
      const { token: tok } = await createSession(t.app.ctx, id, {}, method);
      const s = await lookupSession(t.app.ctx, tok);
      expect(s?.method).toBe(method);
      expect(s?.secondFactorAt).toBeNull();
      expect(isStepUpFresh(t.app.ctx, s!)).toBe(false);
      expect(() => requireStepUp(t.app.ctx, s!)).toThrow(HttpError);
    }
    const { token: tok } = await createSession(t.app.ctx, id, {}, 'password');
    const s = await lookupSession(t.app.ctx, tok);
    expect(isStepUpFresh(t.app.ctx, s!)).toBe(true);
    expect(() => requireStepUp(t.app.ctx, s!)).not.toThrow();
  });

  it('a proof goes stale after AOM_STEP_UP_WINDOW_SEC', async () => {
    const u = await t.userSession(uniqueEmail('w'));
    const s = await lookupSession(t.app.ctx, token(u.cookie));
    expect(isStepUpFresh(t.app.ctx, s!)).toBe(true);
    t.clock.advance(WINDOW_MS + 1000);
    const later = await lookupSession(t.app.ctx, token(u.cookie));
    expect(isStepUpFresh(t.app.ctx, later!)).toBe(false);
    try {
      requireStepUp(t.app.ctx, later!);
      expect.unreachable();
    } catch (e) {
      expect(e).toMatchObject({ status: 403, code: 'step_up_required', details: { method: 'password' } });
    }
  });
});

describe('the guarded platform write and POST /api/auth/step-up', () => {
  it('a stale super-admin session gets 403 step_up_required {totp}, then works after a code', async () => {
    const root = await t.superAdminSession();
    const patch = () =>
      t.req('PATCH', '/api/platform/security-settings', {
        cookie: root.cookie,
        body: { enforceTwoFactor: false },
      });
    expect((await patch()).status).toBe(200);
    t.clock.advance(WINDOW_MS + 1000);
    const stale = await patch();
    expect(stale.status).toBe(403);
    expect(stale.body.error).toMatchObject({ code: 'step_up_required', details: { method: 'totp' } });

    // a password is not what a two-factor account answers with
    const wrongKind = await t.req('POST', '/api/auth/step-up', {
      cookie: root.cookie,
      body: { password: PASSWORD },
    });
    expect(wrongKind.status).toBe(400);
    expect(wrongKind.body.error.code).toBe('step_up_method');

    const ok = await t.req('POST', '/api/auth/step-up', {
      cookie: root.cookie,
      body: { code: await t.totpCode(root.id) },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    const until = new Date(ok.body.freshUntil).getTime() - t.clock.now().getTime();
    expect(until).toBeGreaterThan(WINDOW_MS - 5000);
    expect(until).toBeLessThanOrEqual(WINDOW_MS);
    expect((await patch()).status).toBe(200);
  });

  it('accounts without two-factor login answer with their password (D1)', async () => {
    const u = await t.userSession(uniqueEmail('pw'));
    t.clock.advance(WINDOW_MS + 1000);
    const code = await t.req('POST', '/api/auth/step-up', { cookie: u.cookie, body: { code: '123456' } });
    expect(code.status).toBe(400);
    expect(code.body.error).toMatchObject({ code: 'step_up_method', details: { method: 'password' } });
    const wrong = await t.req('POST', '/api/auth/step-up', { cookie: u.cookie, body: { password: 'nope' } });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatchObject({ code: 'wrong_password', details: { attemptsLeft: 4 } });
    const ok = await t.req('POST', '/api/auth/step-up', { cookie: u.cookie, body: { password: PASSWORD } });
    expect(ok.status).toBe(200);
    expect(isStepUpFresh(t.app.ctx, (await lookupSession(t.app.ctx, token(u.cookie)))!)).toBe(true);
    const rows = await q(`SELECT reason, user_id FROM login_failures WHERE user_id = $1`, [u.id]);
    expect(rows).toEqual([{ reason: 'step_up', user_id: u.id }]);
  });

  it('five wrong answers end the session', async () => {
    const root = await t.superAdminSession();
    let last: Awaited<ReturnType<TestApp['req']>> | undefined;
    for (let i = 0; i < 5; i++)
      last = await t.req('POST', '/api/auth/step-up', { cookie: root.cookie, body: { code: '000000' } });
    expect(last?.status).toBe(401);
    expect(last?.body.error.code).toBe('session_ended');
    expect((await t.req('GET', '/api/auth/me', { cookie: root.cookie })).status).toBe(401);
  });

  it('needs a session', async () => {
    expect((await t.req('POST', '/api/auth/step-up', { body: { password: PASSWORD } })).status).toBe(401);
  });
});

describe('configuration of the windows', () => {
  const prod = { NODE_ENV: 'production', AOM_SECRET_KEY: 'k'.repeat(40) };

  it('refuses windows above the defaults in production, accepts them elsewhere (e2e, guide, video)', () => {
    expect(() => loadConfig({ ...prod, AOM_STEP_UP_WINDOW_SEC: '86400' })).toThrow(/AOM_STEP_UP_WINDOW_SEC/);
    expect(() => loadConfig({ ...prod, AOM_SUPER_ADMIN_IDLE_SEC: '86400' })).toThrow(
      /AOM_SUPER_ADMIN_IDLE_SEC/,
    );
    const p = loadConfig(prod);
    expect([p.stepUpWindowSec, p.superAdminIdleSec]).toEqual([600, 1800]);
    const e2e = loadConfig({ AOM_STEP_UP_WINDOW_SEC: '86400', AOM_SUPER_ADMIN_IDLE_SEC: '86400' });
    expect([e2e.stepUpWindowSec, e2e.superAdminIdleSec]).toEqual([86400, 86400]);
  });

  it('refuses a two-factor key equal to AOM_SECRET_KEY, warns in production without one', async () => {
    const key = 'x'.repeat(40);
    expect(() => loadConfig({ AOM_SECRET_KEY: key, AOM_TWO_FACTOR_KEY: key })).toThrow(/must differ/);
    expect(() => loadConfig({ AOM_TWO_FACTOR_KEY: 'short' })).toThrow();
    const { configWarnings } = await import('../src/config.ts');
    expect(configWarnings(loadConfig(prod)).join(' ')).toMatch(/AOM_TWO_FACTOR_KEY/);
    expect(configWarnings(loadConfig({ ...prod, AOM_TWO_FACTOR_KEY: 'y'.repeat(40) }))).toEqual([]);
  });

  it('keeps the environment out of JSON, logs and spreads (env is non-enumerable)', () => {
    const c = loadConfig({ AOM_SECRET_KEY: 'super-secret-value-123' });
    expect(c.env.AOM_SECRET_KEY).toBe('super-secret-value-123');
    expect(Object.keys(c)).not.toContain('env');
    expect(JSON.parse(JSON.stringify(c)).env).toBeUndefined();
    expect({ ...c }.env).toBeUndefined();
    const copy = withConfig(c, { stepUpWindowSec: 60 });
    expect(copy.env.AOM_SECRET_KEY).toBe('super-secret-value-123');
    expect(copy.stepUpWindowSec).toBe(60);
  });
});
