import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ORIGIN, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { latestInviteToken, messagesTo, waitForMessages } from './helpers/mailpit.ts';

let t: TestApp;
let admin: { cookie: string };
beforeAll(async () => {
  t = await createTestApp();
  admin = await t.userSession(uniqueEmail('admin'), 'admin');
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const invite = (email: string) =>
  t.req('POST', '/api/admin/invitations', { cookie: admin.cookie, body: { email, role: 'member' } });

describe('invitations', () => {
  it('emails a link, accepts once, logs in, and cannot be reused', async () => {
    const email = uniqueEmail('invitee');
    const r = await invite(email);
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('pending');
    const token = await latestInviteToken(email, ORIGIN);
    const stored = await q('SELECT token_hash FROM invitations WHERE email=$1', [email]);
    expect(stored[0]!.token_hash).not.toBe(token);

    const info = await t.req('GET', `/api/invitations/${token}`);
    expect(info.status).toBe(200);
    expect(info.body.email).toBe(email);

    const accept = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'New Person', password: 'a-long-enough-password' },
    });
    expect(accept.status).toBe(201);
    expect(accept.cookie).toBeTruthy();
    expect(accept.body.user.email).toBe(email);
    const me = await t.req('GET', '/api/auth/me', { cookie: accept.cookie });
    expect(me.body.user.displayName).toBe('New Person');
    const login = await t.req('POST', '/api/auth/login', {
      body: { email, password: 'a-long-enough-password' },
    });
    expect(login.status).toBe(200);

    const again = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'Again', password: 'a-long-enough-password' },
    });
    expect(again.status).toBe(404);
    expect((await t.req('GET', `/api/invitations/${token}`)).status).toBe(404);
  });

  it('rejects an expired token (clock shifted past 7 days)', async () => {
    const email = uniqueEmail('expired');
    await invite(email);
    const token = await latestInviteToken(email, ORIGIN);
    t.clock.advance(7 * 24 * 3600_000 + 60_000);
    try {
      expect((await t.req('GET', `/api/invitations/${token}`)).status).toBe(404);
      const r = await t.req('POST', `/api/invitations/${token}/accept`, {
        body: { displayName: 'Late', password: 'a-long-enough-password' },
      });
      expect(r.status).toBe(404);
    } finally {
      t.clock.setOffset(0);
    }
  });

  it('rejects a revoked token', async () => {
    const email = uniqueEmail('revoked');
    const r = await invite(email);
    const token = await latestInviteToken(email, ORIGIN);
    const rev = await t.req('POST', `/api/admin/invitations/${r.body.id}/revoke`, { cookie: admin.cookie });
    expect(rev.status).toBe(200);
    expect(rev.body.status).toBe('revoked');
    const acc = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'X', password: 'a-long-enough-password' },
    });
    expect(acc.status).toBe(404);
    // revoked again is a conflict
    expect(
      (await t.req('POST', `/api/admin/invitations/${r.body.id}/revoke`, { cookie: admin.cookie })).status,
    ).toBe(409);
  });

  it('resend invalidates the previous link and sends a new mail', async () => {
    const email = uniqueEmail('resend');
    const r = await invite(email);
    const oldToken = await latestInviteToken(email, ORIGIN);
    await new Promise((res) => setTimeout(res, 1100)); // distinct mail timestamps
    expect(
      (await t.req('POST', `/api/admin/invitations/${r.body.id}/resend`, { cookie: admin.cookie })).status,
    ).toBe(200);
    await waitForMessages(email, 2);
    const newToken = await latestInviteToken(email, ORIGIN, 2);
    expect(newToken).not.toBe(oldToken);
    expect((await t.req('GET', `/api/invitations/${oldToken}`)).status).toBe(404);
    const ok = await t.req('POST', `/api/invitations/${newToken}/accept`, {
      body: { displayName: 'Resent', password: 'a-long-enough-password' },
    });
    expect(ok.status).toBe(201);
  });

  it('refuses duplicate pending invitations and existing users', async () => {
    const email = uniqueEmail('dup');
    expect((await invite(email)).status).toBe(201);
    expect((await invite(email)).status).toBe(409);
    const existing = uniqueEmail('existing');
    await t.createUser(existing);
    expect((await invite(existing)).status).toBe(409);
    expect(await messagesTo(existing)).toHaveLength(0);
  });

  it('is admin only', async () => {
    const member = await t.userSession(uniqueEmail('member'));
    const r = await t.req('POST', '/api/admin/invitations', {
      cookie: member.cookie,
      body: { email: uniqueEmail(), role: 'member' },
    });
    expect(r.status).toBe(403);
    expect((await t.req('GET', '/api/admin/invitations')).status).toBe(401);
  });
});
