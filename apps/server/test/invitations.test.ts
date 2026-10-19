import { randomUUID } from 'node:crypto';
import { streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, ORIGIN, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { latestInviteToken, messagesTo, waitForMessages } from './helpers/mailpit.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
let root: { id: string; cookie: string };
beforeAll(async () => {
  t = await createTestApp();
  root = await t.superAdminSession();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const PW = 'a-long-enough-password';
const startOrg = (email: string, over: Record<string, unknown> = {}) =>
  t.req('POST', '/api/platform/invitations', {
    cookie: root.cookie,
    body: { email, proposedOrgName: 'Globex', ...over },
  });

describe('new-organization invitations (sent by the super admin)', () => {
  it('emails a link, accepts once into a new organization the invitee owns, and cannot be reused', async () => {
    const email = uniqueEmail('invitee');
    const r = await startOrg(email, { plan: 'founding', status: 'active' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'pending', proposedOrgName: 'Globex', plan: 'founding' });
    const token = await latestInviteToken(email, ORIGIN);
    const stored = await q('SELECT token_hash, kind FROM invitations WHERE email=$1', [email]);
    expect(stored[0]!.token_hash).not.toBe(token);
    expect(stored[0]!.kind).toBe('new_org');

    const info = await t.req('GET', `/api/invitations/${token}`);
    expect(info.status).toBe(200);
    expect(info.body).toMatchObject({
      kind: 'new_org',
      email,
      proposedOrgName: 'Globex',
      accountExists: false,
      role: 'owner',
    });
    expect(info.body.terms).toMatch(/Founding/);

    const accept = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'New Person', password: PW, orgName: 'Globex Corp' },
    });
    expect(accept.status).toBe(201);
    expect(accept.cookie).toBeTruthy();
    expect(accept.body.user.email).toBe(email);
    expect(accept.body.orgs).toEqual([
      expect.objectContaining({ name: 'Globex Corp', role: 'owner', status: 'active' }),
    ]);
    expect(accept.body.activeOrg).toMatchObject({ name: 'Globex Corp', plan: 'founding', role: 'owner' });
    const org = (await q('SELECT * FROM organizations WHERE id=$1', [accept.body.activeOrg.id]))[0]!;
    expect(org).toMatchObject({
      created_via: 'invitation',
      owner_user_id: accept.body.user.id,
      status: 'active',
    });
    // the organization has its built-in CEO from the same append, with no home until the Owner pairs a workstation
    const ceos = await q(`SELECT * FROM agents WHERE org_id=$1 AND role_key='ceo' AND status <> 'retired'`, [
      org.id,
    ]);
    expect(ceos).toHaveLength(1);
    expect(ceos[0]).toMatchObject({
      is_builtin: true,
      workstation_id: null,
      hired_by_user_id: org.owner_user_id,
    });
    expect(
      (await q('SELECT enabled, training FROM ceo_settings WHERE org_id=$1', [org.id]))[0],
    ).toMatchObject({
      enabled: true,
      training: { on: false },
    });
    const login = await t.req('POST', '/api/auth/login', { body: { email, password: PW } });
    expect(login.status).toBe(200);

    const again = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'Again', password: PW },
    });
    expect(again.status).toBe(404);
    expect((await t.req('GET', `/api/invitations/${token}`)).status).toBe(404);
  });

  it('applies the terms: a trial gets its end date and limits', async () => {
    const email = uniqueEmail('trial');
    const ends = new Date(Date.now() + 30 * 86_400_000).toISOString();
    expect(
      (
        await startOrg(email, {
          status: 'trial',
          trialEndsAt: ends,
          limits: { maxMembers: 3, maxWorkstations: null, maxAgents: 5, maxProjects: null },
        })
      ).status,
    ).toBe(201);
    const token = await latestInviteToken(email, ORIGIN);
    const accept = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'Trial Owner', password: PW },
    });
    expect(accept.status).toBe(201);
    const org = (await q('SELECT * FROM organizations WHERE id=$1', [accept.body.activeOrg.id]))[0]!;
    expect(org).toMatchObject({ status: 'trial', max_members: 3, max_agents: 5, max_projects: null });
    expect(new Date(org.trial_ends_at).toISOString()).toBe(ends);
  });

  it('a trial invitation needs an end date', async () => {
    expect((await startOrg(uniqueEmail('bad'), { status: 'trial' })).status).toBe(409);
  });

  it('rejects an expired token (clock shifted past 7 days)', async () => {
    const email = uniqueEmail('expired');
    await startOrg(email);
    const token = await latestInviteToken(email, ORIGIN);
    t.clock.advance(7 * 24 * 3600_000 + 60_000);
    try {
      expect((await t.req('GET', `/api/invitations/${token}`)).status).toBe(404);
      const r = await t.req('POST', `/api/invitations/${token}/accept`, {
        body: { displayName: 'Late', password: PW },
      });
      expect(r.status).toBe(404);
    } finally {
      t.clock.setOffset(0);
    }
  });

  it('rejects a revoked token, and a second revoke is a conflict', async () => {
    const email = uniqueEmail('revoked');
    const r = await startOrg(email);
    const token = await latestInviteToken(email, ORIGIN);
    const rev = await t.req('POST', `/api/platform/invitations/${r.body.id}/revoke`, { cookie: root.cookie });
    expect(rev.status).toBe(200);
    expect(rev.body.status).toBe('revoked');
    const acc = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'X', password: PW },
    });
    expect(acc.status).toBe(404);
    expect(
      (await t.req('POST', `/api/platform/invitations/${r.body.id}/revoke`, { cookie: root.cookie })).status,
    ).toBe(409);
  });

  it('resend invalidates the previous link and sends a new mail', async () => {
    const email = uniqueEmail('resend');
    const r = await startOrg(email);
    const oldToken = await latestInviteToken(email, ORIGIN);
    await new Promise((res) => setTimeout(res, 1100)); // distinct mail timestamps
    expect(
      (await t.req('POST', `/api/platform/invitations/${r.body.id}/resend`, { cookie: root.cookie })).status,
    ).toBe(200);
    await waitForMessages(email, 2);
    const newToken = await latestInviteToken(email, ORIGIN, 2);
    expect(newToken).not.toBe(oldToken);
    expect((await t.req('GET', `/api/invitations/${oldToken}`)).status).toBe(404);
    const accepted = await t.req('POST', `/api/invitations/${newToken}/accept`, {
      body: { displayName: 'Resent', password: PW },
    });
    expect(accepted.status).toBe(201);
  });

  it('refuses a duplicate pending invitation; an existing account may be invited to start another organization', async () => {
    const email = uniqueEmail('dup');
    expect((await startOrg(email)).status).toBe(201);
    expect((await startOrg(email)).status).toBe(409);
    const existing = uniqueEmail('existing');
    await t.createUser(existing);
    expect((await startOrg(existing, { proposedOrgName: 'Second company' })).status).toBe(201);
    expect(await messagesTo(existing)).toHaveLength(1);
  });

  it('an existing account signs in with the invited email and creates the organization (no new account)', async () => {
    const email = uniqueEmail('both');
    const userId = await t.createUser(email);
    await startOrg(email, { proposedOrgName: 'Side project' });
    const token = await latestInviteToken(email, ORIGIN);
    const info = await t.req('GET', `/api/invitations/${token}`);
    expect(info.body.accountExists).toBe(true);
    // a new-account accept is refused: sign in instead
    const dup = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'Dup', password: PW },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('user_exists');
    // the wrong signed-in account is refused
    const other = await t.userSession(uniqueEmail('other'));
    const mismatch = await t.req('POST', `/api/invitations/${token}/accept-existing`, {
      cookie: other.cookie,
      body: {},
    });
    expect(mismatch.status).toBe(403);
    const cookie = await t.login(email);
    const done = await t.req('POST', `/api/invitations/${token}/accept-existing`, {
      cookie,
      body: { orgName: 'Side' },
    });
    expect(done.status).toBe(201);
    expect(done.body.orgs.map((o: any) => o.name).sort()).toEqual(
      [`${email.split('@')[0]}'s organization`, 'Side'].sort(),
    );
    expect(done.body.activeOrg).toMatchObject({ name: 'Side', role: 'owner' });
    expect(
      (await q('SELECT count(*)::int AS n FROM organizations WHERE owner_user_id=$1', [userId]))[0]!.n,
    ).toBe(2);
  });

  it('is for the super admin only', async () => {
    const member = await t.userSession(uniqueEmail('member'));
    const r = await t.req('POST', '/api/platform/invitations', {
      cookie: member.cookie,
      body: { email: uniqueEmail(), proposedOrgName: 'Nope' },
    });
    expect(r.status).toBe(404);
    expect((await t.req('GET', '/api/platform/invitations')).status).toBe(404);
    // the retired admin endpoints answer 410 with where things went
    const gone = await t.req('POST', '/api/admin/invitations', { cookie: member.cookie, body: {} });
    expect(gone.status).toBe(410);
    expect(gone.body.error.details.to).toBe('/settings/org');
  });
});

