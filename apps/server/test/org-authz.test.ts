import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool } from './helpers/db.ts';
import { ok, pairWorkstation } from './helpers/world.ts';

/**
 * The authorization matrix of docs/design/organizations.md section 4.2, row by row, for each role of one organization
 * (not a per-user one): Owner, Admin, Member, Guest. The organization is `Acme`, owned by `owner`.
 */
let t: TestApp;
let acme: string;
let projectId: string;
const who: Record<
  'owner' | 'admin' | 'member' | 'guest',
  { id: string; email: string; cookie: string; workstationId: string }
> = {} as never;

beforeAll(async () => {
  t = await createTestApp();
  const mk = async (label: string) => {
    const s = await t.userSession(uniqueEmail(label));
    const ws = await pairWorkstation(t, s, `${label}-box`);
    return { ...s, workstationId: ws.workstationId };
  };
  for (const r of ['owner', 'admin', 'member', 'guest'] as const) who[r] = await mk(r);
  acme = await t.createOrg(who.owner.id, 'Acme');
  await t.addOrgMember(acme, who.admin.id, 'admin');
  await t.addOrgMember(acme, who.member.id, 'member');
  const p = await ok<any>(
    t.req('POST', '/api/projects', {
      cookie: who.owner.cookie,
      headers: { 'x-aom-org': acme },
      body: { key: 'ACM', name: 'Acme app' },
    }),
    201,
  );
  projectId = p.project.id;
  // the Owner adds the Member to the project (active at once) and shares it with the Guest (who accepts)
  await ok(
    t.req('POST', `/api/projects/${projectId}/members`, {
      cookie: who.owner.cookie,
      body: { email: who.member.email },
    }),
    201,
  );
  await ok(
    t.req('POST', `/api/projects/${projectId}/members`, {
      cookie: who.owner.cookie,
      body: { email: who.guest.email },
    }),
    201,
  );
  await ok(t.req('POST', `/api/projects/${projectId}/members/accept`, { cookie: who.guest.cookie }));
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

// A guest is not a member of Acme: their tab works in their own organization, the project's organization decides.
const call = (
  role: keyof typeof who,
  method: string,
  url: string,
  body?: unknown,
  asOwnOrg = role === 'guest',
) =>
  t.req(method, url, {
    cookie: who[role].cookie,
    ...(asOwnOrg ? {} : { headers: { 'x-aom-org': acme } }),
    body,
  });

describe('org roles', () => {
  it('derives the roles: Member and Guest see the project, the Guest is not a member of Acme', async () => {
    const guest = await ok<any>(call('guest', 'GET', '/api/projects'));
    expect(guest.projects.map((p: any) => p.key)).toContain('ACM');
    expect((await call('guest', 'GET', '/api/org', undefined, false)).status).toBe(403); // a guest is not a member of Acme
    const me = await ok<any>(t.req('GET', '/api/auth/me', { cookie: who.guest.cookie }));
    expect(me.guestIn).toEqual([expect.objectContaining({ orgId: acme, orgName: 'Acme' })]);
    expect(me.guestProjectIds).toEqual([projectId]);
    const proj = await ok<any>(call('member', 'GET', `/api/projects/${projectId}`));
    const roles = proj.members.map((m: any) => `${m.email}:${m.role}`);
    expect(roles).toContain(`${who.owner.email}:owner`);
    expect(roles).toContain(`${who.admin.email}:owner`); // the Admin has the organization grant too
    expect(roles).toContain(`${who.member.email}:manager`);
  });

  it.each([
    ['owner', 201],
    ['admin', 201],
    ['member', 403],
    ['guest', 201], // a guest's own organization, not Acme
  ] as const)('create a project: %s -> %s', async (role, status) => {
    const key = `P${Math.floor(Math.random() * 90000 + 10000)}`;
    const r = await call(role, 'POST', '/api/projects', { key, name: 'New' });
    expect(r.status).toBe(status);
    if (status === 201) expect(r.body.project.orgId).toBe(role === 'guest' ? who.guest.id : acme);
  });

  it.each([
    ['owner', 201],
    ['admin', 201],
    ['member', 403],
    ['guest', 403],
  ] as const)('add people to a project: %s -> %s', async (role, status) => {
    const other = await t.userSession(uniqueEmail('someone'));
    const r = await call(role, 'POST', `/api/projects/${projectId}/members`, { email: other.email });
    expect(r.status).toBe(status);
  });

  it('an unknown email is told to join the organization first', async () => {
    const r = await call('owner', 'POST', `/api/projects/${projectId}/members`, {
      email: 'nobody@nowhere.test',
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('user_not_found');
    expect(r.body.error.message).toMatch(/organization/i);
  });

  it.each([
    ['owner', 200],
    ['admin', 200],
    ['member', 403],
  ] as const)('project settings, repos and merge policy: %s -> %s', async (role, status) => {
    const r = await call(role, 'PUT', `/api/projects/${projectId}/merge-policy`, {
      mergeLargeWithoutApproval: false,
    });
    expect(r.status).toBe(status);
  });

  it.each([
    ['owner', 201],
    ['admin', 201],
    ['member', 403], // org-wide hire
  ] as const)('hire an org-wide agent: %s -> %s', async (role, status) => {
    const r = await call(role, 'POST', '/api/agents', {
      name: `Agent-${role}`,
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: who[role].workstationId,
      runtime: 'mock',
      model: 'mock',
    });
    expect(r.status).toBe(status);
  });

  it.each([
    ['owner', 201],
    ['admin', 201],
    ['member', 201],
    ['guest', 201],
  ] as const)('hire a project-scoped agent on your own workstation: %s -> %s', async (role, status) => {
    const r = await call(role, 'POST', '/api/agents', {
      name: `Scoped-${role}`,
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: who[role].workstationId,
      projectId,
      runtime: 'mock',
      model: 'mock',
    });
    expect(r.status).toBe(status);
    expect(r.body.orgId).toBe(acme);
  });

  it('a member changes and fires their own hire but not someone else’s; an Admin changes any', async () => {
    const mine = (await ok<any>(call('member', 'GET', '/api/agents'))).agents.find(
      (a: any) => a.name === 'Scoped-member',
    );
    const owners = (await ok<any>(call('member', 'GET', '/api/agents'))).agents.find(
      (a: any) => a.name === 'Scoped-owner',
    );
    expect((await call('member', 'PATCH', `/api/agents/${mine.id}`, { capacity: 2 })).status).toBe(200);
    expect((await call('member', 'PATCH', `/api/agents/${owners.id}`, { capacity: 2 })).status).toBe(403);
    expect((await call('admin', 'PATCH', `/api/agents/${mine.id}`, { capacity: 3 })).status).toBe(200);
    // widening permissions is for the Owner and Admins
    const widen = {
      permissions: { ...mine.permissions, mayCommit: true, allowedTools: ['read', 'shell', 'edit', 'web'] },
    };
    const m = await call('member', 'PATCH', `/api/agents/${mine.id}`, widen);
    expect([400, 403]).toContain(m.status);
  });

  it.each([
    ['owner', 201],
    ['admin', 201],
    ['member', 403],
  ] as const)('register the organization vault: %s -> %s', async (role, status) => {
    const kind = role === 'owner' ? 'work' : role === 'admin' ? 'personal' : 'work';
    const r = await call(role, 'POST', '/api/vaults', {
      kind,
      remoteUrl: 'https://github.com/acme/vault.git',
    });
    expect(r.status).toBe(status);
  });

  it('only the Owner and Admins see organization vaults', async () => {
    expect((await ok<any>(call('owner', 'GET', '/api/vaults'))).vaults.length).toBeGreaterThan(0);
    expect((await ok<any>(call('member', 'GET', '/api/vaults'))).vaults).toEqual([]);
  });

  it.each([
    ['owner', 201],
    ['admin', 201],
    ['member', 403],
  ] as const)('draft a custom role: %s -> %s', async (role, status) => {
    const r = await call(role, 'POST', '/api/roles', {
      key: `qa${role}`,
      name: 'QA',
      purpose: 'Checks things.',
      department: 'delivery',
      instructions: 'Check the work and report with the aom command.',
      coreRules: [],
      seniorityLevels: ['junior'],
      defaultModel: { runtime: 'mock', model: 'mock' },
      permissions: {
        allowedTools: ['read'],
        deniedShellPatterns: [],
        writableGlobs: null,
        mayCommit: false,
        browser: false,
        riskTiers: ['small'],
        repoIds: null,
      },
      skills: [],
      claimableStages: [],
    });
    expect(r.status).toBe(status);
  });

  it.each([
    ['owner', 201],
    ['admin', 201],
    ['member', 403],
  ] as const)('add an organization-wide standing order: %s -> %s', async (role, status) => {
    const r = await call(role, 'POST', '/api/ledger', {
      scope: 'standing_order',
      title: `Order ${role}`,
      body: 'Always be kind.',
    });
    expect(r.status).toBe(status);
  });

  it('a Member may add a decision to a project they are on, but not a project standing order', async () => {
    expect(
      (
        await call('member', 'POST', '/api/ledger', {
          scope: 'decision',
          projectId,
          title: 'Use pnpm',
          body: 'We use pnpm.',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await call('member', 'POST', '/api/ledger', {
          scope: 'standing_order',
          projectId,
          title: 'Rule',
          body: 'No.',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call('admin', 'POST', '/api/ledger', {
          scope: 'standing_order',
          projectId,
          title: 'Rule',
          body: 'Yes.',
        })
      ).status,
    ).toBe(201);
  });

  it.each([
    ['owner', 200],
    ['admin', 200],
    ['member', 403],
  ] as const)('change how the BA reports: %s -> %s', async (role, status) => {
    expect((await call(role, 'PUT', '/api/reporting', { routeViaBa: false })).status).toBe(status);
    // everyone in the organization can read the settings
    expect((await call(role, 'GET', '/api/reporting')).status).toBe(200);
  });

  it('a member cannot start a project through an interest, nor an intake', async () => {
    const i = await call('member', 'POST', '/api/interests', {
      name: 'AI news',
      newFeedProject: { key: 'FEEDX', name: 'Feed', domain: 'personal' },
    });
    expect(i.status).toBe(403);
    expect((await call('member', 'POST', '/api/intakes', { note: 'ACM-1' })).status).toBe(403);
  });

  it('org settings are for members only: a guest cannot read the plan, a member cannot see limits', async () => {
    expect((await call('guest', 'GET', '/api/org', undefined, false)).status).toBe(403);
    expect((await ok<any>(call('member', 'GET', '/api/org'))).limits).toBeUndefined();
    expect((await ok<any>(call('admin', 'GET', '/api/org'))).limits).toBeDefined();
  });
});
