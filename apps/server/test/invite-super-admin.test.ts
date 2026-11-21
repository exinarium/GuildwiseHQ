import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { messagesTo, waitForMessages } from './helpers/mailpit.ts';
import { ok } from './helpers/world.ts';

/**
 * R8 (audit F3): inviting a super admin's email answers exactly like any other address (201, listed), so nobody can
 * find the platform operators. No mail goes out to them, and accepting is refused.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('inviting a platform account', () => {
  it('gives 201 and a listed invitation like any address, but sends no mail and cannot be accepted', async () => {
    const rootEmail = uniqueEmail('root');
    const rootId = await t.createSuperAdmin(rootEmail);
    const owner = await t.userSession(uniqueEmail('owner'));
    const as = (method: string, url: string, body?: unknown) =>
      t.req(method, url, { cookie: owner.cookie, headers: { 'x-aom-org': owner.id }, body });
    const stranger = uniqueEmail('stranger');

    const forRoot = await as('POST', '/api/org/invitations', {
      email: rootEmail,
      role: 'member',
      projectIds: [],
    });
    const forStranger = await as('POST', '/api/org/invitations', {
      email: stranger,
      role: 'member',
      projectIds: [],
    });
    expect(forRoot.status).toBe(201);
    expect(forStranger.status).toBe(201);
    const shape = (b: any, email: string) => {
      const i = b.invitations.find((x: any) => x.email === email);
      return { keys: Object.keys(i).sort(), status: i.status, orgRole: i.orgRole };
    };
    expect(shape(forRoot.body, rootEmail)).toEqual(shape(forStranger.body, stranger));

    // the stranger is mailed, the platform account is not (also not on resend)
    await waitForMessages(stranger, 1);
    const id = forRoot.body.invitations.find((x: any) => x.email === rootEmail).id;
    expect((await as('POST', `/api/org/invitations/${id}/resend`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 500));
    expect(await messagesTo(rootEmail)).toHaveLength(0);
    expect(
      await q(`SELECT 1 FROM events WHERE type='OrgInvitationCreated' AND payload->>'email'=$1`, [rootEmail]),
    ).toHaveLength(1);

    // the platform account cannot join: signed in, accepting is refused; a new account for that email too
    // (no mail carries the token, so the test gives the invitation a known one)
    const token = randomBytes(32).toString('base64url');
    await q('UPDATE invitations SET token_hash=$2 WHERE id=$1', [
      id,
      createHash('sha256').update(token).digest('hex'),
    ]);
    // a super admin without two-factor login gets two_factor_setup_required everywhere (R28): sign in as an enrolled one
    await t.enableTwoFactor(rootId);
    const rootCookie = await t.login(rootEmail);
    const existing = await t.req('POST', `/api/invitations/${token}/accept-existing`, {
      cookie: rootCookie,
      body: {},
    });
    expect(existing.status, JSON.stringify(existing.body)).toBe(409);
    expect(existing.body.error.code).toBe('super_admin_cannot_join');
    const fresh = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'Root', password: 'a-strong-password-1' },
    });
    expect(fresh.status).toBe(409);
    expect(
      await q(`SELECT 1 FROM org_members m JOIN users u ON u.id=m.user_id WHERE lower(u.email)=lower($1)`, [
        rootEmail,
      ]),
    ).toHaveLength(0);
    await ok(as('GET', '/api/org/invitations'));
  });
});

describe('no timing difference', () => {
  it('the answer never waits for the mail: invite and resend return while the mail server hangs', async () => {
    const rootEmail = uniqueEmail('root');
    await t.createSuperAdmin(rootEmail);
    const owner = await t.userSession(uniqueEmail('owner'));
    const as = (method: string, url: string, body?: unknown) =>
      t.req(method, url, { cookie: owner.cookie, headers: { 'x-aom-org': owner.id }, body });
    const mailer = t.app.ctx.mailer;
    const send = mailer.send;
    let started = 0;
    // a mail server that never answers: an awaited send would hang the request (and fail the test on its timeout)
    mailer.send = () => {
      started += 1;
      return new Promise<void>(() => {});
    };
    try {
      const stranger = uniqueEmail('stranger');
      const a = await as('POST', '/api/org/invitations', { email: stranger, role: 'member', projectIds: [] });
      const b = await as('POST', '/api/org/invitations', {
        email: rootEmail,
        role: 'member',
        projectIds: [],
      });
      expect([a.status, b.status]).toEqual([201, 201]);
      const id = a.body.invitations.find((x: any) => x.email === stranger).id;
      expect((await as('POST', `/api/org/invitations/${id}/resend`)).status).toBe(200);
      expect(started).toBe(2); // the stranger's invite and resend; none for the platform account
    } finally {
      mailer.send = send;
    }
  });
});
