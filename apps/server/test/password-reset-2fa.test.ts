import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transportMessage } from '../src/mail/mailer.ts';
import { createTestApp, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { messagesTo, messageText, waitForMessages } from './helpers/mailpit.ts';

/**
 * Password reset with two-factor login (R3): no code or a wrong code is refused (5 wrong codes kill the link), a TOTP or a
 * recovery code completes it, at most 5 links per account a day, and the "password changed" mails (sent with tracking
 * off) for a change, a reset and a two-factor reset.
 */
let t: TestApp;
const NEW_PW = 'a-brand-new-password-42';
const API = process.env.MAILPIT_API ?? 'http://127.0.0.1:8025/api/v1';

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const request = (email: string) => t.req('POST', '/api/auth/password-reset/request', { body: { email } });
const resetMails = async (email: string) =>
  (await messagesTo(email)).filter((m) => m.Subject.startsWith('Reset your'));
const newestToken = async (email: string): Promise<string> => {
  await waitForMessages(email, 1);
  const msgs = (await resetMails(email)).sort((a, b) => b.Created.localeCompare(a.Created));
  const text = await messageText(msgs[0]?.ID as string);
  return /\/reset-password\/([A-Za-z0-9_-]+)/.exec(text)?.[1] as string;
};
const confirm = (token: string, code?: string) =>
  t.req('POST', '/api/auth/password-reset/confirm', {
    body: { token, password: NEW_PW, ...(code ? { code } : {}) },
  });

async function twoFactorUser(prefix: string) {
  const email = uniqueEmail(prefix);
  const id = await t.createUser(email);
  await t.enableTwoFactor(id);
  await request(email);
  return { email, id, token: await newestToken(email) };
}

describe('a reset of a two-factor account needs a code', () => {
  it('says so up front, refuses a missing code without spending an attempt, and works with a TOTP code', async () => {
    const u = await twoFactorUser('need');
    expect((await t.req('GET', `/api/auth/password-reset/${u.token}`)).body).toEqual({
      valid: true,
      secondFactor: true,
    });
    const none = await confirm(u.token);
    expect(none.status).toBe(400);
    expect(none.body.error.code).toBe('second_factor_required');
    expect(none.body.error.details.attemptsLeft).toBe(5);
    const ok = await confirm(u.token, await t.totpCode(u.id));
    expect(ok.status).toBe(200);
    // the password changed; the link is spent
    expect((await t.req('GET', `/api/auth/password-reset/${u.token}`)).body.valid).toBe(false);
    const r = await t.req('POST', '/api/auth/login', { body: { email: u.email, password: NEW_PW } });
    expect(r.body.twoFactorRequired).toBe(true);
  });

  it('counts wrong codes, records each, and the fifth kills the link', async () => {
    const u = await twoFactorUser('wrong');
    for (let i = 1; i <= 4; i++) {
      const r = await confirm(u.token, '000000');
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('invalid_code');
      expect(r.body.error.details.attemptsLeft).toBe(5 - i);
    }
    const fifth = await confirm(u.token, '000000');
    expect(fifth.status).toBe(400);
    expect(fifth.body.error.code).toBe('reset_link_invalid');
    expect((await t.req('GET', `/api/auth/password-reset/${u.token}`)).body.valid).toBe(false);
    // even the right code no longer works on that link
    expect((await confirm(u.token, await t.totpCode(u.id))).status).toBe(400);
    const rows = await q(`SELECT reason FROM login_failures WHERE user_id=$1`, [u.id]);
    expect(rows.filter((x) => x.reason === 'reset_second_factor')).toHaveLength(5);
    // five wrong second factors also count towards the account lock (R2): sign-in pauses
    const r = await t.req('POST', '/api/auth/login', { body: { email: u.email, password: PASSWORD } });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('too_many_attempts');
  });

  it('accepts a recovery code (legacy hash) and consumes it', async () => {
    const u = await twoFactorUser('recovery');
    const code = 'abcde-23456';
    await q(`INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [
      u.id,
      createHash('sha256').update('abcde23456').digest('hex'),
    ]);
    expect((await confirm(u.token, code)).status).toBe(200);
    const left = await q(`SELECT used_at, code_hash FROM user_recovery_codes WHERE user_id=$1`, [u.id]);
    expect(left[0]?.used_at).not.toBeNull();
    expect(String(left[0]?.code_hash)).toMatch(/^h2:[0-9a-f]{8}:/);
  });

  it('an account without two-factor resets with the password alone', async () => {
    const email = uniqueEmail('plain');
    await t.createUser(email);
    await request(email);
    const token = await newestToken(email);
    expect((await t.req('GET', `/api/auth/password-reset/${token}`)).body).toEqual({
      valid: true,
      secondFactor: false,
    });
    expect((await confirm(token)).status).toBe(200);
  });
});

describe('limits', () => {
  it('sends at most 5 links per account in 24 h, silently', async () => {
    const email = uniqueEmail('many');
    await t.createUser(email);
    for (let i = 0; i < 7; i++) {
      const r = await request(email);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
      t.clock.advance(3 * 60_000); // past the two-minute resend window
    }
    await waitForMessages(email, 5);
    await new Promise((r) => setTimeout(r, 300));
    expect(await resetMails(email)).toHaveLength(5);
    t.clock.advance(24 * 3600_000);
    await request(email);
    await waitForMessages(email, 6);
  });

  it('a blocked address gets the same answer and no mail', async () => {
    const email = uniqueEmail('blockedreset');
    await t.createUser(email);
    await q(
      `INSERT INTO platform_blocklist (id, kind, value, note, created_at) VALUES ($1,'email',$2,'',now())`,
      [randomUUID(), email],
    );
    const r = await request(email);
    expect(r.body).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(await messagesTo(email)).toHaveLength(0);
  });
});

describe('the mails', () => {
  const changedMails = async (email: string) =>
    (await messagesTo(email)).filter((m) => / was (changed|reset)$/.test(m.Subject));

  it('mails a password change, a reset and a console reset, with tracking off; not an admin 2FA reset', async () => {
    // own change
    const a = await t.userSession(uniqueEmail('change'));
    expect(
      (
        await t.req('POST', '/api/auth/password', {
          cookie: a.cookie,
          body: { current: PASSWORD, new: NEW_PW },
        })
      ).status,
    ).toBe(200);
    await waitForMessages(a.email, 1);
    const [m] = await changedMails(a.email);
    expect(m?.Subject).toContain('password was changed');
    expect(await messageText(m?.ID as string)).toContain('You changed it in your account settings.');
    const headers = (await (await fetch(`${API}/message/${m?.ID}/headers`)).json()) as Record<
      string,
      string[]
    >;
    const smtpapi = headers['X-Smtpapi'] ?? headers['X-SMTPAPI'];
    expect(JSON.parse(smtpapi?.[0] as string).filters.clicktrack.settings.enable).toBe(0);
    expect(transportMessage({ to: 'x@y.z', subject: 's', text: 't' }).headers).toBeUndefined();

    // a reset link
    const b = await twoFactorUser('resetmail');
    expect((await confirm(b.token, await t.totpCode(b.id))).status).toBe(200);
    await waitForMessages(b.email, 2);
    const resetChanged = await changedMails(b.email);
    expect(resetChanged).toHaveLength(1);
    expect(await messageText(resetChanged[0]?.ID as string)).toContain('password reset link');

    // an admin-initiated two-factor reset: the caller (orgs workstream) sends the single notice, so nothing from here
    const { disableTwoFactorIn } = await import('../src/auth/two-factor.ts');
    const { withAppendTx } = await import('../src/db/tx.ts');
    await withAppendTx(t.app.ctx.pool, (tx) =>
      disableTwoFactorIn(t.app.ctx, tx, b.id, b.id, 'reset', { kind: 'system', id: null }),
    );
    await new Promise((r) => setTimeout(r, 400));
    expect(
      (await changedMails(b.email)).filter((x) => x.Subject.includes('two-factor login was reset')),
    ).toHaveLength(0);
    // the console reset of a super admin mails the password change and the two-factor reset
    const rootEmail = uniqueEmail('console');
    await t.createSuperAdmin(rootEmail);
    const { consoleResetSuperAdminPassword } = await import('../src/commands/password-reset.ts');
    await consoleResetSuperAdminPassword(t.app.ctx, {
      email: rootEmail,
      password: 'console-new-password-1',
      resetTwoFactor: true,
    });
    await waitForMessages(rootEmail, 2);
    const console = (await changedMails(rootEmail)).map((x) => x.Subject).sort();
    expect(console).toEqual([
      expect.stringContaining('password was changed'),
      expect.stringContaining('two-factor login was reset'),
    ]);
    // the reset is in the platform audit log, whoever made it
    const audit = await q(
      `SELECT action FROM platform_audit_log WHERE target_user_id=$1 AND action IN ('PasswordChanged','TwoFactorDisabled')
        ORDER BY seq`,
      [b.id],
    );
    expect(audit.map((x) => x.action)).toEqual(['PasswordChanged', 'TwoFactorDisabled']);
  });
});

describe('Rework 1', () => {
  it('a reset request never waits for the mail server (the same timing for known and unknown addresses)', async () => {
    const email = uniqueEmail('slowmail');
    await t.createUser(email);
    const ctx = t.app.ctx as { mailer: typeof t.app.ctx.mailer };
    const real = ctx.mailer;
    let sent = 0;
    ctx.mailer = {
      send: () =>
        new Promise<void>((r) =>
          setTimeout(() => {
            sent++;
            r();
          }, 3000),
        ),
      close: () => {},
    };
    try {
      const started = Date.now();
      const r = await request(email);
      expect(r.body).toEqual({ ok: true });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(sent).toBe(0); // the mail was still on its way when the answer came
    } finally {
      ctx.mailer = real;
    }
  });
});