describe('organization member invitations (sent by an Owner or Admin)', () => {
  let owner: { id: string; cookie: string; email: string };
  let admin: { id: string; cookie: string };
  let org: string;
  let projectId: string;
  const as = (who: { cookie: string }, method: string, url: string, body?: unknown) =>
    t.req(method, url, { cookie: who.cookie, headers: { 'x-aom-org': org }, body });
  beforeAll(async () => {
    owner = await t.userSession(uniqueEmail('owner'));
    admin = await t.userSession(uniqueEmail('admin'));
    org = await t.createOrg(owner.id, 'Acme');
    await t.addOrgMember(org, admin.id, 'admin');
    const p = await ok<any>(as(owner, 'POST', '/api/projects', { key: 'ACM', name: 'Acme app' }), 201);
    projectId = p.project.id;
  });

  it('the Owner invites a Member with a project: mail, accept as a new account, joined and on that project only', async () => {
    const email = uniqueEmail('newbie');
    const r = await as(owner, 'POST', '/api/org/invitations', {
      email,
      role: 'member',
      projectIds: [projectId],
    });
    expect(r.status).toBe(201);
    expect(r.body.invitations[0]).toMatchObject({
      email,
      orgRole: 'member',
      status: 'pending',
      projectIds: [projectId],
    });
    const token = await latestInviteToken(email, ORIGIN);
    const info = await t.req('GET', `/api/invitations/${token}`);
    expect(info.body).toMatchObject({
      kind: 'org_member',
      orgName: 'Acme',
      role: 'member',
      invitedBy: expect.any(String),
    });
    const accept = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'Nora Newbie', password: PW },
    });
    expect(accept.status).toBe(201);
    expect(accept.body.orgs).toEqual([expect.objectContaining({ id: org, name: 'Acme', role: 'member' })]);
    expect(accept.body.visibleProjectIds).toEqual([projectId]);
    expect(accept.body.activeOrg.role).toBe('member');
    const members = await ok<any>(as(owner, 'GET', '/api/org/members'));
    expect(members.members.map((m: any) => m.email)).toContain(email);
    // an invitee does not count twice: invited and joined is one seat
    expect((await ok<any>(as(owner, 'GET', '/api/org'))).usage.members).toBe(3);
  });

  it('an existing account (a guest of the organization) joins signed in; their guest access becomes membership', async () => {
    const email = uniqueEmail('guest');
    const g = await t.userSession(email);
    await ok(as(owner, 'POST', `/api/projects/${projectId}/members`, { email }), 201);
    await ok(t.req('POST', `/api/projects/${projectId}/members/accept`, { cookie: g.cookie }));
    expect((await ok<any>(t.req('GET', '/api/auth/me', { cookie: g.cookie }))).guestIn).toHaveLength(1);
    await as(owner, 'POST', '/api/org/invitations', { email, role: 'member', projectIds: [] });
    const token = await latestInviteToken(email, ORIGIN);
    expect((await t.req('GET', '/api/auth/me', { cookie: g.cookie })).body.pendingInvitations).toBe(1);
    const done = await t.req('POST', `/api/invitations/${token}/accept-existing`, {
      cookie: g.cookie,
      body: {},
    });
    expect(done.status).toBe(201);
    expect(done.body.orgs.map((o: any) => o.id)).toContain(org);
    expect(done.body.guestIn).toEqual([]);
    expect(done.body.visibleProjectIds).toContain(projectId);
  });

  it('an Admin invites Members only; the Owner invites Admins; strangers cannot invite', async () => {
    expect(
      (await as(admin, 'POST', '/api/org/invitations', { email: uniqueEmail('x'), role: 'admin' })).status,
    ).toBe(403);
    expect(
      (await as(admin, 'POST', '/api/org/invitations', { email: uniqueEmail('y'), role: 'member' })).status,
    ).toBe(201);
    expect(
      (await as(owner, 'POST', '/api/org/invitations', { email: uniqueEmail('z'), role: 'admin' })).status,
    ).toBe(201);
    const member = await t.userSession(uniqueEmail('plain'));
    await t.addOrgMember(org, member.id, 'member');
    expect(
      (await as(member, 'POST', '/api/org/invitations', { email: uniqueEmail('w'), role: 'member' })).status,
    ).toBe(403);
  });

  it('refuses a duplicate, a current member, and invitations to projects of another organization', async () => {
    const email = uniqueEmail('dupm');
    expect((await as(owner, 'POST', '/api/org/invitations', { email, role: 'member' })).status).toBe(201);
    const dup = await as(owner, 'POST', '/api/org/invitations', { email, role: 'member' });
    expect(dup.status).toBe(409);
    const adminUser = (await q('SELECT email FROM users WHERE id=$1', [admin.id]))[0]!.email;
    expect(
      (await as(owner, 'POST', '/api/org/invitations', { email: adminUser, role: 'member' })).status,
    ).toBe(409);
    const foreign = await t.userSession(uniqueEmail('f'));
    const other = await ok<any>(
      t.req('POST', '/api/projects', { cookie: foreign.cookie, body: { key: 'FRN', name: 'Foreign' } }),
      201,
    );
    const bad = await as(owner, 'POST', '/api/org/invitations', {
      email: uniqueEmail('proj'),
      role: 'member',
      projectIds: [other.project.id],
    });
    expect(bad.status).toBe(400);
  });

  it('resend and revoke; an Admin cannot touch an Admin invitation', async () => {
    const email = uniqueEmail('rr');
    await as(owner, 'POST', '/api/org/invitations', { email, role: 'admin' });
    const list = await ok<any>(as(owner, 'GET', '/api/org/invitations'));
    const inv = list.invitations.find((i: any) => i.email === email);
    expect((await as(admin, 'POST', `/api/org/invitations/${inv.id}/revoke`)).status).toBe(403);
    expect((await as(owner, 'POST', `/api/org/invitations/${inv.id}/resend`)).status).toBe(200);
    const revoked = await as(owner, 'POST', `/api/org/invitations/${inv.id}/revoke`);
    expect(revoked.body.invitations.find((i: any) => i.id === inv.id).status).toBe('revoked');
  });

  it('a suspended organization takes no new members', async () => {
    const o2 = await t.createOrg(owner.id, 'Dormant');
    const email = uniqueEmail('sus');
    expect(
      (
        await t.req('POST', '/api/org/invitations', {
          cookie: owner.cookie,
          headers: { 'x-aom-org': o2 },
          body: { email, role: 'member' },
        })
      ).status,
    ).toBe(201);
    const token = await latestInviteToken(email, ORIGIN);
    await t.app.ctx.store.append([
      {
        streamId: streamId.org(o2),
        event: { type: 'OrgStatusChanged', payload: { orgId: o2, status: 'suspended', reason: 'manual' } },
        actor: { kind: 'system', id: null },
        scope: { orgId: o2, projectId: null, audience: 'org' },
      },
    ]);
    const r = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'Late', password: PW },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('org_suspended');
  });
});

