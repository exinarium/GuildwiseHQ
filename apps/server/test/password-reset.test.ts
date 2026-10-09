import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ORIGIN, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { messagesTo, messageText, waitForMessages } from './helpers/mailpit.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const NEW_PW = 'a-brand-new-password-42';
const request = (email: string) => t.req('POST', '/api/auth/password-reset/request', { body: { email } });
const tokenFrom = async (email: string): Promise<string> => {
  const msgs = await waitForMessages(email, 1);
  const newest = [...msgs].sort((a, b) => b.Created.localeCompare(a.Created))[0];
  const text = await messageText(newest?.ID as string);
  const m = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(text);
  if (!m) throw new Error(`no reset link in: ${text}`);
  return m[1] as string;
};
const confirm = (token: string, password = NEW_PW) =>
  t.req('POST', '/api/auth/password-reset/confirm', { body: { token, password } });

describe('forgot password', () => {
  it('answers the same for unknown and known emails, mails a hashed single-use link, and signs everyone out', async () => {
    const email = uniqueEmail('forgot');
    const u = await t.userSession(email);
    const unknown = uniqueEmail('nobody');
    const a = await request(unknown);
    const b = await request(email);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body).toEqual(a.body);
    expect(await messagesTo(unknown)).toHaveLength(0);

    const token = await tokenFrom(email);
    const stored = (
      await q('SELECT token_hash, expires_at, created_at FROM password_resets WHERE user_id=$1', [u.id])
    )[0] as any;
    expect(stored.token_hash).not.toContain(token);
    expect(new Date(stored.expires_at).getTime() - new Date(stored.created_at).getTime()).toBe(3_600_000);
    const mail = (await waitForMessages(email, 1))[0];
    expect(await messageText(mail?.ID as string)).toContain(`${ORIGIN}/reset-password/${token}`);

    expect((await t.req('GET', `/api/auth/password-reset/${token}`)).body).toEqual({ valid: true });
    expect((await confirm(token, 'short')).status).toBe(400);
    expect((await confirm(token)).status).toBe(200);

    // single use, old password gone, old session gone, and the reset itself created no session
    expect((await confirm(token, `${NEW_PW}-again`)).status).toBe(400);
    expect((await t.req('GET', `/api/auth/password-reset/${token}`)).body).toEqual({ valid: false });
    expect((await t.req('POST', '/api/auth/login', { body: { email, password: PASSWORD } })).status).toBe(
      401,
    );
    expect((await t.req('GET', '/api/auth/me', { cookie: u.cookie })).status).toBe(401);
    expect((await t.req('POST', '/api/auth/login', { body: { email, password: NEW_PW } })).status).toBe(200);
  });

  it('a second request inside two minutes sends nothing more; an expired link is refused', async () => {
    const email = uniqueEmail('forgot-twice');
    await t.userSession(email);
    await request(email);
    await request(email);
    const token = await tokenFrom(email);
    expect(await messagesTo(email)).toHaveLength(1);
    t.app.ctx.clock.advance?.(61 * 60_000);
    expect((await confirm(token)).status).toBe(400);
  });

  it('still asks for the second factor at the next sign-in', async () => {
    const email = uniqueEmail('forgot-2fa');
    const u = await t.userSession(email);
    await t.enableTwoFactor(u.id);
    await request(email);
    expect((await confirm(await tokenFrom(email))).status).toBe(200);
    const login = await t.req('POST', '/api/auth/login', { body: { email, password: NEW_PW } });
    expect(login.body).toMatchObject({ twoFactorRequired: true });
    expect(login.cookie).toBeUndefined();
  });

  it('does nothing for a platform account', async () => {
    const sa = await t.superAdminSession();
    await request(sa.email);
    expect(await messagesTo(sa.email)).toHaveLength(0);
  });
});

describe('a super admin sends a reset link', () => {
  it('mails the user, records it in the platform audit log, and refuses non-admins and platform accounts', async () => {
    const sa = await t.superAdminSession();
    const email = uniqueEmail('target');
    const u = await t.userSession(email);
    const other = await t.userSession(uniqueEmail('plain'));

    expect(
      (await t.req('POST', `/api/platform/users/${u.id}/send-password-reset`, { cookie: other.cookie }))
        .status,
    ).toBe(404);
    const sent = await ok<any>(
      t.req('POST', `/api/platform/users/${u.id}/send-password-reset`, { cookie: sa.cookie }),
    );
    expect(sent.sentTo).toBe(email);
    const token = await tokenFrom(email);
    const text = await messageText((await waitForMessages(email, 1))[0]?.ID as string);
    expect(text).toContain('team sent you this link');

    const audit = await q(
      `SELECT summary FROM platform_audit_log WHERE action='PasswordResetLinkSent' AND target_user_id=$1`,
      [u.id],
    );
    expect(audit).toHaveLength(1);
    const users = await ok<any>(t.req('GET', '/api/platform/users', { cookie: sa.cookie }));
    expect(users.users.find((x: any) => x.id === u.id).passwordResetSentAt).toBeTruthy();

    expect((await confirm(token)).status).toBe(200);
    expect((await t.req('POST', '/api/auth/login', { body: { email, password: NEW_PW } })).status).toBe(200);

    expect(
      (await t.req('POST', `/api/platform/users/${sa.id}/send-password-reset`, { cookie: sa.cookie })).status,
    ).toBe(409);
    expect(
      (
        await t.req('POST', '/api/platform/users/00000000-0000-4000-8000-000000000000/send-password-reset', {
          cookie: sa.cookie,
        })
      ).status,
    ).toBe(404);
  });
});
