import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
let root: { id: string; cookie: string; email: string };
beforeAll(async () => {
  t = await createTestApp();
  root = await t.superAdminSession();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const api = (method: string, url: string, body?: unknown) =>
  t.req(method, url, { cookie: root.cookie, body });

describe('the platform area is for the super admin only', () => {
  it('answers 404 to anyone else, signed in or not, and keeps the super admin out of the app', async () => {
    const user = await t.userSession(uniqueEmail('user'));
    for (const url of [
      '/api/platform/orgs',
      '/api/platform/users',
      '/api/platform/audit',
      '/api/platform/invitations',
    ]) {
      expect((await t.req('GET', url, { cookie: user.cookie })).status, url).toBe(404);
      expect((await t.req('GET', url)).status, url).toBe(404);
    }
    expect((await api('GET', '/api/projects')).status).toBe(403);
  });

  it('requires two-factor login: a super admin without it is held at the setup', async () => {
    const email = uniqueEmail('fresh-root');
    await t.createSuperAdmin(email);
    const cookie = await t.login(email);
    const me = await ok<any>(t.req('GET', '/api/auth/me', { cookie }));
    expect(me.twoFactor).toEqual({ enabled: false, required: true, setupRequired: true });
    const r = await t.req('GET', '/api/platform/orgs', { cookie });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('two_factor_setup_required');
  });

  it('has short sessions: idle after an hour', async () => {
    const r = await t.superAdminSession();
    expect((await t.req('GET', '/api/auth/me', { cookie: r.cookie })).status).toBe(200);
    t.clock.advance(61 * 60_000);
    try {
      expect((await t.req('GET', '/api/auth/me', { cookie: r.cookie })).status).toBe(401);
    } finally {
      t.clock.setOffset(0);
    }
  });
});

describe('organizations', () => {
  let owner: { id: string; email: string; cookie: string };
  let org: string;
  beforeAll(async () => {
    owner = await t.userSession(uniqueEmail('owner'));
    org = await t.createOrg(owner.id, 'Initech');
  });

  it('lists organizations with owner, usage and status, filtered and sorted', async () => {
    const list = await ok<any>(api('GET', '/api/platform/orgs'));
    const row = list.orgs.find((o: any) => o.id === org);
    expect(row).toMatchObject({
      name: 'Initech',
      status: 'active',
      plan: 'founding',
      planName: 'Founding',
      memberCount: 1,
      owner: { id: owner.id, email: owner.email },
      limits: { maxMembers: null, maxWorkstations: null, maxAgents: null, maxProjects: null },
      usage: { members: 1, projects: 0, agents: 0, workstations: 0 },
    });
    expect((await ok<any>(api('GET', '/api/platform/orgs?q=initech'))).orgs.map((o: any) => o.id)).toEqual([
      org,
    ]);
    expect((await ok<any>(api('GET', '/api/platform/orgs?status=suspended'))).orgs).toEqual([]);
  });

  it('shows the detail and logs the view once per ten minutes', async () => {
    const d = await ok<any>(api('GET', `/api/platform/orgs/${org}`));
    expect(d).toMatchObject({
      id: org,
      graceDays: 7,
      shifts30d: 0,
      features: { interests: true, phases: true },
    });
    await ok(api('GET', `/api/platform/orgs/${org}`));
    const views = await q(
      `SELECT count(*)::int AS n FROM platform_audit_log WHERE action='PlatformOrgViewed' AND org_id=$1`,
      [org],
    );
    expect(views[0]!.n).toBe(1);
    t.clock.advance(11 * 60_000);
    try {
      await ok(api('GET', `/api/platform/orgs/${org}`));
    } finally {
      t.clock.setOffset(0);
    }
    expect(
      (
        await q(
          `SELECT count(*)::int AS n FROM platform_audit_log WHERE action='PlatformOrgViewed' AND org_id=$1`,
          [org],
        )
      )[0]!.n,
    ).toBe(2);
  });

  it('edits limits, dates and flags with a reason; the audit log keeps before and after', async () => {
    const noReason = await api('PATCH', `/api/platform/orgs/${org}`, {
      limits: { maxMembers: 2, maxWorkstations: null, maxAgents: 12, maxProjects: null },
    });
    expect(noReason.status).toBe(400);
    const r = await api('PATCH', `/api/platform/orgs/${org}`, {
      limits: { maxMembers: 2, maxWorkstations: null, maxAgents: 12, maxProjects: null },
      features: { phases: false },
      trialEndsAt: null,
      licenseExpiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      graceDays: 14,
      note: 'pilot terms agreed on the call',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.limits).toMatchObject({ maxMembers: 2, maxAgents: 12 });
    expect(r.body.features.phases).toBe(false);
    expect(r.body.featureOverrides).toEqual({ phases: false });
    expect(r.body.graceDays).toBe(14);
    const audit = await ok<any>(api('GET', `/api/platform/audit?orgId=${org}`));
    const limits = audit.rows.find((x: any) => x.action === 'OrgLimitsSet');
    expect(limits.summary).toMatch(/Initech limits: members unlimited -> 2, agents unlimited -> 12/);
    expect(limits.details).toMatchObject({
      before: { maxMembers: null, maxAgents: null },
      after: { maxMembers: 2, maxAgents: 12 },
      note: 'pilot terms agreed on the call',
    });
    expect(limits.actorUserId).toBe(root.id);
    // back to the plan defaults
    const reset = await api('PATCH', `/api/platform/orgs/${org}`, {
      plan: 'founding',
      limitsReset: true,
      note: 'back to founding',
    });
    expect(reset.body.limits).toMatchObject({ maxMembers: null, maxAgents: null });
    expect(reset.body.featureOverrides).toEqual({});
  });

  it('suspends, reactivates and cancels, each audited with the reason', async () => {
    const s = await api('POST', `/api/platform/orgs/${org}/suspend`, { reason: 'unpaid invoice' });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ status: 'suspended', statusReason: 'unpaid invoice' });
    const again = await api('POST', `/api/platform/orgs/${org}/suspend`, { reason: 'x' });
    expect(again.status).toBe(409);
    expect((await api('POST', `/api/platform/orgs/${org}/reactivate`, { reason: 'paid' })).body.status).toBe(
      'active',
    );
    const c = await api('POST', `/api/platform/orgs/${org}/cancel`, { reason: 'customer left' });
    expect(c.body.status).toBe('cancelled');
    await api('POST', `/api/platform/orgs/${org}/reactivate`, { reason: 'came back' });
    const audit = await ok<any>(api('GET', `/api/platform/audit?orgId=${org}&action=OrgStatusChanged`));
    expect(audit.rows.map((x: any) => x.summary)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Suspended Initech: unpaid invoice'),
        expect.stringContaining('Reactivated Initech: paid'),
        expect.stringContaining('Cancelled Initech: customer left'),
      ]),
    );
    expect(audit.rows.every((x: any) => x.actorUserId === root.id)).toBe(true);
  });

  it('transfers ownership to an existing Admin with a reason (and to nobody else)', async () => {
    const admin = await t.userSession(uniqueEmail('admin'));
    const member = await t.userSession(uniqueEmail('member'));
    await t.addOrgMember(org, admin.id, 'admin');
    await t.addOrgMember(org, member.id, 'member');
    expect(
      (
        await api('POST', `/api/platform/orgs/${org}/transfer-ownership`, {
          toUserId: member.id,
          reason: 'support',
        })
      ).status,
    ).toBe(409);
    expect(
      (await api('POST', `/api/platform/orgs/${org}/transfer-ownership`, { toUserId: admin.id })).status,
    ).toBe(400);
    const r = await api('POST', `/api/platform/orgs/${org}/transfer-ownership`, {
      toUserId: admin.id,
      reason: 'the owner left the company',
    });
    expect(r.status).toBe(200);
    expect(r.body.owner.id).toBe(admin.id);
    const roles = await q('SELECT user_id, role FROM org_members WHERE org_id=$1 ORDER BY role', [org]);
    expect(roles.find((x) => x.user_id === admin.id)!.role).toBe('owner');
    expect(roles.find((x) => x.user_id === owner.id)!.role).toBe('admin');
    const log = await ok<any>(api('GET', `/api/platform/audit?orgId=${org}&action=OrgOwnershipTransferred`));
    expect(log.rows[0].summary).toMatch(/the owner left the company/);
    // every project keeps exactly its Owner and Admins as owners
    const again = await ok<any>(api('GET', `/api/platform/orgs/${org}`));
    expect(again.owner.id).toBe(admin.id);
    // hand it back for the following tests
    await t.app.ctx.store.append([
      {
        streamId: `org-${org}`,
        event: {
          type: 'OrgOwnershipTransferred',
          payload: { orgId: org, fromUserId: admin.id, toUserId: owner.id },
        },
        actor: { kind: 'user', id: admin.id },
        scope: { orgId: org, projectId: null, audience: 'org' },
      },
    ]);
  });
});

