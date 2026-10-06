import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool } from './helpers/db.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

/**
 * Event visibility per role (docs/design/organizations.md section 6): organization events reach the Owner and Admins in
 * full and Members payload-stripped; project events reach people on the project; `user` events reach their user only;
 * a super admin sees the platform audience only. Live fan-out and replay agree.
 */
let w: World;
let acme: string;
let admin: { id: string; cookie: string };
let member: { id: string; cookie: string };
let guest: { id: string; cookie: string; email: string };
let outsider: { id: string; cookie: string };

beforeAll(async () => {
  w = await createWorld({ listen: true });
  admin = await w.t.userSession(uniqueEmail('admin'));
  member = await w.t.userSession(uniqueEmail('member'));
  guest = await w.t.userSession(uniqueEmail('guest'));
  outsider = await w.t.userSession(uniqueEmail('out'));
  // Acme: owned by the world's owner under a distinct organization id
  acme = await w.t.createOrg(w.owner.id, 'Acme');
  await w.t.addOrgMember(acme, admin.id, 'admin');
  await w.t.addOrgMember(acme, member.id, 'member');
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const open = (who: { cookie: string }, org: string | null) =>
  Browser.open(w.baseUrl, who.cookie, undefined, org);
const asOwner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, headers: { 'x-aom-org': acme }, body });

describe('organization events', () => {
  it('Owner and Admin get them in full, a Member payload-stripped, outsiders and guests not at all', async () => {
    const [ownerB, adminB, memberB, outsiderB, guestB] = await Promise.all([
      open(w.owner, acme),
      open(admin, acme),
      open(member, acme),
      open(outsider, null),
      open(guest, null),
    ]);
    for (const b of [ownerB, adminB, memberB, outsiderB, guestB]) await b.hello();
    // an organization-level event: a rename
    await ok(asOwner('PATCH', '/api/org', { name: 'Acme Robotics' }));
    const named = (b: Browser) => b.events().find((e) => e.type === 'OrganizationRenamed');
    await ownerB.until(() => !!named(ownerB));
    await adminB.until(() => !!named(adminB));
    await memberB.until(() => !!named(memberB));
    expect(named(ownerB).payload).toMatchObject({ name: 'Acme Robotics' });
    expect(named(adminB).payload).toMatchObject({ name: 'Acme Robotics' });
    expect(named(memberB)).toMatchObject({
      type: 'OrganizationRenamed',
      payload: {},
      streamId: `org-${acme}`,
    });
    await outsiderB.barrier();
    await guestB.barrier();
    expect(named(outsiderB)).toBeUndefined();
    expect(named(guestB)).toBeUndefined();
    for (const b of [ownerB, adminB, memberB, outsiderB, guestB]) b.close();
  });

  it('the socket of another organization of the same user gets nothing of this one', async () => {
    // the Admin is in Acme and in their own organization: a tab on the own one sees no Acme organization events
    const own = await open(admin, admin.id);
    await own.hello();
    await ok(asOwner('PATCH', '/api/org', { name: 'Acme Robotics Ltd' }));
    await own.barrier();
    expect(own.events().some((e) => e.type === 'OrganizationRenamed')).toBe(false);
    own.close();
  });

  it('replay agrees: after reconnecting with an old seq each role gets the same view', async () => {
    const before = Number((await w.t.app.ctx.store.maxSeq()).toString());
    await ok(asOwner('PATCH', '/api/org', { name: 'Acme Replay' }));
    const [a, m, o] = await Promise.all([open(admin, acme), open(member, acme), open(outsider, null)]);
    for (const b of [a, m, o]) await b.hello(before);
    const rn = (b: Browser) => b.events().find((e) => e.type === 'OrganizationRenamed');
    expect(rn(a).payload.name).toBe('Acme Replay');
    expect(rn(m).payload).toEqual({});
    expect(rn(o)).toBeUndefined();
    for (const b of [a, m, o]) b.close();
  });
});

