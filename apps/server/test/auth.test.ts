import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../src/auth/sessions.ts';
import { createTestApp, ORIGIN, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('auth', () => {
  it('logs in, sets an HttpOnly SameSite=Lax cookie and serves /me', async () => {
    const email = uniqueEmail();
    await t.createUser(email);
    const raw = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN },
      payload: { email, password: PASSWORD },
    });
    expect(raw.statusCode).toBe(200);
    const sc = String(raw.headers['set-cookie']);
    expect(sc).toContain(`${SESSION_COOKIE}=`);
    expect(sc).toMatch(/HttpOnly/i);
    expect(sc).toMatch(/SameSite=Lax/i);
    expect(sc).not.toMatch(/Secure/i); // http origin in tests
    const cookie = sc.split(';')[0] as string;
    const me = await t.req('GET', '/api/auth/me', { cookie });
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(email);
    // every user is the Owner of an organization of their own, so the deprecated `isAdmin` alias is true
    expect(me.body.isAdmin).toBe(true);
    expect(me.body.activeOrg.role).toBe('owner');
    expect(me.body.visibleProjectIds).toEqual([]);
    expect((await t.req('GET', '/api/auth/me')).status).toBe(401);
  });

  it('stores only a hash of the session token', async () => {
    const email = uniqueEmail();
    await t.createUser(email);
    const cookie = await t.login(email);
    const token = cookie.split('=')[1] as string;
    const rows = await q('SELECT id FROM auth_sessions');
    expect(rows.map((r) => r.id)).not.toContain(token);
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.id))).toBe(true);
  });

  it('gives uniform failures for unknown user and wrong password', async () => {
    const email = uniqueEmail();
    await t.createUser(email);
    const bad = await t.req('POST', '/api/auth/login', { body: { email, password: 'wrong-password-123' } });
    const none = await t.req('POST', '/api/auth/login', {
      body: { email: uniqueEmail(), password: 'wrong-password-123' },
    });
    expect(bad.status).toBe(401);
    expect(none.status).toBe(401);
    expect(bad.body).toEqual(none.body);
  });

  it('logout deletes the session', async () => {
    const email = uniqueEmail();
    await t.createUser(email);
    const cookie = await t.login(email);
    expect((await t.req('POST', '/api/auth/logout', { cookie })).status).toBe(200);
    expect((await t.req('GET', '/api/auth/me', { cookie })).status).toBe(401);
  });

  it('rejects mutating requests without a matching Origin (403)', async () => {
    const email = uniqueEmail();
    await t.createUser(email);
    const noOrigin = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(noOrigin.statusCode).toBe(403);
    const wrong = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: 'http://evil.example' },
      payload: { email, password: PASSWORD },
    });
    expect(wrong.statusCode).toBe(403);
    // GET needs no Origin
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('rejects non-JSON bodies with 415', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'email=a&password=b',
    });
    expect(res.statusCode).toBe(415);
    const plain = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: ORIGIN, 'content-type': 'text/plain' },
      payload: '{}',
    });
    expect(plain.statusCode).toBe(415);
  });

  it('deactivated users get 401 and lose their sessions', async () => {
    const admin = await t.userSession(uniqueEmail('admin'), 'admin');
    const email = uniqueEmail();
    const id = await t.createUser(email);
    const cookie = await t.login(email);
    const r = await t.req('PATCH', `/api/admin/users/${id}`, {
      cookie: admin.cookie,
      body: { status: 'deactivated' },
    });
    expect(r.status).toBe(200);
    expect((await t.req('GET', '/api/auth/me', { cookie })).status).toBe(401);
    expect(await q('SELECT 1 FROM auth_sessions WHERE user_id=$1', [id])).toHaveLength(0);
    expect((await t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).status).toBe(
      401,
    );
    // reactivation allows login again
    await t.req('PATCH', `/api/admin/users/${id}`, { cookie: admin.cookie, body: { status: 'active' } });
    expect((await t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).status).toBe(
      200,
    );
  });

  it('expires idle sessions (clock-shifted)', async () => {
    const email = uniqueEmail();
    await t.createUser(email);
    const cookie = await t.login(email);
    t.clock.advance(8 * 24 * 3600_000);
    expect((await t.req('GET', '/api/auth/me', { cookie })).status).toBe(401);
    t.clock.setOffset(0);
  });

  it('malformed input is a 400 with the standard error shape', async () => {
    const r = await t.req('POST', '/api/auth/login', { body: { email: 'nope' } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
  });
});

describe('rate limiting', () => {
  it('limits login attempts per IP+email', async () => {
    const rl = await createTestApp({ env: { AOM_RATE_LIMIT: 'true' }, reset: false });
    try {
      const email = uniqueEmail();
      let last = 0;
      for (let i = 0; i < 12; i++) {
        last = (await rl.req('POST', '/api/auth/login', { body: { email, password: 'wrong-password-123' } }))
          .status;
      }
      expect(last).toBe(429);
    } finally {
      await rl.close();
    }
  });

  it('limits login per IP across emails, and password changes per account (review low)', async () => {
    const rl = await createTestApp({ env: { AOM_RATE_LIMIT: 'true' }, reset: false });
    try {
      const u = await rl.userSession(uniqueEmail('pw')); // before the IP is locked out
      let last = 0;
      for (let i = 0; i < 32; i++) {
        last = (
          await rl.req('POST', '/api/auth/login', {
            body: { email: uniqueEmail(`stuff${i}`), password: 'wrong-password-123' },
          })
        ).status;
      }
      expect(last).toBe(429);

      const statuses: number[] = [];
      for (let i = 0; i < 7; i++) {
        statuses.push(
          (
            await rl.req('POST', '/api/auth/password', {
              cookie: u.cookie,
              body: { current: 'not-the-password-1', new: 'another-new-password-123' },
            })
          ).status,
        );
      }
      expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
      expect(statuses.slice(5)).toEqual([429, 429]);
    } finally {
      await rl.close();
    }
  });
});
