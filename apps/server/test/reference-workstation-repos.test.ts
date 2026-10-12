import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { eligibleProjectRepos } from '../src/runner-gateway/read-repos.ts';
import { localReadRepos } from '../src/runner-gateway/workstation-repos.ts';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, ok, pairWorkstation, type World } from './helpers/world.ts';

/**
 * Reference repositories, second part: any clone on a workstation can be picked (not only project repositories), and
 * organization owners and admins see every project's repositories while others see their own projects'.
 */
let w: World;
let org: string;
let admin: { id: string; cookie: string; email: string; workstationId: string; runnerToken: string };
let member: { id: string; cookie: string; email: string };
let admProjectId: string;
let admRepoId: string;
let ownRepoId: string;
let ownProjectId: string;
const asAdmin = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: admin.cookie, headers: { 'x-aom-org': org }, body });

const CATALOG = [
  { name: 'notes', localKey: 'notes', remoteUrlNormalized: null },
  { name: 'acme', localKey: 'clients/acme', remoteUrlNormalized: 'github.com/acme/acme' },
];

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  org = w.owner.id;
  const s = await w.t.userSession(uniqueEmail('admin'));
  admin = { ...s, ...(await pairWorkstation(w.t, s, 'admin-box')) };
  member = await w.t.userSession(uniqueEmail('member'));
  await w.t.addOrgMember(org, admin.id, 'admin');
  await w.t.addOrgMember(org, member.id, 'member');
  // the Owner's other project (the admin and the member do not belong to it)
  const own = await ok<any>(
    w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'LIB', name: 'Library' } }),
    201,
  );
  ownProjectId = own.project.id;
  ownRepoId = (
    await ok<any>(
      w.t.req('POST', `/api/projects/${ownProjectId}/repos`, {
        cookie: w.owner.cookie,
        body: { name: 'lib', remoteUrl: 'https://github.com/acme/lib.git' },
      }),
      201,
    )
  ).repos[0].id;
  // the Admin's own project, with the member on it
  const adm = await ok<any>(asAdmin('POST', '/api/projects', { key: 'ADM', name: 'Admin work' }), 201);
  admProjectId = adm.project.id;
  admRepoId = (
    await ok<any>(
      asAdmin('POST', `/api/projects/${admProjectId}/repos`, {
        name: 'adm',
        remoteUrl: 'https://github.com/acme/adm.git',
      }),
      201,
    )
  ).repos[0].id;
  await ok(asAdmin('POST', `/api/projects/${admProjectId}/members`, { email: member.email }), 201);
  await w.t.req('POST', `/api/projects/${admProjectId}/members/accept`, { cookie: member.cookie });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const putAdmin = (body: unknown) => asAdmin('PUT', `/api/projects/${admProjectId}/reference-repos`, body);
const detailAdmin = () => ok<any>(asAdmin('GET', `/api/projects/${admProjectId}`));

async function report(token: string, catalog = CATALOG) {
  const r = await FakeRunner.connect(w.baseUrl, token);
  r.hello({ runtimes: MOCK_RUNTIME, repoCatalog: catalog });
  await r.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
  return r;
}

describe('reference repositories: who sees which projects', () => {
  it('an org admin sees every project of the organization, a member only the projects they belong to', async () => {
    const pool = w.t.app.ctx.pool;
    const ids = async (userId: string, projectId: string) =>
      (await eligibleProjectRepos(pool, { userId, orgId: org, projectId })).map((r) => r.repoId).sort();
    // the Owner and the Admin: every other project's repositories
    expect(await ids(admin.id, admProjectId)).toEqual([w.repoId, ownRepoId].sort());
    expect(await ids(w.owner.id, admProjectId)).toEqual([w.repoId, ownRepoId].sort());
    // the member belongs to ADM only: no other project's repository is offered
    expect(await ids(member.id, ownProjectId)).toEqual([admRepoId]);
    expect(await ids(member.id, admProjectId)).toEqual([]);
  });

  it('the detail offers the admin repositories of projects they are not on; validation accepts the same', async () => {
    const d = await detailAdmin();
    expect(d.referenceRepoCandidates.map((c: any) => c.repoId).sort()).toEqual([w.repoId, ownRepoId].sort());
    const set = await ok<any>(putAdmin({ repoIds: [ownRepoId] }));
    expect(set.referenceRepos.map((r: any) => r.repoId)).toEqual([ownRepoId]);
    await ok(putAdmin({ repoIds: [] }));
  });

  it('refuses another organization, an interest project, a removed repository and the project itself', async () => {
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const theirs = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: stranger.cookie, body: { key: 'SEC', name: 'Secret' } }),
      201,
    );
    const repo = await ok<any>(
      w.t.req('POST', `/api/projects/${theirs.project.id}/repos`, {
        cookie: stranger.cookie,
        body: { name: 'sec', remoteUrl: 'https://github.com/acme/sec' },
      }),
      201,
    );
    expect((await putAdmin({ repoIds: [repo.repos[0].id] })).status).toBe(400);
    expect((await putAdmin({ repoIds: [admRepoId] })).status).toBe(400);
  });
});

