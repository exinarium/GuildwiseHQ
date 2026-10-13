import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('Jira on a workstation', () => {
  it('shows the status the runner reports (never a token) and keeps it over a projection rebuild', async () => {
    const read = async () =>
      (await ok<any>(w.t.req('GET', '/api/workstations', { cookie: w.owner.cookie }))).workstations.find(
        (x: any) => x.id === w.workstationId,
      );
    expect((await read()).jira.status).toBeNull();

    r.send('jira.report', {
      status: { state: 'connected', baseUrl: 'https://acme.atlassian.net', account: 'Pieter' },
    });
    await until(async () => (await read()).jira?.status?.state === 'connected', 3000, 'connected');
    expect((await read()).jira.status).toMatchObject({
      account: 'Pieter',
      baseUrl: 'https://acme.atlassian.net',
    });

    r.send('jira.report', {
      status: {
        state: 'refused',
        baseUrl: 'https://acme.atlassian.net',
        detail: 'Jira answered 401: the token is wrong or expired',
      },
    });
    await until(async () => (await read()).jira?.status?.state === 'refused', 3000, 'refused');
    expect(JSON.stringify(await read())).not.toMatch(/apiToken|api_token/);

    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await read()).jira.status.state).toBe('refused');
  });
});
