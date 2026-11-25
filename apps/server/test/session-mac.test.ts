import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markSecondFactor } from '../src/auth/sessions.ts';
import { totpCode, totpStep } from '../src/auth/totp.ts';
import type { Config } from '../src/config.ts';
import { withConfig } from '../src/config.ts';
import { createTestApp, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { until } from './helpers/world.ts';

/**
 * Release-readiness O5: every session row carries a seal (`auth_sessions.mac`, HMAC over id, user, expiry, second-factor
 * time and method, keyed from the two-factor key). A row inserted or edited with SQL is refused (401) and deleted; a
 * super admin's goes through the R4 reject path with reason `bad_mac`. A step-up re-seals the row only after checking
 * the stored seal and the signed-in user (design review R2-S1). Changing the two-factor key signs everyone out.
 */
let t: TestApp;
const logLines: string[] = [];
beforeAll(async () => {
  t = await createTestApp({ env: { LOG_LEVEL: 'info' }, logStream: { write: (l) => void logLines.push(l) } });
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const tokenOf = (cookie: string) => cookie.split('=')[1] as string;
const sid = (cookie: string) => sha(tokenOf(cookie));
const me = (cookie: string) => t.req('GET', '/api/auth/me', { cookie });
const rowOf = async (cookie: string) =>
  (await q('SELECT * FROM auth_sessions WHERE id=$1', [sid(cookie)]))[0];

describe('O5: the session seal', () => {
  it('a normal sign-in is sealed and works', async () => {
    const u = await t.userSession(uniqueEmail('mac-ok'));
    expect((await rowOf(u.cookie))!.mac).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await me(u.cookie)).status).toBe(200);
  });

  it('a row inserted with SQL is refused and deleted', async () => {
    const u = await t.userSession(uniqueEmail('mac-insert'));
    const token = randomBytes(32).toString('base64url');
    const now = t.clock.now();
    await q(
      `INSERT INTO auth_sessions (id, user_id, created_at, last_seen_at, expires_at, method, second_factor_at, mac)
       VALUES ($1,$2,$3,$3,$4,'password',$3,'forged')`,
      [sha(token), u.id, now, new Date(now.getTime() + 3600_000)],
    );
    expect((await me(`aom_sid=${token}`)).status).toBe(401);
    expect(await q('SELECT 1 FROM auth_sessions WHERE id=$1', [sha(token)])).toHaveLength(0);
  });

  it('a row from before the seal (no mac) is refused', async () => {
    const u = await t.userSession(uniqueEmail('mac-none'));
    await q('UPDATE auth_sessions SET mac=NULL WHERE id=$1', [sid(u.cookie)]);
    expect((await me(u.cookie)).status).toBe(401);
    expect(await rowOf(u.cookie)).toBeUndefined();
  });

  it('a session rewritten to another (non-admin) user is refused', async () => {
    const attacker = await t.userSession(uniqueEmail('mac-attacker'));
    const victim = await t.userSession(uniqueEmail('mac-victim'));
    await q('UPDATE auth_sessions SET user_id=$2 WHERE id=$1', [sid(attacker.cookie), victim.id]);
    expect((await me(attacker.cookie)).status).toBe(401);
    expect(await rowOf(attacker.cookie)).toBeUndefined();
    expect((await me(victim.cookie)).status).toBe(200);
  });

  it.each([
    ['second_factor_at', `second_factor_at = second_factor_at + interval '1 hour'`],
    ['expires_at', `expires_at = expires_at + interval '30 days'`],
    ['method', `method = 'passkey'`],
  ])('an edit of %s is refused', async (_c, set) => {
    const u = await t.userSession(uniqueEmail('mac-edit'));
    await q(`UPDATE auth_sessions SET ${set} WHERE id=$1`, [sid(u.cookie)]);
    expect((await me(u.cookie)).status).toBe(401);
  });

  it('a super admin with a bad seal goes through the R4 reject path (bad_mac)', async () => {
    const root = await t.superAdminSession();
    await q(
      `UPDATE auth_sessions SET second_factor_at = second_factor_at + interval '5 minutes' WHERE id=$1`,
      [sid(root.cookie)],
    );
    expect((await me(root.cookie)).status).toBe(401);
    const ev = await q(
      `SELECT payload FROM events WHERE type='SuperAdminSessionRejected' ORDER BY seq DESC LIMIT 1`,
    );
    expect(ev[0]?.payload).toMatchObject({
      userId: root.id,
      reason: 'bad_mac',
      sessionRef: sid(root.cookie),
    });
    expect(await rowOf(root.cookie)).toBeUndefined();
  });

  it('after a step-up the session stays valid, also under concurrent requests', async () => {
    const u = await t.userSession(uniqueEmail('mac-stepup'));
    t.clock.advance(11 * 60_000);
    try {
      const before = (await rowOf(u.cookie))!;
      const results = await Promise.all([
        t.req('POST', '/api/auth/step-up', { cookie: u.cookie, body: { password: PASSWORD } }),
        ...Array.from({ length: 12 }, () => me(u.cookie)),
        t.req('POST', '/api/auth/step-up', { cookie: u.cookie, body: { password: PASSWORD } }),
        ...Array.from({ length: 12 }, () => me(u.cookie)),
      ]);
      expect(results.map((r) => r.status)).toEqual(results.map(() => 200));
      const after = (await rowOf(u.cookie))!;
      expect(after.mac).not.toBe(before.mac);
      // the proof is fresh again (the test clock runs in real time)
      expect(t.clock.now().getTime() - new Date(after.second_factor_at).getTime()).toBeLessThan(10_000);
      expect((await me(u.cookie)).status).toBe(200);
    } finally {
      t.clock.advance(-11 * 60_000);
    }
  });

  it('a 2FA enrolment confirmed in the session re-seals it (the session keeps working)', async () => {
    const u = await t.userSession(uniqueEmail('mac-enrol'));
    const setup = await t.req('POST', '/api/auth/2fa/setup', {
      cookie: u.cookie,
      body: { password: PASSWORD },
    });
    expect(setup.status).toBe(200);
    const code = totpCode(setup.body.secret, totpStep(t.clock.now()));
    const r = await t.req('POST', '/api/auth/2fa/enable', { cookie: u.cookie, body: { code } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await me(u.cookie)).status).toBe(200);
  });

  it('R2-S1: a row rewritten between the lookup and the step-up is never re-sealed (401, deleted)', async () => {
    const attacker = await t.userSession(uniqueEmail('mac-race'));
    const root = await t.superAdminSession();
    const s = { sessionId: sid(attacker.cookie), method: 'password' as const, user: { id: attacker.id } };
    // the request passed lookupSession as the attacker; then a database writer points the row at the super admin
    await q('UPDATE auth_sessions SET user_id=$2 WHERE id=$1', [s.sessionId, root.id]);
    await expect(markSecondFactor(t.app.ctx, s, t.clock.now())).rejects.toMatchObject({
      status: 401,
      code: 'session_ended',
    });
    expect(await q('SELECT 1 FROM auth_sessions WHERE id=$1', [s.sessionId])).toHaveLength(0);
  });

  it('R2-S1: a row whose stored seal no longer matches is not re-sealed, even for the same user', async () => {
    const u = await t.userSession(uniqueEmail('mac-race2'));
    const s = { sessionId: sid(u.cookie), method: 'password' as const, user: { id: u.id } };
    await q(`UPDATE auth_sessions SET expires_at = expires_at + interval '300 days' WHERE id=$1`, [
      s.sessionId,
    ]);
    await expect(markSecondFactor(t.app.ctx, s, t.clock.now())).rejects.toMatchObject({ status: 401 });
    expect(await q('SELECT 1 FROM auth_sessions WHERE id=$1', [s.sessionId])).toHaveLength(0);
  });

  it('a change of the two-factor key signs everyone out', async () => {
    const u = await t.userSession(uniqueEmail('mac-key'));
    expect((await me(u.cookie)).status).toBe(200);
    const old = t.app.ctx.config;
    (t.app.ctx as { config: Config }).config = withConfig(old, { twoFactorKey: 'k'.repeat(48) });
    try {
      expect((await me(u.cookie)).status).toBe(401);
    } finally {
      (t.app.ctx as { config: Config }).config = old;
    }
    const again = await t.userSession(uniqueEmail('mac-key2'));
    expect((await me(again.cookie)).status).toBe(200);
  });

  describe('after the upgrade (design review S1): a session with no seal ends quietly, a wrong seal still alarms', () => {
    const ALARM = 'A forged super-admin session was refused';
    const rejected = async (sessionRef: string) =>
      q(`SELECT payload FROM events WHERE type='SuperAdminSessionRejected' AND payload->>'sessionRef'=$1`, [
        sessionRef,
      ]);
    const capture = () => {
      const sent: string[] = [];
      const real = t.app.ctx.mailer;
      t.app.ctx.mailer = { send: async (m) => void sent.push(m.subject), close() {} };
      return {
        sent,
        restore: () => {
          t.app.ctx.mailer = real;
        },
      };
    };

    it('a super admin session from before migration 3025: deleted, one info line, no event, no alarm mail', async () => {
      // past the alarm throttle of earlier tests, so a mail would show here if one were sent
      t.clock.advance(11 * 60_000);
      const m = capture();
      try {
        const root = await t.superAdminSession();
        await q('UPDATE auth_sessions SET mac=NULL WHERE id=$1', [sid(root.cookie)]);
        const before = logLines.length;
        expect((await me(root.cookie)).status).toBe(401);
        expect(await rowOf(root.cookie)).toBeUndefined();
        expect(await rejected(sid(root.cookie))).toHaveLength(0);
        await new Promise((r) => setTimeout(r, 200));
        expect(m.sent).not.toContain(ALARM);
        const lines = logLines.slice(before).filter((l) => l.includes('from before the sign-in seal'));
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0] as string).level).toBe(30); // info
        expect(lines[0]).not.toContain(sid(root.cookie)); // a short ref only
      } finally {
        m.restore();
        t.clock.advance(-11 * 60_000);
      }
    });

    it('a super admin session with a wrong seal: the R4 reject path, bad_mac, and the alarm mail', async () => {
      t.clock.advance(22 * 60_000);
      const m = capture();
      try {
        const root = await t.superAdminSession();
        await q(`UPDATE auth_sessions SET mac='forged-seal' WHERE id=$1`, [sid(root.cookie)]);
        expect((await me(root.cookie)).status).toBe(401);
        expect((await rejected(sid(root.cookie))).map((e) => e.payload.reason)).toEqual(['bad_mac']);
        await until(async () => m.sent.includes(ALARM), 5000, 'the alarm mail');
      } finally {
        m.restore();
        t.clock.advance(-22 * 60_000);
      }
    });
  });
});
