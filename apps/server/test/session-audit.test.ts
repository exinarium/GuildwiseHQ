import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSession, lookupSession } from '../src/auth/sessions.ts';
import { uaFamily } from '../src/auth/ua-family.ts';
import type { Config } from '../src/config.ts';
import { withConfig } from '../src/config.ts';
import { createTestApp, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { messagesTo, waitForMessages } from './helpers/mailpit.ts';

/**
 * Session audit (R4): `SessionStarted` for every method (projected into `sign_ins`, never the token), the new-device
 * mail by browser family (not version; never for demo), super-admin limits (8 h, `AOM_SUPER_ADMIN_IDLE_SEC`), the
 * per-request check that refuses a super-admin session no sign-in created (an inserted row, a rewritten user id), and
 * the migration that ends the old super-admin sessions.
 */
let t: TestApp;
const CHROME_120 =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CHROME_121 =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const tokenOf = (cookie: string) => cookie.split('=')[1] as string;
const MIN = 60_000;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const login = (email: string, ua: string, ip = '203.0.113.50') =>
  t.req('POST', '/api/auth/login', {
    body: { email, password: PASSWORD },
    headers: { 'user-agent': ua, 'x-forwarded-for': ip },
  });
const newSignInMails = async (email: string) =>
  (await messagesTo(email)).filter((m) => m.Subject.startsWith('New sign-in'));
const settle = () => new Promise((r) => setTimeout(r, 400));
const setConfig = (changes: Partial<Config>) => {
  (t.app.ctx as { config: Config }).config = withConfig(t.app.ctx.config, changes);
};

describe('SessionStarted', () => {
  it('is appended for every method, projected into sign_ins with the token hash, never the token', async () => {
    const email = uniqueEmail('methods');
    const id = await t.createUser(email);
    const r = await login(email, CHROME_120);
    expect(r.status).toBe(200);
    const tok = tokenOf(r.cookie as string);
    for (const method of ['invitation', 'email_verification', 'demo'] as const)
      await createSession(t.app.ctx, id, { userAgent: CHROME_120, ip: '203.0.113.50' }, method);
    // the two-factor methods
    const root = await t.superAdminSession();

    const events = await q(
      `SELECT payload FROM events WHERE type='SessionStarted' AND payload->>'userId'=$1 ORDER BY seq`,
      [id],
    );
    expect(events.map((e) => e.payload.method)).toEqual([
      'password',
      'invitation',
      'email_verification',
      'demo',
    ]);
    expect(events[0]?.payload).toMatchObject({
      sessionRef: sha(tok),
      newDevice: true,
      uaFamily: 'chrome/linux',
      meta: { ip: '203.0.113.50' },
    });
    const all = JSON.stringify(await q(`SELECT * FROM events WHERE type='SessionStarted'`));
    expect(all).not.toContain(tok);
    const rows = await q(
      `SELECT method, session_ref, ua_family, ip FROM sign_ins WHERE user_id=$1 ORDER BY seq`,
      [id],
    );
    expect(rows[0]).toEqual({
      method: 'password',
      session_ref: sha(tok),
      ua_family: 'chrome/linux',
      ip: '203.0.113.50',
    });
    expect(rows).toHaveLength(4);
    expect((await q(`SELECT method FROM sign_ins WHERE user_id=$1`, [root.id]))[0]?.method).toBe(
      'password_totp',
    );
  });

  it('normalizes the user agent to browser family plus OS', () => {
    expect(uaFamily(CHROME_120)).toBe('chrome/linux');
    expect(uaFamily(CHROME_121)).toBe('chrome/linux');
    expect(uaFamily(FIREFOX)).toBe('firefox/windows');
    expect(
      uaFamily(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15',
      ),
    ).toBe('safari/macos');
    expect(
      uaFamily(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
      ),
    ).toBe('edge/windows');
    expect(uaFamily(undefined)).toBe('unknown');
  });
});

describe('the new-device mail', () => {
  it('goes by browser family: a browser update sends nothing, a new family does; the first sign-in and demo never', async () => {
    const email = uniqueEmail('device');
    const id = await t.createUser(email);
    expect((await login(email, CHROME_120)).status).toBe(200); // the first sign-in of the account: nothing to compare
    expect((await login(email, CHROME_121)).status).toBe(200); // a browser update
    await createSession(t.app.ctx, id, { userAgent: 'demo-scenario' }, 'demo');
    await settle();
    expect(await newSignInMails(email)).toHaveLength(0);
    expect((await login(email, FIREFOX)).status).toBe(200);
    await waitForMessages(email, 1);
    expect(await newSignInMails(email)).toHaveLength(1);
    // a new address with the same browser is a new device too
    expect((await login(email, FIREFOX, '198.51.100.20')).status).toBe(200);
    await waitForMessages(email, 2);
    const flags = await q(`SELECT new_device FROM sign_ins WHERE user_id=$1 ORDER BY seq`, [id]);
    expect(flags.map((f) => f.new_device)).toEqual([true, false, true, true, true]);
  });

  it('follows AOM_SIGNIN_NOTICES (off; super_admin only)', async () => {
    const before = t.app.ctx.config;
    try {
      const email = uniqueEmail('quiet');
      await t.createUser(email);
      await login(email, CHROME_120);
      setConfig({ signinNotices: 'off' });
      await login(email, FIREFOX);
      setConfig({ signinNotices: 'super_admin' });
      await login(email, FIREFOX, '198.51.100.21');
      await settle();
      expect(await newSignInMails(email)).toHaveLength(0);
    } finally {
      (t.app.ctx as { config: Config }).config = before;
    }
  });
});

describe('super-admin limits', () => {
  it('ends a super-admin session after 8 h however busy, and after 30 min idle; a user session is not affected', async () => {
    const root = await t.superAdminSession();
    const user = await t.userSession(uniqueEmail('long'));
    // a request every 29 min (never idle) for 16 x 29 = 464 min: still signed in
    for (let i = 0; i < 16; i++) {
      t.clock.advance(29 * MIN);
      expect((await t.req('GET', '/api/auth/me', { cookie: root.cookie })).status).toBe(200);
    }
    t.clock.advance(29 * MIN); // 493 min > 8 h
    expect((await t.req('GET', '/api/auth/me', { cookie: root.cookie })).status).toBe(401);
    expect((await t.req('GET', '/api/auth/me', { cookie: user.cookie })).status).toBe(200);

    const root2 = await t.superAdminSession();
    t.clock.advance(31 * MIN);
    expect((await t.req('GET', '/api/auth/me', { cookie: root2.cookie })).status).toBe(401);
    const row = await q(`SELECT expires_at, created_at FROM auth_sessions WHERE id=$1`, [
      sha(tokenOf(root2.cookie)),
    ]);
    expect(new Date(row[0]?.expires_at).getTime() - new Date(row[0]?.created_at).getTime()).toBe(
      8 * 3600_000,
    );
  });
});

describe('the per-request super-admin check', () => {
  it('refuses a super-admin session inserted with SQL on its first request, deletes it, audits and mails', async () => {
    const root = await t.superAdminSession();
    const token = randomBytes(32).toString('base64url');
    const now = t.clock.now();
    await q(
      `INSERT INTO auth_sessions (id, user_id, created_at, last_seen_at, expires_at, ip)
       VALUES ($1,$2,$3,$3,$4,'198.51.100.66')`,
      [sha(token), root.id, now, new Date(now.getTime() + 3600_000)],
    );
    const r = await t.req('GET', '/api/platform/security-settings', { cookie: `aom_sid=${token}` });
    expect(r.status).toBe(404); // the platform guard answers 404 without a valid session
    expect(await q(`SELECT 1 FROM auth_sessions WHERE id=$1`, [sha(token)])).toHaveLength(0);
    const ev = await q(
      `SELECT payload FROM events WHERE type='SuperAdminSessionRejected' ORDER BY seq DESC LIMIT 1`,
    );
    expect(ev[0]?.payload).toMatchObject({ userId: root.id, sessionRef: sha(token), reason: 'no_sign_in' });
    const audit = await q(`SELECT 1 FROM platform_audit_log WHERE action='SuperAdminSessionRejected'`);
    expect(audit.length).toBeGreaterThanOrEqual(1);
    await waitForMessages(root.email, 1);
    expect((await messagesTo(root.email)).some((m) => m.Subject.includes('forged super-admin session'))).toBe(
      true,
    );
    // the genuine session still works
    expect((await t.req('GET', '/api/auth/me', { cookie: root.cookie })).status).toBe(200);
  });

  it('refuses a session whose user_id was rewritten to a super admin', async () => {
    const root = await t.superAdminSession();
    const user = await t.userSession(uniqueEmail('victim'));
    await q(`UPDATE auth_sessions SET user_id=$2 WHERE id=$1`, [sha(tokenOf(user.cookie)), root.id]);
    expect((await t.req('GET', '/api/auth/me', { cookie: user.cookie })).status).toBe(401);
    const ev = await q(
      `SELECT payload FROM events WHERE type='SuperAdminSessionRejected' ORDER BY seq DESC LIMIT 1`,
    );
    expect(ev[0]?.payload).toMatchObject({ userId: root.id, reason: 'user_mismatch' });
    expect(await lookupSession(t.app.ctx, tokenOf(user.cookie))).toBeNull();
  });

  it('the migration ends the super-admin sessions from before it (they have no sign-in row)', async () => {
    const root = await t.superAdminSession();
    const user = await t.userSession(uniqueEmail('keeps'));
    const sql = readFileSync(new URL('../migrations/3020_security_hardening.sql', import.meta.url), 'utf8');
    await q(sql);
    expect(await q(`SELECT 1 FROM auth_sessions WHERE user_id=$1`, [root.id])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM auth_sessions WHERE user_id=$1`, [user.id])).toHaveLength(1);
  });
});
