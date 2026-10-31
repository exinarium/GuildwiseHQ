import { BUSINESS_WORKFLOW_KEY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureBusinessWorkflowsAtBoot } from '../src/catalogue/business-workflows.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { ORIGIN, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { latestInviteToken } from './helpers/mailpit.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// Views: the organization holds a DEFAULT VIEW (organizations.mode), each member may override it for themselves
// (org_members.view). A view is presentation only: nothing on the server is refused because of it.

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const orgId = () => w.owner.id;
const BUSINESS_KEYS = Object.values(BUSINESS_WORKFLOW_KEY);
const patch = (cookie: string, body: unknown) => w.t.req('PATCH', '/api/org', { cookie, body });
const putView = (cookie: string, view: 'dev' | 'business' | null, headers?: Record<string, string>) =>
  w.t.req('PUT', '/api/org/view', { cookie, body: { view }, ...(headers ? { headers } : {}) });
const getOrg = () => ok<any>(w.t.req('GET', '/api/org', { cookie: w.owner.cookie }));
const me = () => ok<any>(w.t.req('GET', '/api/auth/me', { cookie: w.owner.cookie }));
const addRepoReq = (name: string) =>
  w.t.req('POST', `/api/projects/${w.projectId}/repos`, {
    cookie: w.owner.cookie,
    body: { name, remoteUrl: `https://github.com/acme/${name}.git` },
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

/** A fingerprint of everything a view must never touch. */
async function world() {
  const n = async (sql: string) => Number((await q(sql, [orgId()]))[0]?.n);
  return {
    projects: await n(`SELECT count(*) AS n FROM projects WHERE org_id=$1`),
    repos: await n(
      `SELECT count(*) AS n FROM project_repos r JOIN projects p ON p.id=r.project_id WHERE p.org_id=$1 AND r.removed_at IS NULL`,
    ),
    agents: await n(`SELECT count(*) AS n FROM agents WHERE org_id=$1 AND status<>'retired'`),
    cards: await n(`SELECT count(*) AS n FROM cards WHERE org_id=$1`),
    workflows: await n(`SELECT count(*) AS n FROM workflow_versions WHERE org_id=$1`),
    projectWorkflows: await n(
      `SELECT count(*) AS n FROM project_workflows pw JOIN projects p ON p.id=pw.project_id WHERE p.org_id=$1`,
    ),
  };
}
const lastSeq = async () => Number((await q('SELECT coalesce(max(seq),0) AS s FROM events'))[0]?.s);
const eventsSince = async (seq: number) =>
  (await q('SELECT type FROM events WHERE seq > $1 ORDER BY seq', [seq])).map((r: any) => r.type as string);

describe('the default view of the organization', () => {
  it('is Software by default, in the row and in GET /api/org, and a member has no override', async () => {
    const org = await getOrg();
    expect(org.mode).toBe('dev');
    expect(org.viewOverride).toBeNull();
    const [row] = await q('SELECT mode FROM organizations WHERE id=$1', [orgId()]);
    expect(row?.mode).toBe('dev');
  });

  it('is never refused: a repository and a builder exist and the default still switches to Business', async () => {
    await ok(hireReq('Ken', 'builder'), 201);
    expect((await world()).repos).toBeGreaterThan(0);
    const on = await ok<any>(patch(w.owner.cookie, { mode: 'business' }));
    expect(on.mode).toBe('business');
    await ok<any>(patch(w.owner.cookie, { mode: 'dev' }));
  });

  it('(b) switching the default changes only the preference: one event, no data touched', async () => {
    const before = await world();
    const seq = await lastSeq();
    await ok(patch(w.owner.cookie, { mode: 'business' }));
    expect(await eventsSince(seq)).toEqual(['OrgModeSet']);
    expect(await world()).toEqual(before);
    const [ev] = await q(
      `SELECT payload FROM events WHERE type='OrgModeSet' AND payload->>'orgId'=$1 ORDER BY seq DESC`,
      [orgId()],
    );
    expect(ev?.payload).toMatchObject({ orgId: orgId(), mode: 'business', previous: 'dev', by: w.owner.id });
    // the same default again appends nothing
    const seq2 = await lastSeq();
    await ok(patch(w.owner.cookie, { mode: 'business' }));
    expect(await eventsSince(seq2)).toEqual([]);
    // replay gives the same state
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await getOrg()).mode).toBe('business');
    await ok(patch(w.owner.cookie, { mode: 'dev' }));
  });

  it('only an Owner or Admin changes the default; every member changes their own view', async () => {
    const m = await w.t.userSession(uniqueEmail('member'));
    await w.t.addOrgMember(orgId(), m.id, 'member');
    const h = { 'x-aom-org': orgId() };
    const r = await w.t.req('PATCH', '/api/org', { cookie: m.cookie, headers: h, body: { mode: 'business' } });
    expect(r.status).toBe(403);
    expect((await getOrg()).mode).toBe('dev');
    expect((await putView(m.cookie, 'business', h)).status).toBe(200);
    const a = await w.t.userSession(uniqueEmail('admin'));
    await w.t.addOrgMember(orgId(), a.id, 'admin');
    const ok2 = await w.t.req('PATCH', '/api/org', { cookie: a.cookie, headers: h, body: { mode: 'dev' } });
    expect(ok2.status).toBe(200);
  });
});

