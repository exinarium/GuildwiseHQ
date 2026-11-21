import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ORIGIN, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { latestInviteToken, messagesTo, messageText, waitForMessages } from './helpers/mailpit.ts';
import { singleOrgUser } from './helpers/single-org.ts';
import { ok } from './helpers/world.ts';

/**
 * R6 (audit F1): an Owner or Admin may not reset the password or two-factor login of a member who has access in another
 * organization; the email reset link is offered instead, and every admin reset mails the member.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

type Who = { id: string; email: string; cookie: string };
const inOrg = (org: string) => (who: Who, method: string, url: string, body?: unknown) =>
  t.req(method, url, { cookie: who.cookie, headers: { 'x-aom-org': org }, body });

const newestText = async (email: string, count = 1) => {
  const msgs = await waitForMessages(email, count);
  const newest = [...msgs].sort((a, b) => b.Created.localeCompare(a.Created))[0];
  return { subject: newest?.Subject ?? '', text: await messageText(newest?.ID as string) };
};

describe('the F1 proof of concept is refused', () => {
  it('a throwaway Owner invites the Owner of a real org, who accepts: no 2FA reset, no temporary password', async () => {
    // the attacker's throwaway org A (their personal org) and the victim, Owner of their own org B, with 2FA
    const attacker = await t.userSession(uniqueEmail('attacker'));
    const victim = await t.userSession(uniqueEmail('victim'));
    await t.enableTwoFactor(victim.id);
    const asA = inOrg(attacker.id);
    expect(
      (
        await asA(attacker, 'POST', '/api/org/invitations', {
          email: victim.email,
          role: 'member',
          projectIds: [],
        })
      ).status,
    ).toBe(201);
    const token = await latestInviteToken(victim.email, ORIGIN);
    const victimCookie = await t.login(victim.email);
    await ok(
      t.req('POST', `/api/invitations/${token}/accept-existing`, { cookie: victimCookie, body: {} }),
      201,
    );

    const twoFactor = await asA(attacker, 'POST', `/api/org/members/${victim.id}/reset-two-factor`);
    expect(twoFactor.status).toBe(409);
    expect(twoFactor.body.error.code).toBe('member_has_other_access');
    const password = await asA(attacker, 'POST', `/api/org/members/${victim.id}/reset-password`);
    expect(password.status).toBe(409);
    expect(password.body.error.code).toBe('member_has_other_access');
    expect(password.body.temporaryPassword).toBeUndefined();

    // nothing changed: 2FA on, the password still works, the victim is still signed in, no reset event
    expect(
      (await q('SELECT two_factor_enabled FROM users WHERE id=$1', [victim.id]))[0]!.two_factor_enabled,
    ).toBe(true);
    const login = await t.req('POST', '/api/auth/login', {
      body: { email: victim.email, password: PASSWORD },
    });
    expect(login.status).toBe(200);
    expect(login.body.twoFactorRequired).toBe(true);
    expect((await t.req('GET', '/api/auth/me', { cookie: victimCookie })).status).toBe(200);
    expect(
      await q(
        `SELECT 1 FROM events WHERE type IN ('MemberPasswordReset','TwoFactorDisabled') AND stream_id=$1`,
        [`user-${victim.id}`],
      ),
    ).toHaveLength(0);
  });

  it('active project access in another organization counts as other access', async () => {
    const owner = await t.userSession(uniqueEmail('owner'));
    const org = await t.createOrg(owner.id, 'Acme');
    const member = await singleOrgUser(t, uniqueEmail('guest'));
    await t.addOrgMember(org, member.id, 'member');
    const as = inOrg(org);
    // first: Acme only, so the reset is allowed in principle (checked without spending it: 2FA off -> two_factor_off)
    expect((await as(owner, 'POST', `/api/org/members/${member.id}/reset-two-factor`)).body.error.code).toBe(
      'two_factor_off',
    );
    // then a guest seat on a project of another organization
    const other = await t.userSession(uniqueEmail('other'));
    const p = await ok<any>(
      t.req('POST', '/api/projects', { cookie: other.cookie, body: { key: 'OTH', name: 'Other app' } }),
      201,
    );
    await ok(
      t.req('POST', `/api/projects/${p.project.id}/members`, {
        cookie: other.cookie,
        body: { email: member.email },
      }),
      201,
    );
    await ok(t.req('POST', `/api/projects/${p.project.id}/members/accept`, { cookie: member.cookie }));
    const r = await as(owner, 'POST', `/api/org/members/${member.id}/reset-password`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('member_has_other_access');
    await t.enableTwoFactor(member.id);
    expect((await as(owner, 'POST', `/api/org/members/${member.id}/reset-two-factor`)).body.error.code).toBe(
      'member_has_other_access',
    );
  });
});

describe('every admin reset mails the member', () => {
  it('a temporary password and a two-factor reset of a member of this org only each send a notice', async () => {
    const owner = await t.userSession(uniqueEmail('owner'));
    const org = await t.createOrg(owner.id, 'Notice Org');
    const member = await singleOrgUser(t, uniqueEmail('only'));
    await t.addOrgMember(org, member.id, 'member');
    const as = inOrg(org);
    const r = await ok<any>(as(owner, 'POST', `/api/org/members/${member.id}/reset-password`));
    const first = await newestText(member.email, 1);
    expect(first.subject).toContain('password was reset by Notice Org');
    expect(first.text).toContain('Notice Org');
    expect(first.text).toContain('127.0.0.1');
    expect(first.text).not.toContain(r.temporaryPassword);

    await t.enableTwoFactor(member.id);
    await ok(as(owner, 'POST', `/api/org/members/${member.id}/reset-two-factor`));
    const second = await newestText(member.email, 2);
    // the two-factor reset is scheduled (R17-2): W6's mail announces the 24-hour wait and names the org and the Owner
    expect(second.subject).toContain('two-factor login will be reset in 24 hours');
    expect(second.text).toContain('Notice Org');
  });
});

describe('"Email a reset link"', () => {
  it('works for a member with access elsewhere: the link names the org, works once, and is an audit event', async () => {
    const owner = await t.userSession(uniqueEmail('owner'));
    const org = await t.createOrg(owner.id, 'Linkers');
    const member = await t.userSession(uniqueEmail('multi')); // has a personal org: access elsewhere
    await t.addOrgMember(org, member.id, 'member');
    const as = inOrg(org);
    const r = await ok<any>(as(owner, 'POST', `/api/org/members/${member.id}/send-password-reset`));
    expect(r).toMatchObject({ sentTo: member.email });
    const mail = await newestText(member.email, 1);
    expect(mail.text).toContain('An Owner or Admin of Linkers');
    const token = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(mail.text)?.[1] as string;
    expect(token).toBeTruthy();
    // the member, not the admin, sets the password
    expect(
      (
        await t.req('POST', '/api/auth/password-reset/confirm', {
          body: { token, password: 'a-new-password-77' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await t.req('POST', '/api/auth/login', {
          body: { email: member.email, password: 'a-new-password-77' },
        })
      ).status,
    ).toBe(200);
    const ev = await q(
      `SELECT payload, org_id FROM events WHERE type='PasswordResetLinkSent' AND stream_id=$1`,
      [`user-${member.id}`],
    );
    expect(ev).toHaveLength(1);
    expect(ev[0]!.payload).toMatchObject({ userId: member.id, by: owner.id, orgId: org });
    expect(ev[0]!.org_id).toBe(org);
  });

  it('follows the reset role rules and allows 3 an hour per person', async () => {
    const owner = await t.userSession(uniqueEmail('owner'));
    const org = await t.createOrg(owner.id, 'Rules');
    const admin = await t.userSession(uniqueEmail('admin'));
    const member = await t.userSession(uniqueEmail('member'));
    await t.addOrgMember(org, admin.id, 'admin');
    await t.addOrgMember(org, member.id, 'member');
    const as = inOrg(org);
    const send = (who: Who, target: string) =>
      as(who, 'POST', `/api/org/members/${target}/send-password-reset`);
    expect((await send(member, admin.id)).status).toBe(403);
    expect((await send(admin, owner.id)).status).toBe(403);
    expect((await send(admin, admin.id)).status).toBe(409);
    expect((await send(owner, '00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await send(admin, member.id)).status).toBe(200);
    expect((await send(owner, member.id)).status).toBe(200);
    expect((await send(owner, member.id)).status).toBe(200);
    const fourth = await send(owner, member.id);
    expect(fourth.status).toBe(429);
    expect(fourth.body.error.code).toBe('too_many_requests');
    expect(await messagesTo(member.email)).toHaveLength(3);
    t.clock.advance(61 * 60_000);
    // an hour later the step-up proof of these sessions is stale: the reset routes ask to confirm it's you
    const stale = await send(owner, member.id);
    expect(stale.status).toBe(403);
    expect(stale.body.error.code).toBe('step_up_required');
    expect((await as(owner, 'POST', `/api/org/members/${member.id}/reset-password`)).body.error.code).toBe(
      'step_up_required',
    );
    expect((await as(owner, 'POST', `/api/org/members/${member.id}/reset-two-factor`)).body.error.code).toBe(
      'step_up_required',
    );
    const fresh = { ...owner, cookie: await t.login(owner.email) };
    expect((await send(fresh, member.id)).status).toBe(200);
  });

  it('30 parallel requests (more than the 20 pool connections) all answer and never pass the hourly limit', async () => {
    const owner = await t.userSession(uniqueEmail('owner'));
    const org = await t.createOrg(owner.id, 'Parallel');
    const member = await t.userSession(uniqueEmail('member'));
    await t.addOrgMember(org, member.id, 'member');
    const as = inOrg(org);
    const send = () => as(owner, 'POST', `/api/org/members/${member.id}/send-password-reset`);
    const links = () =>
      q('SELECT 1 FROM password_resets WHERE user_id=$1 AND requested_by IS NOT NULL', [member.id]);
    const all = await Promise.all(Array.from({ length: 30 }, send));
    const statuses = all.map((r) => r.status);
    // a busy lock answers 429 at once instead of holding a connection while it waits
    expect(statuses.every((s) => s === 200 || s === 429)).toBe(true);
    const sent = statuses.filter((s) => s === 200).length;
    expect(sent).toBeGreaterThanOrEqual(1);
    expect(sent).toBeLessThanOrEqual(3);
    expect(await links()).toHaveLength(sent);
    // one at a time it fills up to the limit and stops there
    for (let i = sent; i < 3; i++) expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(429);
    expect(await links()).toHaveLength(3);
  }, 60_000);
});