describe('legacy invitations (sent before organizations existed)', () => {
  it('still accept: the account gets an organization of its own', async () => {
    const email = uniqueEmail('legacy');
    const invId = randomUUID();
    const token = `legacy-token-${invId}-long-enough`;
    const { createHash } = await import('node:crypto');
    await t.app.ctx.store.append([
      {
        streamId: streamId.invitation(invId),
        event: {
          type: 'UserInvited',
          payload: {
            invitationId: invId,
            email,
            role: 'member',
            tokenHash: createHash('sha256').update(token).digest('hex'),
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            invitedBy: root.id,
          },
        },
        actor: { kind: 'user', id: root.id },
        scope: { orgId: null, projectId: null, audience: 'admin' },
      },
    ]);
    const info = await t.req('GET', `/api/invitations/${token}`);
    expect(info.body.kind).toBe('legacy');
    const accept = await t.req('POST', `/api/invitations/${token}/accept`, {
      body: { displayName: 'Old Invite', password: PW },
    });
    expect(accept.status).toBe(201);
    expect(accept.body.orgs).toEqual([
      expect.objectContaining({ role: 'owner', name: "Old Invite's organization" }),
    ]);
    expect((await q('SELECT status FROM invitations WHERE id=$1', [invId]))[0]!.status).toBe('accepted');
  });
});
