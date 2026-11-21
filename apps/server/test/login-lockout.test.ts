import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accountLockMs,
  ipLockExempt,
  ipLockKey,
  normalizeIp,
  pruneLoginFailures,
  recordLoginFailure,
} from '../src/auth/login-guard.ts';
import { consoleResetSuperAdminPassword } from '../src/commands/password-reset.ts';
import type { Ctx } from '../src/context.ts';
import { parseTrustProxy } from '../src/trust-proxy.ts';
import { createTestApp, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { messagesTo, messageText, waitForMessages } from './helpers/mailpit.ts';

/**
 * Sign-in protection (R2): account lock (5 failures, 15 min doubling to 60), IP lock (20 in 15 min), the same answer for
 * unknown addresses, the exemptions (a) known device, (b) reset or console reset clears, (c) proxy and private IPs never
 * IP-locked, the lock mail once in 24 h, the "code wrong" mail, and the 90-day prune.
 */
let t: TestApp;
const CHROME_120 =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CHROME_121 =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';
const MIN = 60_000;

let ipSeq = 1;
/** A fresh public address per test (TEST-NET-3), sent through the trusted loopback proxy. */
const newIp = () => `203.0.113.${ipSeq++}`;

const login = (email: string, password: string, ip: string, ua = FIREFOX) =>
  t.req('POST', '/api/auth/login', {
    body: { email, password },
    headers: { 'x-forwarded-for': ip, 'user-agent': ua },
  });

const failN = async (email: string, n: number, ip: string, ua = FIREFOX) => {
  for (let i = 0; i < n; i++) expect((await login(email, 'wrong-password-123', ip, ua)).status).toBe(401);
};

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('account lock', () => {
  it('locks after 5 failures for 15 min; the password is then not checked; the refusal is recorded', async () => {
    const email = uniqueEmail('lock');
    await t.createUser(email);
    const ip = newIp();
    await failN(email, 5, ip);
    const r = await login(email, PASSWORD, ip);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('too_many_attempts');
    expect(r.body.error.details.retryAfterSec).toBeGreaterThan(14 * 60);
    expect(r.body.error.details.retryAfterSec).toBeLessThanOrEqual(15 * 60);
    expect(r.cookie).toBeUndefined();
    const reasons = (
      await q(`SELECT reason FROM login_failures WHERE email_norm=$1 ORDER BY id`, [email])
    ).map((x) => x.reason);
    expect(reasons).toEqual(['password', 'password', 'password', 'password', 'password', 'locked']);
    // after the lock the right password works again
    t.clock.advance(15 * MIN + 1000);
    expect((await login(email, PASSWORD, ip)).status).toBe(200);
  });

  it('an unknown address gets the same 429 after the same number of failures', async () => {
    const email = uniqueEmail('nobody');
    const ip = newIp();
    await failN(email, 5, ip);
    const r = await login(email, PASSWORD, ip);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('too_many_attempts');
    expect(r.body.error.details.scope).toBe('account');
  });

  it('doubles the lock for each further failure, capped at 60 min', async () => {
    expect([5, 6, 7, 8, 12].map((n) => accountLockMs(n) / MIN)).toEqual([15, 30, 60, 60, 60]);
    const email = uniqueEmail('double');
    await t.createUser(email);
    const ip = newIp();
    await failN(email, 5, ip);
    t.clock.advance(15 * MIN + 1000);
    await failN(email, 1, ip); // the 6th failure
    const r = await login(email, PASSWORD, ip);
    expect(r.status).toBe(429);
    expect(r.body.error.details.retryAfterSec).toBeGreaterThan(29 * 60);
  });

  it('wrong two-factor codes count too, and mail "password right, code wrong" at most once an hour', async () => {
    const email = uniqueEmail('code');
    const id = await t.createUser(email);
    await t.enableTwoFactor(id);
    const ip = newIp();
    for (let i = 0; i < 2; i++) {
      const r1 = await login(email, PASSWORD, ip);
      expect(r1.body.twoFactorRequired).toBe(true);
      const r2 = await t.req('POST', '/api/auth/login/2fa', {
        body: { challenge: r1.body.challenge, code: '000000' },
        headers: { 'x-forwarded-for': ip },
      });
      expect(r2.status).toBe(401);
    }
    const rows = await q(`SELECT reason, user_id, ip FROM login_failures WHERE email_norm=$1`, [email]);
    expect(rows).toEqual([
      { reason: 'second_factor', user_id: id, ip },
      { reason: 'second_factor', user_id: id, ip },
    ]);
    await waitForMessages(email, 1);
    await new Promise((r) => setTimeout(r, 300));
    const mails = (await messagesTo(email)).filter((m) => m.Subject.includes('failed at the second step'));
    expect(mails).toHaveLength(1);
  });
});

describe('exemptions', () => {
  it('(a) a device that signed in to the account in the last 30 days still signs in during a lock', async () => {
    const email = uniqueEmail('known');
    await t.createUser(email);
    const home = newIp();
    expect((await login(email, PASSWORD, home, CHROME_120)).status).toBe(200);
    const attacker = newIp();
    await failN(email, 5, attacker);
    expect((await login(email, PASSWORD, attacker)).status).toBe(429);
    // same IP, another browser family: locked
    expect((await login(email, PASSWORD, home, FIREFOX)).status).toBe(429);
    // same IP, same browser family (a newer version): not locked
    expect((await login(email, PASSWORD, home, CHROME_121)).status).toBe(200);
    // not after 30 days
    t.clock.advance(31 * 24 * 60 * MIN);
    await failN(email, 5, attacker);
    expect((await login(email, PASSWORD, home, CHROME_121)).status).toBe(429);
  });

  it('(b) a completed reset clears the lock', async () => {
    const email = uniqueEmail('reset');
    await t.createUser(email);
    const ip = newIp();
    await failN(email, 5, ip);
    expect((await login(email, PASSWORD, ip)).status).toBe(429);
    await t.req('POST', '/api/auth/password-reset/request', { body: { email } });
    // the lock notice may arrive first: wait for the reset mail itself (it is sent detached)
    let resetMail = (await messagesTo(email)).find((m) => m.Subject.startsWith('Reset your'));
    for (let i = 0; !resetMail && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      resetMail = (await messagesTo(email)).find((m) => m.Subject.startsWith('Reset your'));
    }
    const token = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(await messageText(resetMail?.ID as string))?.[1];
    const NEW = 'a-brand-new-password-42';
    expect(
      (await t.req('POST', '/api/auth/password-reset/confirm', { body: { token, password: NEW } })).status,
    ).toBe(200);
    expect(
      (await q(`SELECT 1 FROM login_failures WHERE email_norm=$1 AND reason='cleared'`, [email])).length,
    ).toBe(1);
    expect((await login(email, NEW, ip)).status).toBe(200);
  });

  it('(b) the console reset of a super admin clears the lock', async () => {
    const email = uniqueEmail('root-lock');
    await t.createSuperAdmin(email);
    const ip = newIp();
    await failN(email, 5, ip);
    expect((await login(email, PASSWORD, ip)).status).toBe(429);
    await consoleResetSuperAdminPassword(t.app.ctx, { email, password: 'console-new-password-1' });
    expect((await login(email, 'console-new-password-1', ip)).status).not.toBe(429);
  });

  it('(c) loopback, private and trusted-proxy addresses are never IP-locked; a public one is', async () => {
    // 25 failures for 25 different addresses from loopback (no X-Forwarded-For): no IP lock
    for (let i = 0; i < 25; i++)
      expect(
        (
          await t.req('POST', '/api/auth/login', {
            body: { email: uniqueEmail('lo'), password: 'nope-nope-nope' },
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await t.req('POST', '/api/auth/login', {
          body: { email: uniqueEmail('lo'), password: 'nope-nope-nope' },
        })
      ).status,
    ).toBe(401);
    // the same from one public address: the 21st is refused with an IP lock, whatever the address typed
    const ip = newIp();
    for (let i = 0; i < 20; i++)
      expect((await login(uniqueEmail('spray'), 'nope-nope-nope', ip)).status).toBe(401);
    const r = await login(uniqueEmail('spray'), 'nope-nope-nope', ip);
    expect(r.status).toBe(429);
    expect(r.body.error.details.scope).toBe('ip');
    // the IP lock lasts 15 min
    t.clock.advance(15 * MIN + 1000);
    expect((await login(uniqueEmail('spray'), 'nope-nope-nope', ip)).status).toBe(401);

    const fake = (trust: string | undefined) =>
      ({ config: { trustProxy: parseTrustProxy(trust) } }) as unknown as Ctx;
    expect(ipLockExempt(fake(undefined), '127.0.0.1')).toBe(true);
    expect(ipLockExempt(fake(undefined), '::ffff:10.1.2.3')).toBe(true);
    expect(ipLockExempt(fake(undefined), '192.168.1.5')).toBe(true);
    expect(ipLockExempt(fake(undefined), '172.20.0.1')).toBe(true);
    expect(ipLockExempt(fake(undefined), 'fd00::1')).toBe(true);
    expect(ipLockExempt(fake(undefined), '198.51.100.7')).toBe(false);
    expect(ipLockExempt(fake('198.51.100.0/24'), '198.51.100.7')).toBe(true);
  });
});

describe('mails and housekeeping', () => {
  it('mails the lock notice once per account in 24 h', async () => {
    const email = uniqueEmail('notice');
    await t.createUser(email);
    const ip = newIp();
    await failN(email, 5, ip);
    await waitForMessages(email, 1);
    t.clock.advance(16 * MIN);
    await failN(email, 1, ip); // a second lock, the same day
    await new Promise((r) => setTimeout(r, 300));
    const locked = (await messagesTo(email)).filter((m) => m.Subject.includes('is paused'));
    expect(locked).toHaveLength(1);
    t.clock.advance(25 * 60 * MIN);
    await failN(email, 5, ip);
    await waitForMessages(email, 2);
    expect((await messagesTo(email)).filter((m) => m.Subject.includes('is paused'))).toHaveLength(2);
  });

  it('a blocked address gets the uniform 401 and a `blocked` row; a blocked IP 403 request_refused', async () => {
    const email = uniqueEmail('blocked');
    await t.createUser(email);
    const ip = newIp();
    await q(
      `INSERT INTO platform_blocklist (id, kind, value, note, created_at) VALUES ($1,'email',$2,'',now()), ($3,'ip',$4,'',now())`,
      [randomUUID(), email, randomUUID(), '198.51.100.99'],
    );
    const r = await login(email, PASSWORD, ip);
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe('unauthenticated');
    expect((await q(`SELECT reason FROM login_failures WHERE email_norm=$1`, [email]))[0]?.reason).toBe(
      'blocked',
    );
    const other = uniqueEmail('fromblockedip');
    await t.createUser(other);
    const r2 = await login(other, PASSWORD, '198.51.100.99');
    expect(r2.status).toBe(403);
    expect(r2.body.error.code).toBe('request_refused');
  });

  it('prunes failures older than 90 days, at most once a day', async () => {
    const old = new Date(t.clock.now().getTime() - 91 * 24 * 60 * MIN);
    await q(
      `INSERT INTO login_failures (at, email_norm, reason) VALUES ($1, 'old@example.test', 'password')`,
      [old],
    );
    await q(
      `INSERT INTO login_failures (at, email_norm, reason) VALUES ($1, 'new@example.test', 'password')`,
      [t.clock.now()],
    );
    expect(await pruneLoginFailures(t.app.ctx, { force: true })).toBeGreaterThanOrEqual(1);
    expect(await q(`SELECT 1 FROM login_failures WHERE email_norm='old@example.test'`)).toHaveLength(0);
    expect(await q(`SELECT 1 FROM login_failures WHERE email_norm='new@example.test'`)).toHaveLength(1);
    await q(
      `INSERT INTO login_failures (at, email_norm, reason) VALUES ($1, 'old@example.test', 'password')`,
      [old],
    );
    expect(await pruneLoginFailures(t.app.ctx)).toBe(0); // already ran today
  });
});

describe('Platform > Security lists', () => {
  it('shows failed sign-ins with the locks in force, and sign-ins; super admins only', async () => {
    const email = uniqueEmail('listed');
    const id = await t.createUser(email);
    const ip = newIp();
    expect((await login(email, PASSWORD, ip, FIREFOX)).status).toBe(200);
    await failN(email, 5, ip);
    const root = await t.superAdminSession();
    const failed = await t.req(
      'GET',
      `/api/platform/security/failed-sign-ins?q=${encodeURIComponent(email)}`,
      {
        cookie: root.cookie,
      },
    );
    expect(failed.status).toBe(200);
    expect(failed.body.items).toHaveLength(5);
    expect(failed.body.items[0]).toMatchObject({
      email,
      userId: id,
      ip,
      reason: 'password',
      uaFamily: 'firefox/windows',
    });
    expect(JSON.stringify(failed.body)).not.toContain('Gecko/20100101'); // never the full user agent
    expect(failed.body.locks).toEqual([
      expect.objectContaining({ scope: 'account', key: email, failures: 5 }),
    ]);

    const ok = await t.req('GET', `/api/platform/security/sign-ins?q=${encodeURIComponent(email)}`, {
      cookie: root.cookie,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.items).toEqual([
      expect.objectContaining({
        userId: id,
        email,
        method: 'password',
        ip,
        uaFamily: 'firefox/windows',
        newDevice: true,
      }),
    ]);

    const user = await t.userSession(uniqueEmail('nosy'));
    expect((await t.req('GET', '/api/platform/security/sign-ins', { cookie: user.cookie })).status).toBe(404);
    expect(
      (await t.req('GET', '/api/platform/security/failed-sign-ins', { cookie: user.cookie })).status,
    ).toBe(404);
  });
});

describe('Rework 1', () => {
  const challenge = async (email: string, ip: string) => {
    const r = await login(email, PASSWORD, ip);
    expect(r.body.twoFactorRequired).toBe(true);
    return r.body.challenge as string;
  };
  const answer = (c: string, code: string, ip: string) =>
    t.req('POST', '/api/auth/login/2fa', {
      body: { challenge: c, code },
      headers: { 'x-forwarded-for': ip },
    });

  it('(blocker) a lock ends the open challenges: challenges fetched before it cannot be spent after it', async () => {
    const email = uniqueEmail('stash');
    const id = await t.createUser(email);
    await t.enableTwoFactor(id);
    const ip = newIp();
    const first = await challenge(email, ip);
    const second = await challenge(email, ip);
    for (let i = 0; i < 5; i++) expect((await answer(first, '000000', ip)).status).toBe(401);
    expect(await q(`SELECT 1 FROM login_challenges WHERE user_id=$1`, [id])).toHaveLength(0);
    const r = await answer(second, await t.totpCode(id), ip);
    expect([401, 429]).toContain(r.status);
    expect(r.cookie).toBeUndefined();
  });

  it('(blocker) the locks are checked when a code is answered (an IP lock that started after the challenge)', async () => {
    const email = uniqueEmail('late');
    const id = await t.createUser(email);
    await t.enableTwoFactor(id);
    const ip = newIp();
    const c = await challenge(email, ip);
    for (let i = 0; i < 20; i++)
      expect((await login(uniqueEmail('spray2'), 'nope-nope-nope', ip)).status).toBe(401);
    const r = await answer(c, await t.totpCode(id), ip);
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('too_many_attempts');
    expect(r.cookie).toBeUndefined();
  });

  it('counts IPv6 clients by their /64', async () => {
    expect(ipLockKey('2001:db8:1:2::5')).toBe('2001:db8:1:2::/64');
    expect(ipLockKey('2001:0db8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipLockKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipLockKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(ipLockKey('198.51.100.1')).toBe('198.51.100.1');
    // 20 failures, each from another address of one /64, lock the 21st address of that /64; another /64 is free
    for (let i = 1; i <= 20; i++)
      expect(
        (await login(uniqueEmail('v6'), 'nope-nope-nope', `2001:db8:77:1::${i.toString(16)}`)).status,
      ).toBe(401);
    const r = await login(uniqueEmail('v6'), 'nope-nope-nope', '2001:db8:77:1:ffff::99');
    expect(r.status).toBe(429);
    expect(r.body.error.details.scope).toBe('ip');
    expect((await login(uniqueEmail('v6'), 'nope-nope-nope', '2001:db8:77:2::1')).status).toBe(401);
    const root = await t.superAdminSession();
    const failed = await t.req('GET', '/api/platform/security/failed-sign-ins?q=2001:db8:77', {
      cookie: root.cookie,
    });
    expect(failed.body.locks).toEqual([expect.objectContaining({ scope: 'ip', key: '2001:db8:77:1::/64' })]);
  });
});

describe('Follow-up: stored addresses', () => {
  it('a bad stored value never breaks an IPv6 sign-in; only valid, normalised addresses are stored', async () => {
    for (const bad of ['fe80::1%eth0', ':::garbage::', 'not-an-ip', '2001:db8:99:1::zz'])
      await q(
        `INSERT INTO login_failures (at, email_norm, ip, reason) VALUES ($1, 'bad@example.test', $2, 'password')`,
        [t.clock.now(), bad],
      );
    const r = await login(uniqueEmail('v6ok'), 'nope-nope-nope', '2001:db8:99:1::7');
    expect(r.status).toBe(401);
    const root = await t.superAdminSession();
    expect(
      (await t.req('GET', '/api/platform/security/failed-sign-ins', { cookie: root.cookie })).status,
    ).toBe(200);

    expect(normalizeIp('FE80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp(' 2001:DB8::1 ')).toBe('2001:db8::1');
    expect(normalizeIp('not-an-ip')).toBeNull();
    const email = uniqueEmail('zoned');
    await recordLoginFailure(t.app.ctx, { reason: 'password', email, ip: 'FE80::2%en0' });
    await recordLoginFailure(t.app.ctx, { reason: 'password', email, ip: 'garbage' });
    const stored = await q(`SELECT ip FROM login_failures WHERE email_norm=$1 ORDER BY id`, [email]);
    expect(stored.map((x) => x.ip)).toEqual(['fe80::2', null]);
  });
});