describe('the member view', () => {
  it('(c) a user override beats the organization default, and null follows it again', async () => {
    expect((await me()).activeOrg).toMatchObject({ mode: 'dev', viewOverride: null });
    const seq = await lastSeq();
    const set = await ok<any>(putView(w.owner.cookie, 'business'));
    expect(set.activeOrg).toMatchObject({ mode: 'dev', viewOverride: 'business' });
    expect(await eventsSince(seq)).toEqual(['OrgMemberViewSet']);
    const [row] = await q('SELECT view FROM org_members WHERE org_id=$1 AND user_id=$2', [
      orgId(),
      w.owner.id,
    ]);
    expect(row?.view).toBe('business');

    // the organization default moves; the override stays
    await ok(patch(w.owner.cookie, { mode: 'business' }));
    await ok(putView(w.owner.cookie, 'dev'));
    expect((await me()).activeOrg).toMatchObject({ mode: 'business', viewOverride: 'dev' });
    expect((await getOrg()).viewOverride).toBe('dev');

    // another member of the same organization still follows the default
    const other = await w.t.userSession(uniqueEmail('follower'));
    await w.t.addOrgMember(orgId(), other.id, 'member');
    const o = await ok<any>(
      w.t.req('GET', '/api/auth/me', { cookie: other.cookie, headers: { 'x-aom-org': orgId() } }),
    );
    expect(o.activeOrg).toMatchObject({ mode: 'business', viewOverride: null });

    // null follows the default again
    await ok(putView(w.owner.cookie, null));
    expect((await me()).activeOrg).toMatchObject({ mode: 'business', viewOverride: null });
    await ok(patch(w.owner.cookie, { mode: 'dev' }));
  });

  it('survives a replay of the events', async () => {
    await ok(putView(w.owner.cookie, 'business'));
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await me()).activeOrg.viewOverride).toBe('business');
    await ok(putView(w.owner.cookie, null));
  });

  it('(b) switching view appends the preference event and nothing else, and changes no data', async () => {
    const before = await world();
    const seq = await lastSeq();
    await ok(putView(w.owner.cookie, 'business'));
    await ok(putView(w.owner.cookie, 'dev'));
    await ok(putView(w.owner.cookie, null));
    expect(await eventsSince(seq)).toEqual(['OrgMemberViewSet', 'OrgMemberViewSet', 'OrgMemberViewSet']);
    expect(await world()).toEqual(before);
    // setting what is already set appends nothing
    const seq2 = await lastSeq();
    await ok(putView(w.owner.cookie, null));
    expect(await eventsSince(seq2)).toEqual([]);
  });

  it('refuses a non-member and an unknown view', async () => {
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const r = await w.t.req('PUT', '/api/org/view', {
      cookie: stranger.cookie,
      headers: { 'x-aom-org': orgId() },
      body: { view: 'business' },
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await w.t.req('PUT', '/api/org/view', { cookie: w.owner.cookie, body: { view: 'x' } })).status).toBe(
      400,
    );
  });
});

