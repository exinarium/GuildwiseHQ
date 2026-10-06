import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, PASSWORD, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { fullFields, ok, pairWorkstation } from './helpers/world.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

interface Person {
  id: string;
  email: string;
  cookie: string;
  workstationId: string;
}
/** A fresh organization `Acme` with an Owner, an Admin and a Member, each with a workstation, plus one project. */
async function acme() {
  const mk = async (label: string): Promise<Person> => {
    const s = await t.userSession(uniqueEmail(label));
    const ws = await pairWorkstation(t, s, `${label}-box`);
    return { ...s, workstationId: ws.workstationId };
  };
  const owner = await mk('owner');
  const admin = await mk('admin');
  const member = await mk('member');
  const org = await t.createOrg(owner.id, 'Acme');
  await t.addOrgMember(org, admin.id, 'admin');
  await t.addOrgMember(org, member.id, 'member');
  const as = (who: Person, method: string, url: string, body?: unknown) =>
    t.req(method, url, { cookie: who.cookie, headers: { 'x-aom-org': org }, body });
  const p = await ok<any>(as(owner, 'POST', '/api/projects', { key: 'ACM', name: 'Acme app' }), 201);
  const projectId = p.project.id as string;
  await ok(as(owner, 'POST', `/api/projects/${projectId}/members`, { email: member.email }), 201);
  return { owner, admin, member, org, as, projectId };
}

