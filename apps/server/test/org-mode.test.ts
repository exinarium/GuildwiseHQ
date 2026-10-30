import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { ORIGIN, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { latestInviteToken } from './helpers/mailpit.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const orgId = () => w.owner.id;
const patch = (cookie: string, body: unknown) => w.t.req('PATCH', '/api/org', { cookie, body });
const getOrg = () => ok<any>(w.t.req('GET', '/api/org', { cookie: w.owner.cookie }));
const addRepoReq = () =>
  w.t.req('POST', `/api/projects/${w.projectId}/repos`, {
    cookie: w.owner.cookie,
    body: { name: 'extra', remoteUrl: 'https://github.com/acme/extra.git' },
  });
const hireReq = (name: string, roleKey: string) =>
  w.t.req('POST', '/api/agents', {
    cookie: w.owner.cookie,
    body: {
      name,
      roleKey,
      seniority: 'senior',
      workstationId: w.workstationId,
      runtime: 'mock',
      model: 'mock',
    },
  });

describe('organization mode', () => {
  it('is dev by default, in the row and in GET /api/org (the migration default)', async () => {
    expect((await getOrg()).mode).toBe('dev');
    const [row] = await q('SELECT mode FROM organizations WHERE id=$1', [orgId()]);
    expect(row?.mode).toBe('dev');
  });

  it('is refused while a repository or a builder exists, listing both; the built-in DevOps engineer does not block', async () => {
    await ok(hireReq('Ken', 'builder'), 201);
    const r = await patch(w.owner.cookie, { mode: 'business' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('business_mode_blocked');
    expect(r.body.error.message).toMatch(/toy/);
    expect(r.body.error.message).toMatch(/Ken/);
    expect(r.body.error.details.repositories).toEqual([{ project: 'TOY', name: 'toy' }]);
    expect(r.body.error.details.agents).toEqual([{ name: 'Ken', role: 'builder' }]);
    // the engineer of the paired workstation exists, and is not listed
    const devops = await q(`SELECT 1 FROM agents WHERE org_id=$1 AND is_devops AND status='active'`, [
      orgId(),
    ]);
    expect(devops.length).toBeGreaterThan(0);
    expect((await getOrg()).mode).toBe('dev');
  });

  it('switches once the repositories and dev agents are gone, records the event, and switching back always works', async () => {
    const agents = await ok<any[]>(w.t.req('GET', '/api/agents', { cookie: w.owner.cookie }));
    const ken = agents.find((a) => a.name === 'Ken');
    await ok(w.t.req('POST', `/api/agents/${ken.id}/fire`, { cookie: w.owner.cookie }));
    await ok(w.t.req('DELETE', `/api/projects/${w.projectId}/repos/${w.repoId}`, { cookie: w.owner.cookie }));

    const on = await ok<any>(patch(w.owner.cookie, { mode: 'business' }));
    expect(on.mode).toBe('business');
    const [ev] = await q(`SELECT payload FROM events WHERE type='OrgModeSet' ORDER BY seq DESC`);
    expect(ev?.payload).toMatchObject({ orgId: orgId(), mode: 'business', previous: 'dev', by: w.owner.id });

    // the same mode again appends nothing
    await ok(patch(w.owner.cookie, { mode: 'business' }));
    expect(await q(`SELECT 1 FROM events WHERE type='OrgModeSet'`)).toHaveLength(1);

    // replay gives the same state
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await getOrg()).mode).toBe('business');
  });

  it('rejects, with a readable 409, adding a repository, reference repositories, dev hires and packs by git URL', async () => {
    for (const r of [await addRepoReq()]) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('business_mode');
      expect(r.body.error.message).toMatch(/Business mode/);
    }
    const ref = await w.t.req('PUT', `/api/projects/${w.projectId}/reference-repos`, {
      cookie: w.owner.cookie,
      body: { repoIds: [w.repoId] },
    });
    expect(ref.status).toBe(409);
    expect(ref.body.error.code).toBe('business_mode');
    for (const role of ['builder', 'reviewer', 'pre_reviewer', 'tester', 'devops']) {
      const r = await hireReq(`Dev ${role}`, role);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('business_mode');
    }
    const pack = await w.t.req('POST', '/api/packs', {
      cookie: w.owner.cookie,
      body: { url: 'https://github.com/acme/skills.git', ref: 'v1' },
    });
    expect(pack.status).toBe(409);
    expect(pack.body.error.code).toBe('business_mode');
    expect(pack.body.error.message).toMatch(/git URL/);
  });

  it('still lets a business organization hire the other roles', async () => {
    await ok(hireReq('Anna', 'architect'), 201);
  });

  it('only an Owner or Admin changes the mode', async () => {
    const m = await w.t.userSession(uniqueEmail('member'));
    await w.t.addOrgMember(orgId(), m.id, 'member');
    const r = await w.t.req('PATCH', '/api/org', {
      cookie: m.cookie,
      headers: { 'x-aom-org': orgId() },
      body: { mode: 'dev' },
    });
    expect(r.status).toBe(403);
    expect((await getOrg()).mode).toBe('business');
    const a = await w.t.userSession(uniqueEmail('admin'));
    await w.t.addOrgMember(orgId(), a.id, 'admin');
    const ok2 = await w.t.req('PATCH', '/api/org', {
      cookie: a.cookie,
      headers: { 'x-aom-org': orgId() },
      body: { mode: 'dev' },
    });
    expect(ok2.status).toBe(200);
    expect(ok2.body.mode).toBe('dev');
  });

  it('back in dev mode every guarded action works again and nothing was lost', async () => {
    expect((await getOrg()).mode).toBe('dev');
    const added = await addRepoReq();
    expect(added.status).toBe(201);
    await ok(hireReq('Linus', 'reviewer'), 201);
    const agents = await ok<any[]>(w.t.req('GET', '/api/agents', { cookie: w.owner.cookie }));
    expect(agents.map((a) => a.name)).toContain('Anna');
  });

  it('a new organization accepted from an invitation can start in business mode, with its event', async () => {
    const root = await w.t.superAdminSession();
    const email = uniqueEmail('business-invitee');
    await ok(
      w.t.req('POST', '/api/platform/invitations', {
        cookie: root.cookie,
        body: { email, proposedOrgName: 'Bizco', plan: 'founding', status: 'active' },
      }),
      201,
    );
    const token = await latestInviteToken(email, ORIGIN);
    const accept = await w.t.req('POST', `/api/invitations/${token}/accept`, {
      body: {
        displayName: 'Biz Person',
        password: 'a-long-enough-password',
        orgName: 'Bizco',
        mode: 'business',
      },
    });
    expect(accept.status).toBe(201);
    expect(accept.body.activeOrg).toMatchObject({ name: 'Bizco', mode: 'business' });
    const [row] = await q('SELECT mode FROM organizations WHERE id=$1', [accept.body.activeOrg.id]);
    expect(row?.mode).toBe('business');
    const [ev] = await q(
      `SELECT payload FROM events WHERE type = 'OrganizationCreated' AND payload->>'orgId' = $1`,
      [accept.body.activeOrg.id],
    );
    expect((ev?.payload as { mode?: string } | undefined)?.mode).toBe('business');
  });
});