describe('(a) every capability is available in every view', () => {
  it('a Business-view user does every software action', async () => {
    await ok(putView(w.owner.cookie, 'business'));
    expect((await addRepoReq('bizrepo')).status).toBe(201);
    await ok(hireReq('Rex', 'reviewer'), 201);
    await ok(hireReq('Tess', 'tester'), 201);
    const ref = await w.t.req('PUT', `/api/projects/${w.projectId}/reference-repos`, {
      cookie: w.owner.cookie,
      body: { repoIds: [w.repoId] },
    });
    // it reaches the real validation (this repository is the project's own), not a view refusal
    expect(ref.body.error.code).toBe('invalid_reference_repo');
    await ok(putView(w.owner.cookie, null));
  });

  it('a Software-view user, in an organization whose default is Business, does every business action', async () => {
    await ok(patch(w.owner.cookie, { mode: 'business' }));
    await ok(putView(w.owner.cookie, 'dev'));
    await ok(hireReq('Fran', 'front_desk'), 201);
    expect((await addRepoReq('devrepo')).status).toBe(201);
    const rp = await w.t.req('GET', '/api/ledger/rule-packs', { cookie: w.owner.cookie });
    expect(rp.status).toBe(200);
    const relay = await w.t.req('POST', '/api/relay/integrations', {
      cookie: w.owner.cookie,
      body: { kind: 'generic', label: 'Hook' },
    });
    expect(relay.status).toBe(201);
    await ok(putView(w.owner.cookie, null));
    await ok(patch(w.owner.cookie, { mode: 'dev' }));
  });

  it('a software-default organization hires a business role, lists business roles, and offers every seat', async () => {
    expect((await getOrg()).mode).toBe('dev');
    await ok(hireReq('Bea', 'billing_clerk'), 201);
    const cat = await ok<any>(w.t.req('GET', '/api/roles', { cookie: w.owner.cookie }));
    const keys = (cat.roles ?? cat).map((r: any) => r.definition.key);
    expect(keys).toContain('front_desk');
    expect(keys).toContain('builder');
  });
});

describe('(e) business workflows exist in every organization', () => {
  const have = async (orgIdValue: string) =>
    (
      await q(`SELECT DISTINCT key FROM workflow_versions WHERE org_id=$1 AND status='active'`, [orgIdValue])
    ).map((r: any) => r.key as string);

  it('the software-default world organization has them, enabled on its project', async () => {
    expect((await getOrg()).mode).toBe('dev');
    for (const k of BUSINESS_KEYS) expect(await have(orgId())).toContain(k);
    const enabled = (
      await q(`SELECT workflow_key FROM project_workflows WHERE project_id=$1`, [w.projectId])
    ).map((r: any) => r.workflow_key);
    for (const k of BUSINESS_KEYS) expect(enabled).toContain(k);
  });

  it('the boot check installs what is missing and changes nothing when complete', async () => {
    await q(`DELETE FROM project_workflows WHERE project_id=$1 AND workflow_key = ANY($2)`, [
      w.projectId,
      BUSINESS_KEYS,
    ]);
    await ensureBusinessWorkflowsAtBoot(w.t.app.ctx);
    const enabled = (
      await q(`SELECT workflow_key FROM project_workflows WHERE project_id=$1`, [w.projectId])
    ).map((r: any) => r.workflow_key);
    for (const k of BUSINESS_KEYS) expect(enabled).toContain(k);
    const seq = await lastSeq();
    await ensureBusinessWorkflowsAtBoot(w.t.app.ctx);
    expect(await eventsSince(seq)).toEqual([]);
  });

  it('a new organization from an invitation has them with no mode chosen, and with Business too', async () => {
    const root = await w.t.superAdminSession();
    for (const mode of [undefined, 'business'] as const) {
      const email = uniqueEmail('invitee');
      await ok(
        w.t.req('POST', '/api/platform/invitations', {
          cookie: root.cookie,
          body: { email, proposedOrgName: 'Newco', plan: 'founding', status: 'active' },
        }),
        201,
      );
      const token = await latestInviteToken(email, ORIGIN);
      const accept = await w.t.req('POST', `/api/invitations/${token}/accept`, {
        body: {
          displayName: 'New Person',
          password: 'a-long-enough-password',
          orgName: 'Newco',
          ...(mode ? { mode } : {}),
        },
      });
      expect(accept.status).toBe(201);
      expect(accept.body.activeOrg).toMatchObject({ mode: mode ?? 'dev', viewOverride: null });
      const keys = await have(accept.body.activeOrg.id);
      for (const k of BUSINESS_KEYS) expect(keys).toContain(k);
    }
  });

  it('a new project in a software organization enables them from the start', async () => {
    const r = await ok<any>(
      w.t.req('POST', '/api/projects', {
        cookie: w.owner.cookie,
        body: { key: 'NEWP', name: 'New project', workflowKey: 'code' },
      }),
      201,
    );
    const id = r.id ?? r.project?.id;
    const enabled = (await q(`SELECT workflow_key FROM project_workflows WHERE project_id=$1`, [id])).map(
      (x: any) => x.workflow_key,
    );
    for (const k of BUSINESS_KEYS) expect(enabled).toContain(k);
  });
});