describe('org settings and roles', () => {
  it('the Owner and Admins rename; a Member cannot; the Owner alone sets the two-factor policy', async () => {
    const { owner, admin, member, as } = await acme();
    expect((await as(admin, 'PATCH', '/api/org', { name: 'Acme Robotics' })).status).toBe(200);
    expect((await ok<any>(as(member, 'GET', '/api/org'))).name).toBe('Acme Robotics');
    expect((await as(member, 'PATCH', '/api/org', { name: 'Hacked' })).status).toBe(403);
    expect((await as(admin, 'PATCH', '/api/org', { requireTwoFactor: true })).status).toBe(403);
    const r = await as(owner, 'PATCH', '/api/org', { name: 'Acme Inc', requireTwoFactor: false });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Acme Inc');
    expect((await as(owner, 'PATCH', '/api/org', {})).status).toBe(400);
  });

  it('lists members with role and projects; Members see the list too', async () => {
    const { owner, admin, member, as, projectId } = await acme();
    const list = await ok<any>(as(member, 'GET', '/api/org/members'));
    const by = (u: Person) => list.members.find((m: any) => m.userId === u.id);
    expect(by(owner)).toMatchObject({ role: 'owner', allProjects: true });
    expect(by(admin)).toMatchObject({ role: 'admin', allProjects: true });
    expect(by(member)).toMatchObject({ role: 'member', allProjects: false, twoFactorEnabled: false });
    expect(by(member).projects.map((p: any) => p.id)).toEqual([projectId]);
  });

  it('the Owner promotes and demotes; an Admin cannot; the Owner role only moves by transfer', async () => {
    const { owner, admin, member, as, projectId } = await acme();
    expect((await as(admin, 'PATCH', `/api/org/members/${member.id}`, { role: 'admin' })).status).toBe(403);
    expect((await as(owner, 'PATCH', `/api/org/members/${member.id}`, { role: 'admin' })).status).toBe(200);
    // an Admin sees every project of the organization (the project's `owner` role comes from the organization)
    const second = await ok<any>(as(owner, 'POST', '/api/projects', { key: 'TWO', name: 'Second' }), 201);
    expect((await as(member, 'GET', `/api/projects/${second.project.id}`)).status).toBe(200);
    expect(
      (
        await as(member, 'PUT', `/api/projects/${projectId}/merge-policy`, {
          mergeLargeWithoutApproval: false,
        })
      ).status,
    ).toBe(200);
    expect((await as(owner, 'PATCH', `/api/org/members/${member.id}`, { role: 'member' })).status).toBe(200);
    // demoted: the grant goes, the direct access to ACM stays, TWO is gone
    expect((await as(member, 'GET', `/api/projects/${second.project.id}`)).status).toBe(404);
    expect((await as(member, 'GET', `/api/projects/${projectId}`)).status).toBe(200);
    expect(
      (
        await as(member, 'PUT', `/api/projects/${projectId}/merge-policy`, {
          mergeLargeWithoutApproval: false,
        })
      ).status,
    ).toBe(403);
    const r = await as(owner, 'PATCH', `/api/org/members/${owner.id}`, { role: 'member' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('owner_role_via_transfer');
  });

  it('the Owner or an Admin gives a Member projects; removing a project hands their work back', async () => {
    const { owner, member, as, projectId } = await acme();
    const two = await ok<any>(as(owner, 'POST', '/api/projects', { key: 'TWO', name: 'Second' }), 201);
    const r = await as(owner, 'PUT', `/api/org/members/${member.id}/projects`, {
      projectIds: [two.project.id],
    });
    expect(r.status).toBe(200);
    expect((await as(member, 'GET', `/api/projects/${two.project.id}`)).status).toBe(200);
    expect((await as(member, 'GET', `/api/projects/${projectId}`)).status).toBe(404);
    expect(
      (await as(member, 'PUT', `/api/org/members/${member.id}/projects`, { projectIds: [] })).status,
    ).toBe(403);
  });
});

describe('removing and leaving', () => {
  it('removal gives the member’s agents and cards to the Owner and ends their access, nothing else', async () => {
    const { owner, admin, member, org, as, projectId } = await acme();
    // the member hires an agent for the project and owns a card; they are also in a second organization of their own
    const agent = await ok<any>(
      as(member, 'POST', '/api/agents', {
        name: 'Mia',
        roleKey: 'builder',
        seniority: 'junior',
        workstationId: member.workstationId,
        projectId,
        runtime: 'mock',
        model: 'mock',
      }),
      201,
    );
    const card = await ok<any>(
      as(member, 'POST', '/api/cards', {
        projectId,
        title: 'Mine',
        cardType: 'feature',
        fields: fullFields(),
        completionAction: 'merge',
        specify: false,
      }),
      201,
    );
    const preview = await ok<any>(as(owner, 'GET', `/api/org/members/${member.id}/removal-preview`));
    expect(preview.agents.map((a: any) => a.name)).toContain('Mia');
    expect(preview.transferredCards.map((c: any) => c.ref)).toContain(card.card.ref);
    expect((await as(admin, 'DELETE', `/api/org/members/${owner.id}`)).status).toBe(409);
    expect((await as(member, 'DELETE', `/api/org/members/${admin.id}`)).status).toBe(403);
    const r = await as(owner, 'DELETE', `/api/org/members/${member.id}`);
    expect(r.status).toBe(200);
    expect(r.body.members.map((m: any) => m.userId)).not.toContain(member.id);
    expect(
      (await q('SELECT status FROM org_members WHERE org_id=$1 AND user_id=$2', [org, member.id]))[0]!.status,
    ).toBe('removed');
    const a = (
      await q('SELECT manager_user_id, status, workstation_id FROM agents WHERE id=$1', [agent.id])
    )[0]!;
    expect(a).toMatchObject({ manager_user_id: owner.id, status: 'needs_rehome', workstation_id: null });
    expect((await q('SELECT owner_user_id FROM cards WHERE id=$1', [card.card.id]))[0]!.owner_user_id).toBe(
      owner.id,
    );
    expect(
      (
        await q(`SELECT status FROM project_members WHERE project_id=$1 AND user_id=$2`, [
          projectId,
          member.id,
        ])
      )[0]!.status,
    ).toBe('removed');
    // the member keeps their own organization and lost this one
    const me = await ok<any>(t.req('GET', '/api/auth/me', { cookie: member.cookie }));
    expect(me.orgs.map((o: any) => o.id)).toEqual([member.id]);
    expect(me.visibleProjectIds).toEqual([]);
    expect((await as(member, 'GET', '/api/org')).status).toBe(403);
    // the DevOps engineer of their workstation in Acme is retired; their own organization's one is not
    const devops = await q(
      `SELECT org_id, status FROM agents WHERE workstation_id=$1 AND is_devops ORDER BY org_id`,
      [member.workstationId],
    );
    expect(devops.find((d) => d.org_id === org)?.status).toBe('retired');
    expect(devops.find((d) => d.org_id === member.id)?.status).toBe('active');
  });

  it('a Member leaves; the Owner cannot, and an Admin removes Members but not Admins', async () => {
    const { owner, admin, member, as } = await acme();
    expect((await as(owner, 'DELETE', '/api/org/members/me')).status).toBe(409);
    expect((await as(admin, 'DELETE', `/api/org/members/${member.id}`)).status).toBe(200);
    const again = await as(member, 'DELETE', '/api/org/members/me');
    expect([403, 404]).toContain(again.status);
    expect((await as(admin, 'DELETE', `/api/org/members/${admin.id}`)).status).toBe(403); // an Admin leaves, not removes
  });

  it('leaving as a Member works', async () => {
    const { member, org, as } = await acme();
    const r = await as(member, 'DELETE', '/api/org/members/me');
    expect(r.status).toBe(200);
    expect(
      (await q('SELECT status FROM org_members WHERE org_id=$1 AND user_id=$2', [org, member.id]))[0]!.status,
    ).toBe('removed');
  });
});

describe('transferring ownership', () => {
  it('needs the password and an active member; the old Owner becomes an Admin', async () => {
    const { owner, admin, member, org, as, projectId } = await acme();
    expect(
      (await as(admin, 'POST', '/api/org/transfer-ownership', { userId: member.id, password: PASSWORD }))
        .status,
    ).toBe(403);
    expect(
      (
        await as(owner, 'POST', '/api/org/transfer-ownership', {
          userId: admin.id,
          password: 'wrong-password-123',
        })
      ).status,
    ).toBe(400);
    expect(
      (await as(owner, 'POST', '/api/org/transfer-ownership', { userId: owner.id, password: PASSWORD }))
        .status,
    ).toBe(400);
    const stranger = await t.userSession(uniqueEmail('s'));
    expect(
      (await as(owner, 'POST', '/api/org/transfer-ownership', { userId: stranger.id, password: PASSWORD }))
        .status,
    ).toBe(404);
    expect(
      (await as(owner, 'POST', '/api/org/transfer-ownership', { userId: member.id, password: PASSWORD }))
        .status,
    ).toBe(200);
    const roles = await q('SELECT user_id, role FROM org_members WHERE org_id=$1', [org]);
    expect(roles.find((r) => r.user_id === member.id)!.role).toBe('owner');
    expect(roles.find((r) => r.user_id === owner.id)!.role).toBe('admin');
    expect((await q('SELECT owner_user_id FROM organizations WHERE id=$1', [org]))[0]!.owner_user_id).toBe(
      member.id,
    );
    // the new Owner is a manager of every project; exactly one Owner remains
    expect(
      (
        await as(member, 'PUT', `/api/projects/${projectId}/merge-policy`, {
          mergeLargeWithoutApproval: false,
        })
      ).status,
    ).toBe(200);
    expect(roles.filter((r) => r.role === 'owner')).toHaveLength(1);
  });
});

describe('two-factor policy of an organization', () => {
  it('members without it are held at the setup until they have it; the Owner can reset a member', async () => {
    const { owner, member, as } = await acme();
    const early = await as(owner, 'PATCH', '/api/org', { requireTwoFactor: true });
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('owner_two_factor_needed');
    await t.enableTwoFactor(owner.id);
    await ok(as(owner, 'PATCH', '/api/org', { requireTwoFactor: true }));
    const me = await ok<any>(t.req('GET', '/api/auth/me', { cookie: member.cookie }));
    expect(me.twoFactor).toMatchObject({ enabled: false, required: true, setupRequired: true });
    const blocked = await as(member, 'GET', '/api/projects');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('two_factor_setup_required');
    // setting it up opens the door again
    await t.enableTwoFactor(member.id);
    expect((await as(member, 'GET', '/api/projects')).status).toBe(200);
    const list = await ok<any>(as(owner, 'GET', '/api/org/members'));
    expect(list.members.find((m: any) => m.userId === member.id).twoFactorEnabled).toBe(true);
    // the Owner resets a member who lost their phone
    expect((await as(owner, 'POST', `/api/org/members/${member.id}/reset-two-factor`)).status).toBe(200);
    expect(
      (await q('SELECT two_factor_enabled FROM users WHERE id=$1', [member.id]))[0]!.two_factor_enabled,
    ).toBe(false);
    expect((await t.req('GET', '/api/auth/me', { cookie: member.cookie })).status).toBe(401); // sessions ended
  });
});

describe('the DevOps engineer per organization and workstation', () => {
  it('joining an organization hires its engineer on the member’s workstations; pairing hires one per organization', async () => {
    const u = await t.userSession(uniqueEmail('multi'));
    const first = await pairWorkstation(t, u, 'Desk');
    const own = await q(
      `SELECT org_id FROM agents WHERE workstation_id=$1 AND is_devops AND status='active'`,
      [first.workstationId],
    );
    expect(own.map((a) => a.org_id)).toEqual([u.id]);
    const owner = await t.userSession(uniqueEmail('o'));
    const org = await t.createOrg(owner.id, 'Hooli');
    const email = u.email;
    await t.req('POST', '/api/org/invitations', {
      cookie: owner.cookie,
      headers: { 'x-aom-org': org },
      body: { email, role: 'member' },
    });
    const { latestInviteToken } = await import('./helpers/mailpit.ts');
    const token = await latestInviteToken(email, 'http://aom.test');
    await ok(t.req('POST', `/api/invitations/${token}/accept-existing`, { cookie: u.cookie, body: {} }), 201);
    const after = await q(
      `SELECT org_id FROM agents WHERE workstation_id=$1 AND is_devops AND status='active' ORDER BY org_id`,
      [first.workstationId],
    );
    expect(after.map((a) => a.org_id).sort()).toEqual([u.id, org].sort());
    // a second workstation gets one for each organization at once
    const second = await pairWorkstation(t, u, 'Laptop');
    const both = await q(
      `SELECT org_id FROM agents WHERE workstation_id=$1 AND is_devops AND status='active'`,
      [second.workstationId],
    );
    expect(both.map((a) => a.org_id).sort()).toEqual([u.id, org].sort());
    // and they do not count against any limit
    expect(
      (await ok<any>(t.req('GET', '/api/org', { cookie: owner.cookie, headers: { 'x-aom-org': org } })))
        .usage,
    ).toMatchObject({ agents: 0, workstations: 0 });
  });
});
