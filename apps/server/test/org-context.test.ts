import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { ok } from './helpers/world.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

const withOrg = (cookie: string, orgId: string) => ({ cookie, headers: { 'x-aom-org': orgId } });

describe('organization context', () => {
  it('a plain user is the Owner of their own organization (id = user id) and me says so', async () => {
    const u = await t.userSession(uniqueEmail('solo'));
    const me = await ok<any>(t.req('GET', '/api/auth/me', { cookie: u.cookie }));
    expect(me.account.kind).toBe('user');
    expect(me.orgs).toEqual([expect.objectContaining({ id: u.id, role: 'owner', status: 'active' })]);
    expect(me.activeOrg).toMatchObject({ id: u.id, role: 'owner', plan: 'founding', planName: 'Founding' });
    expect(me.activeOrg.limits).toEqual({
      maxMembers: null,
      maxWorkstations: null,
      maxAgents: null,
      maxProjects: null,
    });
    expect(me.activeOrg.usage).toMatchObject({ members: 1, projects: 0, agents: 0, workstations: 0 });
    expect(me.activeOrg.features.interests).toBe(true);
    expect(me.isAdmin).toBe(true);
    expect(me.guestIn).toEqual([]);
    expect(me.twoFactor).toEqual({ enabled: false, required: false, setupRequired: false });
  });

  it('the X-AOM-Org header picks the organization per request; a foreign org is 403 org_forbidden', async () => {
    const owner = await t.userSession(uniqueEmail('own'));
    const ada = await t.userSession(uniqueEmail('ada'));
    const x = await t.createOrg(owner.id, 'Globex');
    await t.addOrgMember(x, ada.id, 'member');

    const own = await ok<any>(t.req('GET', '/api/org', { cookie: ada.cookie }));
    expect(own.id).toBe(ada.id); // default: her oldest membership
    const asMember = await ok<any>(t.req('GET', '/api/org', withOrg(ada.cookie, x)));
    expect(asMember).toMatchObject({ id: x, name: 'Globex', role: 'member', owner: { id: owner.id } });
    expect(asMember.limits).toBeUndefined(); // limits and usage are for the Owner and Admins only
    expect(asMember.usage).toBeUndefined();
    const asOwner = await ok<any>(t.req('GET', '/api/org', withOrg(owner.cookie, x)));
    expect(asOwner.limits).toBeDefined();
    expect(asOwner.usage.members).toBe(2);

    const stranger = await t.userSession(uniqueEmail('str'));
    const denied = await t.req('GET', '/api/org', withOrg(stranger.cookie, x));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('org_forbidden');

    // two tabs, two organizations, one session
    const me = await ok<any>(t.req('GET', '/api/auth/me', withOrg(ada.cookie, x)));
    expect(me.activeOrg.id).toBe(x);
    expect(me.orgs.map((o: any) => o.id).sort()).toEqual([ada.id, x].sort());
  });

  it('switching remembers the default for the session and refuses organizations you are not in', async () => {
    const owner = await t.userSession(uniqueEmail('own'));
    const ada = await t.userSession(uniqueEmail('ada'));
    const x = await t.createOrg(owner.id, 'Initech');
    await t.addOrgMember(x, ada.id, 'admin');
    const switched = await ok<any>(
      t.req('POST', '/api/orgs/active', { cookie: ada.cookie, body: { orgId: x } }),
    );
    expect(switched.activeOrg).toMatchObject({ id: x, role: 'admin' });
    const next = await ok<any>(t.req('GET', '/api/auth/me', { cookie: ada.cookie }));
    expect(next.activeOrg.id).toBe(x);
    const bad = await t.req('POST', '/api/orgs/active', { cookie: ada.cookie, body: { orgId: owner.id } });
    expect(bad.status).toBe(403);
    // a stale header does not lock `me` (the tab can recover) but does fail org routes
    const stale = await t.req('GET', '/api/auth/me', withOrg(ada.cookie, owner.id));
    expect(stale.status).toBe(200);
    expect(stale.body.activeOrg.id).toBe(x);
    expect((await t.req('GET', '/api/org', withOrg(ada.cookie, owner.id))).status).toBe(403);
    const list = await ok<any>(t.req('GET', '/api/orgs', { cookie: ada.cookie }));
    expect(list.orgs).toHaveLength(2);
  });

  it('a suspended organization shows its Owner a banner and refuses everyone else', async () => {
    const owner = await t.userSession(uniqueEmail('own'));
    const ada = await t.userSession(uniqueEmail('ada'));
    const x = await t.createOrg(owner.id, 'Hooli', { status: 'suspended' });
    await t.addOrgMember(x, ada.id, 'member');
    const o = await ok<any>(t.req('GET', '/api/org', withOrg(owner.cookie, x)));
    expect(o.status).toBe('suspended');
    expect(o.banners.map((b: any) => b.kind)).toContain('suspended');
    const m = await t.req('GET', '/api/org', withOrg(ada.cookie, x));
    expect(m.status).toBe(403);
    expect(m.body.error.code).toBe('org_suspended');
  });

  it('a super admin has no organization and is kept out of the app routes', async () => {
    await t.createSuperAdmin('root@platform.test');
    const cookie = await t.login('root@platform.test');
    const me = await ok<any>(t.req('GET', '/api/auth/me', { cookie }));
    expect(me).toMatchObject({ account: { kind: 'super_admin' }, orgs: [], activeOrg: null });
    const r = await t.req('GET', '/api/projects', { cookie });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('super_admin_platform_only');
    const o = await t.req('GET', '/api/org', { cookie });
    expect(o.status).toBe(403);
  });
});
