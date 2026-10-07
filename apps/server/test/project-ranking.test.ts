import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { ok, pairWorkstation } from './helpers/world.ts';

/**
 * The organization ranks its projects (docs/design/open-questions.md "drop 'personal'; projects ranked by drag and
 * drop"): who may rank, what a ranking must name, where new projects go, what an interest is, and that a projection
 * rebuild reproduces it.
 */
let t: TestApp;
let acme: string;
const who: Record<
  'owner' | 'admin' | 'member' | 'guest',
  { id: string; email: string; cookie: string; workstationId: string }
> = {} as never;
const ids: Record<string, string> = {};

const call = (
  role: keyof typeof who,
  method: string,
  url: string,
  body?: unknown,
  inAcme = role !== 'guest',
) =>
  t.req(method, url, {
    cookie: who[role].cookie,
    ...(inAcme ? { headers: { 'x-aom-org': acme } } : {}),
    body,
  });
const listed = async (role: keyof typeof who = 'owner') =>
  (await ok<any>(call(role, 'GET', '/api/projects'))).projects.filter((p: any) => p.orgId === acme);
const keys = async (role: keyof typeof who = 'owner') => (await listed(role)).map((p: any) => p.key);
const rank = (role: keyof typeof who, order: string[]) =>
  call(role, 'PUT', '/api/projects/ranking', { projectIds: order.map((k) => ids[k]) });
const dbRanks = async () =>
  Object.fromEntries(
    (await q(`SELECT key, rank FROM projects WHERE org_id=$1 AND kind='project' ORDER BY rank`, [acme])).map(
      (r) => [r.key, r.rank],
    ),
  );
const create = async (key: string) => {
  const p = await ok<any>(call('owner', 'POST', '/api/projects', { key, name: `Project ${key}` }), 201);
  ids[key] = p.project.id;
};

beforeAll(async () => {
  t = await createTestApp();
  for (const r of ['owner', 'admin', 'member', 'guest'] as const) {
    const s = await t.userSession(uniqueEmail(r));
    who[r] = { ...s, workstationId: (await pairWorkstation(t, s, `${r}-box`)).workstationId };
  }
  acme = await t.createOrg(who.owner.id, 'Acme');
  await t.addOrgMember(acme, who.admin.id, 'admin');
  await t.addOrgMember(acme, who.member.id, 'member');
  for (const k of ['AAA', 'BBB', 'CCC']) await create(k);
});
afterAll(async () => {
  await t.close();
  await closeAdminPool();
});

