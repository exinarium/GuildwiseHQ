import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testServicesFor } from '../src/runner-gateway/brief.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { addMember } from './helpers/members.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * Local test services (GWP-41): the project's loopback host:port list, who may set it, what the project API returns and
 * which shifts the runner is told about it (builder, reviewer and tester card shifts only).
 */
let w: World;
const PG = { name: 'postgres-test', host: '127.0.0.1', port: 5433 };

const put = (cookie: string, services: unknown, id = w.projectId) =>
  w.t.req('PUT', `/api/projects/${id}/test-services`, { cookie, body: { services } });
const detail = (cookie = w.owner.cookie) => ok<any>(w.t.req('GET', `/api/projects/${w.projectId}`, { cookie }));
const column = async () => (await q('SELECT test_services FROM projects WHERE id=$1', [w.projectId]))[0]?.test_services;

beforeAll(async () => {
  w = await createWorld();
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

describe('local test services: the setting', () => {
  it('is empty by default (migration default and API)', async () => {
    expect(await column()).toEqual([]);
    expect((await detail()).project.testServices).toEqual([]);
  });

  it('round trips through the API, appends one event and survives a rebuild', async () => {
    const set = await ok<any>(put(w.owner.cookie, [PG, { name: 'v6', host: '[::1]', port: 6379 }]));
    expect(set.project.testServices).toEqual([PG, { name: 'v6', host: '::1', port: 6379 }]);
    await ok(put(w.owner.cookie, [PG, { name: 'v6', host: '::1', port: 6379 }])); // unchanged: nothing appended
    expect(
      await q(`SELECT 1 FROM events WHERE type='ProjectTestServicesSet' AND project_id=$1`, [w.projectId]),
    ).toHaveLength(1);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await detail()).project.testServices).toHaveLength(2);
  });

  it.each([
    ['a non-loopback host', { ...PG, host: '10.0.0.5' }],
    ['a hostname', { ...PG, host: 'db.example.com' }],
    ['0.0.0.0', { ...PG, host: '0.0.0.0' }],
    ['port 0', { ...PG, port: 0 }],
    ['port 65536', { ...PG, port: 65536 }],
    ['a text port', { ...PG, port: 'abc' }],
  ])('refuses %s and leaves the saved list unchanged', async (_n, bad) => {
    const before = await column();
    const res = await put(w.owner.cookie, [bad]);
    expect(res.status).toBe(400);
    expect(await column()).toEqual(before);
  });

  it('only the project Owner or an organization Owner or Admin may set it', async () => {
    const manager = await addMember(w, 'ts-manager');
    expect((await put(manager.cookie, [])).status).toBe(403);
    expect(await column()).toHaveLength(2);
  });

  it('removing an entry takes it out of the next shift start', async () => {
    const agent = { role_key: 'builder', is_devops: false };
    expect((await testServicesFor(w.t.app.ctx, agent, w.projectId)).map((s) => s.name)).toEqual(['postgres-test', 'v6']);
    await ok(put(w.owner.cookie, [PG]));
    expect((await testServicesFor(w.t.app.ctx, agent, w.projectId)).map((s) => s.name)).toEqual(['postgres-test']);
  });
});

describe('local test services: what the runner is told', () => {
  it.each(['builder', 'reviewer', 'tester'])('a %s shift gets the list', async (role_key) => {
    const got = await testServicesFor(w.t.app.ctx, { role_key, is_devops: false }, w.projectId);
    expect(got).toEqual([PG]);
  });

  it.each(['ba', 'ceo', 'architect', 'planner', 'unknown'])('a %s shift gets nothing', async (role_key) => {
    expect(await testServicesFor(w.t.app.ctx, { role_key, is_devops: false }, w.projectId)).toEqual([]);
  });

  it('the DevOps engineer gets nothing, even in a builder role', async () => {
    expect(await testServicesFor(w.t.app.ctx, { role_key: 'builder', is_devops: true }, w.projectId)).toEqual([]);
  });

  it('another project does not get the list', async () => {
    const other = '00000000-0000-4000-8000-000000000000';
    expect(await testServicesFor(w.t.app.ctx, { role_key: 'builder', is_devops: false }, other)).toEqual([]);
  });

  it('shift.start of a builder card shift carries the list; one without a declared list carries no field', async () => {
    const r = await w.connectRunner();
    await w.hire('Bea', 'builder', 'junior');
    await w.card({ title: 'Runs the suite' });
    await w.t.app.ctx.services.dispatcher.run();
    const start = await r.waitFor('shift.start');
    expect(start.testServices).toEqual([PG]);
    r.close();
  });
});