describe('project events', () => {
  it('reach people on the project, in any organization', async () => {
    const p = await ok<any>(
      w.t.req('POST', '/api/projects', {
        cookie: w.owner.cookie,
        headers: { 'x-aom-org': acme },
        body: { key: 'VIS', name: 'Visible' },
      }),
      201,
    );
    const pid = p.project.id;
    await ok(asOwner('POST', `/api/projects/${pid}/members`, { email: guest.email }), 201);
    await ok(w.t.req('POST', `/api/projects/${pid}/members/accept`, { cookie: guest.cookie }));
    const gb = await open(guest, null);
    const ob = await open(outsider, null);
    await gb.hello();
    await ob.hello();
    await ok(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: {
          projectId: pid,
          title: 'Seen by the guest',
          cardType: 'feature',
          fields: fullFields(),
          completionAction: 'merge',
          specify: false,
        },
      }),
      201,
    );
    await gb.until(() => gb.events().some((e) => e.type === 'CardCreated'));
    await ob.barrier();
    expect(ob.events().some((e) => e.type === 'CardCreated')).toBe(false);
    // a guest gets no organization-level events of the organization they are a guest in
    expect(gb.events().some((e) => e.streamId === `org-${acme}`)).toBe(false);
    gb.close();
    ob.close();
  });
});

describe('user events and role changes', () => {
  it('workstation events go to the workstation owner only, even if another user is an Admin of the same organization', async () => {
    const ownerB = await open(w.owner, acme);
    const adminB = await open(admin, acme);
    await ownerB.hello();
    await adminB.hello();
    const r = await w.connectRunner();
    await ownerB.until(() => ownerB.events().some((e) => e.type === 'WorkstationConnected'));
    await adminB.barrier();
    expect(adminB.events().some((e) => e.type === 'WorkstationConnected')).toBe(false);
    expect(ownerB.events().find((e) => e.type === 'WorkstationConnected').streamId).toBe(
      `workstation-${w.workstationId}`,
    );
    r.close();
    ownerB.close();
    adminB.close();
  });

  it('a promoted Member’s socket is told to resync, and then gets full payloads', async () => {
    const m2 = await w.t.userSession(uniqueEmail('m2'));
    await w.t.addOrgMember(acme, m2.id, 'member');
    const b = await open(m2, acme);
    await b.hello();
    await ok(asOwner('PATCH', `/api/org/members/${m2.id}`, { role: 'admin' }));
    await until(async () => b.of('resync').length > 0, 5000, 'resync');
    await ok(asOwner('PATCH', '/api/org', { name: 'Acme After Promotion' }));
    await b.until(() =>
      b.events().some((e) => e.type === 'OrganizationRenamed' && e.payload.name === 'Acme After Promotion'),
    );
    b.close();
  });

  it('a socket opened for an organization the user is not in is refused', async () => {
    const b = await open(outsider, acme);
    await until(async () => b.closed, 3000, 'closed');
    expect(b.closed?.code).toBe(4403);
  });

  it('a super admin sees the admin audience only', async () => {
    const root = await w.t.superAdminSession();
    const b = await open(root, null);
    await b.hello();
    await ok(
      w.t.req('POST', '/api/platform/invitations', {
        cookie: root.cookie,
        body: { email: uniqueEmail('inv'), proposedOrgName: 'Z' },
      }),
      201,
    );
    await ok(asOwner('PATCH', '/api/org', { name: 'Acme Hidden' }));
    await b.until(() => b.events().some((e) => e.type === 'OrgInvitationCreated'));
    await b.barrier();
    expect(b.events().some((e) => e.type === 'OrganizationRenamed')).toBe(false);
    expect(
      b.events().every((e) => e.streamId.startsWith('invitation-') || e.streamId.startsWith('user-')),
    ).toBe(true);
    b.close();
  });
});