describe('reference repositories: any clone on a workstation', () => {
  let adminRunner: FakeRunner;
  it('the runner reports its clones; the picker offers them per workstation, with no paths', async () => {
    adminRunner = await report(admin.runnerToken);
    const rows = await q(
      'SELECT local_key, name, remote_url_normalized FROM workstation_repo_catalog WHERE workstation_id=$1 ORDER BY local_key',
      [admin.workstationId],
    );
    expect(rows.map((r: any) => [r.local_key, r.remote_url_normalized])).toEqual([
      ['clients/acme', 'github.com/acme/acme'],
      ['notes', null],
    ]);
    const d = await detailAdmin();
    expect(d.workstationRepoCandidates).toEqual([
      expect.objectContaining({
        workstationName: 'admin-box',
        localKey: 'clients/acme',
        remoteUrl: 'github.com/acme/acme',
      }),
      expect.objectContaining({ workstationName: 'admin-box', localKey: 'notes', remoteUrl: null }),
    ]);
    // the owner's detail never lists the admin's workstation
    const ownDetail = await ok<any>(
      w.t.req('GET', `/api/projects/${ownProjectId}`, { cookie: w.owner.cookie }),
    );
    expect(ownDetail.workstationRepoCandidates).toEqual([]);
  });

  it('a later repos.report replaces the catalog; a runner that sends none leaves it as it was', async () => {
    adminRunner.send('repos.report', { repos: [], repoCatalog: [CATALOG[0]] });
    await new Promise((r) => setTimeout(r, 300));
    expect((await detailAdmin()).workstationRepoCandidates).toHaveLength(1);
    adminRunner.send('repos.report', { repos: [] });
    await new Promise((r) => setTimeout(r, 300));
    expect((await detailAdmin()).workstationRepoCandidates).toHaveLength(1);
    adminRunner.send('repos.report', { repos: [], repoCatalog: CATALOG });
    await new Promise((r) => setTimeout(r, 300));
    expect((await detailAdmin()).workstationRepoCandidates).toHaveLength(2);
  });

  it('the owner picks a clone with and without a remote; it is stored as an event and survives a rebuild', async () => {
    const wsRepos = [
      { workstationId: admin.workstationId, localKey: 'notes' },
      { workstationId: admin.workstationId, localKey: 'clients/acme' },
    ];
    const set = await ok<any>(putAdmin({ repoIds: [ownRepoId], workstationRepos: wsRepos }));
    expect(set.referenceRepos).toHaveLength(1);
    expect(
      set.referenceWorkstationRepos.map((r: any) => [r.workstationName, r.localKey, r.remoteUrl]),
    ).toEqual([
      ['admin-box', 'notes', null],
      ['admin-box', 'clients/acme', 'github.com/acme/acme'],
    ]);
    const ev = await q(`SELECT payload FROM events WHERE type='ProjectReferenceReposSet' AND project_id=$1`, [
      admProjectId,
    ]);
    expect(JSON.stringify(ev.at(-1))).toContain('"localKey":"notes"');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await detailAdmin()).referenceWorkstationRepos).toHaveLength(2);
    // the same list again appends nothing
    const before = (
      await q(`SELECT 1 FROM events WHERE type='ProjectReferenceReposSet' AND project_id=$1`, [admProjectId])
    ).length;
    await ok(putAdmin({ repoIds: [ownRepoId], workstationRepos: wsRepos }));
    expect(
      (
        await q(`SELECT 1 FROM events WHERE type='ProjectReferenceReposSet' AND project_id=$1`, [
          admProjectId,
        ])
      ).length,
    ).toBe(before);
  });

  it('leaving workstationRepos out keeps the picked clones; an empty list clears them', async () => {
    await ok(putAdmin({ repoIds: [] }));
    expect((await detailAdmin()).referenceWorkstationRepos).toHaveLength(2);
    expect((await detailAdmin()).referenceRepos).toEqual([]);
    await ok(putAdmin({ repoIds: [], workstationRepos: [] }));
    expect((await detailAdmin()).referenceWorkstationRepos).toEqual([]);
  });

  it("refuses a clone that is not reported, someone else's workstation and another organization's workstation", async () => {
    // not in the catalog
    expect(
      (
        await putAdmin({
          repoIds: [],
          workstationRepos: [{ workstationId: admin.workstationId, localKey: 'secrets' }],
        })
      ).status,
    ).toBe(400);
    // the Owner's workstation (same organization, another user)
    const ownerRunner = await report(w.runnerToken, CATALOG);
    expect(
      (
        await putAdmin({
          repoIds: [],
          workstationRepos: [{ workstationId: w.workstationId, localKey: 'notes' }],
        })
      ).status,
    ).toBe(400);
    // a workstation of a user in another organization
    const outsider = await w.t.userSession(uniqueEmail('outsider'));
    const ows = await pairWorkstation(w.t, outsider, 'outsider-box');
    const outsiderRunner = await report(ows.runnerToken, CATALOG);
    expect(
      (
        await putAdmin({
          repoIds: [],
          workstationRepos: [{ workstationId: ows.workstationId, localKey: 'notes' }],
        })
      ).status,
    ).toBe(400);
    // too many in all
    expect(
      (
        await putAdmin({
          repoIds: [],
          workstationRepos: Array.from({ length: 21 }, (_, i) => ({
            workstationId: admin.workstationId,
            localKey: `k${i}`,
          })),
        })
      ).status,
    ).toBe(400);
    ownerRunner.close();
    outsiderRunner.close();
  });

  it('a clone without a remote goes only to its workstation, by key; one with a remote goes everywhere', async () => {
    await ok(
      putAdmin({
        repoIds: [],
        workstationRepos: [
          { workstationId: admin.workstationId, localKey: 'notes' },
          { workstationId: admin.workstationId, localKey: 'clients/acme' },
        ],
      }),
    );
    const pool = w.t.app.ctx.pool;
    expect(await localReadRepos(pool, admProjectId, admin.workstationId)).toEqual([
      { name: 'notes', localKey: 'notes' },
      { name: 'acme', localKey: 'clients/acme', remoteUrlNormalized: 'github.com/acme/acme' },
    ]);
    expect(await localReadRepos(pool, admProjectId, w.workstationId)).toEqual([
      { name: 'acme', remoteUrlNormalized: 'github.com/acme/acme' },
    ]);
  });

  it('a project chat starts with the picked clones', async () => {
    const r = await report(admin.runnerToken);
    const agent = await ok<any>(
      asAdmin('POST', '/api/agents', {
        name: 'Ada',
        roleKey: 'builder',
        seniority: 'junior',
        workstationId: admin.workstationId,
        runtime: 'mock',
        model: 'mock',
      }),
      201,
    );
    const chat = (
      await ok<any>(asAdmin('POST', '/api/chats', { agentId: agent.id, projectId: admProjectId }), 201)
    ).chat;
    const b = await Browser.open(w.baseUrl, admin.cookie);
    await b.hello();
    b.send({ type: 'chat.send', threadId: chat.threadId, body: 'look', clientMsgId: 'm1' });
    const start = await r.waitFor('chat.start');
    expect(start.context.localReadRepos).toEqual([
      { name: 'notes', localKey: 'notes' },
      { name: 'acme', localKey: 'clients/acme', remoteUrlNormalized: 'github.com/acme/acme' },
    ]);
    b.close();
    r.close();
    adminRunner.close();
  });
});