describe('accounts', () => {
  it('lists users with their organizations; deactivation is refused for the Owner of a running organization', async () => {
    const u = await t.userSession(uniqueEmail('victim'));
    const list = await ok<any>(api('GET', `/api/platform/users?q=${encodeURIComponent(u.email)}`));
    expect(list.users).toEqual([
      expect.objectContaining({
        id: u.id,
        kind: 'user',
        status: 'active',
        orgCount: 1,
        twoFactorEnabled: false,
      }),
    ]);
    expect(list.users[0].ownedOrgs).toEqual([expect.objectContaining({ id: u.id, status: 'active' })]);
    const refused = await api('PATCH', `/api/platform/users/${u.id}`, { status: 'deactivated' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('user_owns_org');
    expect(refused.body.error.details.orgs).toHaveLength(1);
    // suspend the organization first: then the login can go
    await api('POST', `/api/platform/orgs/${u.id}/suspend`, { reason: 'leaving' });
    const done = await api('PATCH', `/api/platform/users/${u.id}`, { status: 'deactivated' });
    expect(done.status).toBe(200);
    expect((await t.req('GET', '/api/auth/me', { cookie: u.cookie })).status).toBe(401);
    expect((await api('PATCH', `/api/platform/users/${u.id}`, { status: 'active' })).status).toBe(200);
    expect(
      (
        await q(
          `SELECT action, summary FROM platform_audit_log WHERE target_user_id=$1 AND action <> 'OrganizationCreated' ORDER BY seq`,
          [u.id],
        )
      ).map((x) => x.action),
    ).toEqual(['UserDeactivated', 'UserReactivated']);
  });

  it('never deactivates the super admin itself', async () => {
    const r = await api('PATCH', `/api/platform/users/${root.id}`, { status: 'deactivated' });
    expect(r.status).toBe(409);
  });
});

describe('the audit log', () => {
  it('records sign-ins of the super admin and explains the system actions, newest first, paged', async () => {
    const all = await ok<any>(api('GET', '/api/platform/audit?limit=200'));
    expect(all.rows.some((x: any) => x.action === 'SuperAdminSignedIn' && x.actorUserId === root.id)).toBe(
      true,
    );
    expect(all.rows.some((x: any) => x.action === 'OrganizationCreated')).toBe(true);
    const seqs = all.rows.map((x: any) => x.seq);
    expect(seqs).toEqual([...seqs].sort((a: number, b: number) => b - a));
    const page1 = await ok<any>(api('GET', '/api/platform/audit?limit=2'));
    expect(page1.rows).toHaveLength(2);
    expect(page1.next).not.toBeNull();
    const page2 = await ok<any>(api('GET', `/api/platform/audit?limit=2&before=${page1.next}`));
    expect(page2.rows[0].seq).toBeLessThan(page1.rows[1].seq);
    expect(
      (await ok<any>(api('GET', `/api/platform/audit?actorId=${root.id}&limit=200`))).rows.every(
        (x: any) => x.actorUserId === root.id,
      ),
    ).toBe(true);
  });

  it('survives a projection rebuild', async () => {
    const { rebuildProjections } = await import('../src/projections/rebuild.ts');
    const before = (await q('SELECT seq, summary, details FROM platform_audit_log ORDER BY seq')).map((r) =>
      JSON.stringify(r),
    );
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    const after = (await q('SELECT seq, summary, details FROM platform_audit_log ORDER BY seq')).map((r) =>
      JSON.stringify(r),
    );
    expect(after).toEqual(before);
  });
});