describe('the ranking of projects', () => {
  it('a new project goes to the bottom, and the list is in rank order with the rank on each project', async () => {
    expect(await keys()).toEqual(['AAA', 'BBB', 'CCC']);
    expect((await listed()).map((p: any) => p.rank)).toEqual([1, 2, 3]);
    await create('DDD');
    expect(await keys()).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
    expect(await dbRanks()).toEqual({ AAA: 1, BBB: 2, CCC: 3, DDD: 4 });
  });

  it('the Owner and an Admin reorder the projects; one ProjectsRanked event records it', async () => {
    const before = (await q(`SELECT count(*)::int AS n FROM events WHERE type='ProjectsRanked'`))[0]!.n;
    const r = await ok<any>(rank('owner', ['CCC', 'AAA', 'DDD', 'BBB']));
    expect(r.projects.filter((p: any) => p.orgId === acme).map((p: any) => p.key)).toEqual([
      'CCC',
      'AAA',
      'DDD',
      'BBB',
    ]);
    expect(await keys()).toEqual(['CCC', 'AAA', 'DDD', 'BBB']);
    await ok(rank('admin', ['BBB', 'DDD', 'AAA', 'CCC']));
    expect(await keys('admin')).toEqual(['BBB', 'DDD', 'AAA', 'CCC']);
    const ev = await q(`SELECT payload FROM events WHERE type='ProjectsRanked' ORDER BY seq DESC LIMIT 2`);
    expect((await q(`SELECT count(*)::int AS n FROM events WHERE type='ProjectsRanked'`))[0]!.n).toBe(
      before + 2,
    );
    expect(ev[0]!.payload).toMatchObject({ orgId: acme, reason: 'manual', rankedBy: who.admin.id });
    expect(ev[0]!.payload.projectIds).toHaveLength(4);
  });

  it('an unchanged order appends nothing', async () => {
    const n = async () =>
      (await q(`SELECT count(*)::int AS n FROM events WHERE type='ProjectsRanked'`))[0]!.n;
    const before = await n();
    await ok(rank('owner', ['BBB', 'DDD', 'AAA', 'CCC']));
    expect(await n()).toBe(before);
  });

  it('a Member and a guest cannot rank; a guest of another organization cannot rank this one', async () => {
    const order = ['AAA', 'BBB', 'CCC', 'DDD'];
    expect((await rank('member', order)).status).toBe(403);
    // the guest's tab works in their own organization: it has no projects to rank
    expect(
      (await call('guest', 'PUT', '/api/projects/ranking', { projectIds: order.map((k) => ids[k]) })).status,
    ).toBe(409);
    // pointing the guest's request at Acme is refused: they are not a member
    expect(
      (
        await t.req('PUT', '/api/projects/ranking', {
          cookie: who.guest.cookie,
          headers: { 'x-aom-org': acme },
          body: { projectIds: order.map((k) => ids[k]) },
        })
      ).status,
    ).toBe(403);
    expect(await keys()).toEqual(['BBB', 'DDD', 'AAA', 'CCC']);
  });

  it('a stale or malformed list is refused with 409 and changes nothing', async () => {
    const stale = async (projectIds: string[]) => {
      const r = await call('owner', 'PUT', '/api/projects/ranking', { projectIds });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('ranking_stale');
    };
    await stale([ids.AAA!, ids.BBB!, ids.CCC!]); // DDD missing
    await stale([ids.AAA!, ids.BBB!, ids.CCC!, ids.DDD!, ids.DDD!]); // a duplicate
    await stale([ids.AAA!, ids.BBB!, ids.CCC!, '00000000-0000-4000-8000-000000000000']); // not a project of the org
    expect((await call('owner', 'PUT', '/api/projects/ranking', { projectIds: [] })).status).toBe(400);
    expect((await call('owner', 'PUT', '/api/projects/ranking', { projectIds: ['nope'] })).status).toBe(400);
    expect(await keys()).toEqual(['BBB', 'DDD', 'AAA', 'CCC']);
  });

  it('archived projects are not part of the ranking and keep their relative place below; restoring brings one back', async () => {
    await ok(call('owner', 'POST', `/api/projects/${ids.DDD}/archive`));
    expect(await keys()).toEqual(['BBB', 'AAA', 'CCC']);
    // the archived project must not be named
    expect((await rank('owner', ['BBB', 'AAA', 'CCC', 'DDD'])).status).toBe(409);
    await ok(rank('owner', ['CCC', 'BBB', 'AAA']));
    expect(await keys()).toEqual(['CCC', 'BBB', 'AAA']);
    expect((await dbRanks()).DDD).toBe(4); // below the active ones
    await ok(call('owner', 'POST', `/api/projects/${ids.DDD}/restore`));
    expect(await keys()).toEqual(['CCC', 'BBB', 'AAA', 'DDD']);
  });

  it('an interest and its hidden project are not ranked, and cannot be put in the list', async () => {
    const r = await ok<any>(
      call('owner', 'POST', '/api/interests', { name: 'Topic', scan: { manual: true } }),
      201,
    );
    const row = (
      await q(
        'SELECT i.project_id, p.rank, p.kind FROM interests i JOIN projects p ON p.id = i.project_id WHERE i.id=$1',
        [r.id],
      )
    )[0]!;
    expect(row).toMatchObject({ rank: null, kind: 'interest' });
    expect(await keys()).toEqual(['CCC', 'BBB', 'AAA', 'DDD']);
    const withInterest = await call('owner', 'PUT', '/api/projects/ranking', {
      projectIds: [ids.CCC, ids.BBB, ids.AAA, ids.DDD, row.project_id],
    });
    expect(withInterest.status).toBe(409);
  });

  it('a projection rebuild reproduces the ranking, ranks of new projects included', async () => {
    await ok(rank('owner', ['AAA', 'CCC', 'DDD', 'BBB']));
    await create('EEE');
    const before = await dbRanks();
    expect(before).toEqual({ AAA: 1, CCC: 2, DDD: 3, BBB: 4, EEE: 5 });
    await rebuildProjections(t.app.ctx.pool, t.app.ctx.store);
    expect(await dbRanks()).toEqual(before);
    expect(await keys()).toEqual(['AAA', 'CCC', 'DDD', 'BBB', 'EEE']);
  });

  it('deleting a project leaves the others in order', async () => {
    await ok(call('owner', 'POST', `/api/projects/${ids.EEE}/archive`));
    await ok(call('owner', 'POST', `/api/projects/${ids.EEE}/delete`, { confirmKey: 'EEE' }));
    expect(await keys()).toEqual(['AAA', 'CCC', 'DDD', 'BBB']);
    await ok(rank('owner', ['BBB', 'AAA', 'CCC', 'DDD']));
    expect(await keys()).toEqual(['BBB', 'AAA', 'CCC', 'DDD']);
  });
});
