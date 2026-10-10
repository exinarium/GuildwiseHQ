import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SimulationHostImpl } from '../src/simulation/host.ts';
import { createTestApp, type TestApp, uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { fullFields, ok, until } from './helpers/world.ts';

/**
 * The simulated workstation end to end: the server pairs a workstation for a simulation organization, starts a real
 * runner process (mock runtime), a repository added with a GitHub URL becomes a local throwaway repository, and a card
 * moves through build, review and test to done without anything real being built. Needs the built runner
 * (`pnpm --filter @aom/runner build`); skipped when it is missing.
 */
const RUNNER_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '../../runner/dist/aom-runner.mjs');
const hasRunner = existsSync(RUNNER_BIN);
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'aom-sim-'));

let t: TestApp;
let root: { id: string; cookie: string };
let owner: { id: string; cookie: string; email: string };

beforeAll(async () => {
  if (!hasRunner) return;
  t = await createTestApp({
    listen: true,
    env: {
      AOM_SIMULATION_HOST: 'true',
      AOM_SIMULATION_DIR: dir,
      AOM_SIMULATION_RUNNER_BIN: RUNNER_BIN,
      AOM_FIRST_RUN_HIRE_CAP: 'false',
      // Like production: mock fields must work in simulation organizations without the flag.
      AOM_MOCK_UI: 'false',
    },
  });
  const addr = t.app.server.address();
  if (typeof addr === 'object' && addr)
    t.app.ctx.config.simulationServerUrl = `http://127.0.0.1:${addr.port}`;
  t.app.ctx.services.dispatcher.enableAuto();
  root = await t.superAdminSession();
  owner = await t.userSession(uniqueEmail('wife'));
});
afterAll(async () => {
  if (hasRunner) {
    await t.close();
    await closeAdminPool();
  }
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasRunner)('the simulated workstation', () => {
  it('runs a card through build, review and test on a mock runner with a local repository', async () => {
    const orgId = owner.id;
    const host = t.app.ctx.services.simulation as SimulationHostImpl;
    const on = await t.req('PUT', `/api/platform/orgs/${orgId}/simulation`, {
      cookie: root.cookie,
      body: { enabled: true, pace: 'fast' },
    });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    await host.idle(orgId);

    const ws = await until(
      async () =>
        (
          await q(`SELECT * FROM workstations WHERE simulation_org_id=$1 AND connected AND status='active'`, [
            orgId,
          ])
        )[0],
      60_000,
      'the simulated workstation to connect',
    );
    expect(ws.user_id).toBe(owner.id);
    expect(host.status(orgId).state).toBe('running');

    // a repository added with a GitHub address becomes a local throwaway one
    const proj = await ok<any>(
      t.req('POST', '/api/projects', { cookie: owner.cookie, body: { key: 'SIM', name: 'Simulated' } }),
      201,
    );
    const added = await ok<any>(
      t.req('POST', `/api/projects/${proj.project.id}/repos`, {
        cookie: owner.cookie,
        body: { name: 'shop', remoteUrl: 'https://github.com/acme/shop.git' },
      }),
      201,
    );
    const repo = (await q('SELECT remote_url FROM project_repos WHERE id=$1', [added.repos[0].id]))[0]!;
    expect(repo.remote_url).toContain(join(dir, orgId, 'origin'));
    expect(repo.remote_url).not.toContain('github');
    expect(existsSync(repo.remote_url)).toBe(true);

    // the runner clones it and the DevOps engineer prepares the environment
    await until(
      async () => (await q(`SELECT 1 FROM workstation_repos WHERE workstation_id=$1`, [ws.id])).length > 0,
      60_000,
      'the repository to be cloned onto the simulated workstation',
    );

    for (const [name, roleKey, seniority] of [
      ['Bea', 'builder', 'junior'],
      ['Rex', 'reviewer', 'senior'],
      ['Tess', 'tester', 'junior'],
    ] as const)
      await ok(
        t.req('POST', '/api/agents', {
          cookie: owner.cookie,
          body: { name, roleKey, seniority, workstationId: ws.id, runtime: 'mock', model: 'mock' },
        }),
        201,
      );
    const card = (
      await ok<any>(
        t.req('POST', '/api/cards', {
          cookie: owner.cookie,
          body: {
            projectId: proj.project.id,
            title: 'Add a gift-wrap option',
            cardType: 'feature',
            fields: fullFields(),
            completionAction: 'merge',
            specify: true,
          },
        }),
        201,
      )
    ).card;

    // build, review and test run on the simulated workstation; Finalize is the owner's call, as in a real organization
    await until(
      async () => {
        t.app.ctx.services.dispatcher.trigger();
        return (await q(`SELECT 1 FROM cards WHERE id=$1 AND stage='finalize'`, [card.id])).length > 0;
      },
      120_000,
      'the card to reach Finalize on the simulated workstation',
    );
    await ok(t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: owner.cookie, body: {} }));
    const done = await until(
      async () => {
        const c = (await q('SELECT status, stage FROM cards WHERE id=$1', [card.id]))[0]!;
        return c.status === 'done' ? c : false;
      },
      60_000,
      'the card to be finalized',
    );
    expect(done.status).toBe('done');
    const stages = (await q(`SELECT DISTINCT stage FROM shifts WHERE card_id=$1`, [card.id])).map(
      (r) => r.stage,
    );
    expect(stages).toEqual(expect.arrayContaining(['build', 'review', 'test']));
    // every shift ran on the simulated workstation
    const other = await q(`SELECT 1 FROM shifts WHERE card_id=$1 AND workstation_id <> $2`, [card.id, ws.id]);
    expect(other).toEqual([]);
  }, 240_000);

  it('answers chats with scripted replies from the simulated workstation', async () => {
    const orgId = owner.id;
    const agent = (await q(`SELECT id FROM agents WHERE org_id=$1 AND name='Bea'`, [orgId]))[0]!;
    expect(agent.id).toBeTruthy();
    expect(existsSync(join(dir, orgId, 'replies.json'))).toBe(true);
  });

  it('wiping removes the process, its files and every trace', async () => {
    const orgId = owner.id;
    const host = t.app.ctx.services.simulation as SimulationHostImpl;
    const name = (await q('SELECT name FROM organizations WHERE id=$1', [orgId]))[0]!.name as string;
    const r = await t.req('POST', `/api/platform/orgs/${orgId}/wipe-simulation`, {
      cookie: root.cookie,
      body: { confirmName: name },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(existsSync(join(dir, orgId))).toBe(false);
    expect(host.status(orgId).state).toBe('stopped');
    expect((await q('SELECT 1 FROM workstations WHERE simulation_org_id=$1', [orgId])).length).toBe(0);
    expect((await q('SELECT 1 FROM events WHERE org_id=$1', [orgId])).length).toBe(0);
  });

  it('loads the demo scenario into a simulation organization with AOM_MOCK_UI off, and a second run changes nothing', async () => {
    expect(t.app.ctx.config.mockUi).toBe(false);
    const demoOwner = await t.userSession(uniqueEmail('demo'));
    let orgId = demoOwner.id;
    const refuseReal = await t.req('POST', `/api/platform/orgs/${orgId}/demo-scenario`, {
      cookie: root.cookie,
    });
    expect(refuseReal.status).toBe(409);
    expect(refuseReal.body.error.code).toBe('not_simulation');
    // A real organization still refuses mock fields when the flag is off.
    const proj = await t.req('POST', '/api/projects', {
      cookie: demoOwner.cookie,
      body: { key: 'REAL', name: 'Real' },
    });
    expect(proj.status, JSON.stringify(proj.body)).toBe(201);
    const refused = await t.req('POST', '/api/cards', {
      cookie: demoOwner.cookie,
      body: {
        projectId: proj.body.project.id,
        title: 'x',
        cardType: 'feature',
        fields: { ...fullFields(), mock: { build: ['ok'] } },
      },
    });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('mock_fields_disabled');
    // A real organization with a project cannot be switched; the demo runs in a fresh, empty one.
    const switchRefused = await t.req('PUT', `/api/platform/orgs/${orgId}/simulation`, {
      cookie: root.cookie,
      body: { enabled: true, pace: 'fast' },
    });
    expect(switchRefused.status).toBe(409);
    expect(switchRefused.body.error.code).toBe('simulation_not_empty');
    const simOwner = await t.userSession(uniqueEmail('demosim'));
    orgId = simOwner.id;
    await t.req('PUT', `/api/platform/orgs/${orgId}/simulation`, {
      cookie: root.cookie,
      body: { enabled: true, pace: 'fast' },
    });
    const counts = async () => ({
      projects: (await q('SELECT count(*)::int AS n FROM projects WHERE org_id=$1', [orgId]))[0]!.n,
      cards: (await q('SELECT count(*)::int AS n FROM cards WHERE org_id=$1', [orgId]))[0]!.n,
      agents: (await q('SELECT count(*)::int AS n FROM agents WHERE org_id=$1', [orgId]))[0]!.n,
      repos: (
        await q(
          'SELECT count(*)::int AS n FROM project_repos pr JOIN projects p ON p.id=pr.project_id WHERE p.org_id=$1',
          [orgId],
        )
      )[0]!.n,
      schedules: (await q('SELECT count(*)::int AS n FROM schedules WHERE org_id=$1', [orgId]))[0]!.n,
    });
    const before = await counts();
    const r = await t.req('POST', `/api/platform/orgs/${orgId}/demo-scenario`, { cookie: root.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ projects: 2, deskQuestions: 2, schedules: 1 });
    const full = await counts();
    expect(full.projects).toBe(before.projects + 2);
    expect(full.cards).toBeGreaterThan(8);
    const repos = await q(
      'SELECT remote_url FROM project_repos pr JOIN projects p ON p.id=pr.project_id WHERE p.org_id=$1',
      [orgId],
    );
    expect(repos.every((x) => !x.remote_url.includes('hub.com'))).toBe(true);
    const again = await t.req('POST', `/api/platform/orgs/${orgId}/demo-scenario`, { cookie: root.cookie });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    expect(again.body).toMatchObject({ projects: 0, agents: 0, cards: 0, deskQuestions: 0, schedules: 0 });
    expect(await counts()).toEqual(full);
  }, 120_000);

  it('completes a partial demo scenario: what exists is skipped, what is missing is added', async () => {
    const partOwner = await t.userSession(uniqueEmail('partial'));
    const orgId = partOwner.id;
    await t.req('PUT', `/api/platform/orgs/${orgId}/simulation`, {
      cookie: root.cookie,
      body: { enabled: true, pace: 'fast' },
    });
    // A failed first attempt left the SHOP project behind.
    const proj = await t.req('POST', '/api/projects', {
      cookie: partOwner.cookie,
      body: { key: 'SHOP', name: 'Online Shop' },
    });
    expect(proj.status, JSON.stringify(proj.body)).toBe(201);
    const r = await t.req('POST', `/api/platform/orgs/${orgId}/demo-scenario`, { cookie: root.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ projects: 1, deskQuestions: 2, schedules: 1 });
    expect((await q('SELECT count(*)::int AS n FROM projects WHERE org_id=$1', [orgId]))[0]!.n).toBe(2);
    expect(
      (
        await q(
          `SELECT count(*)::int AS n FROM project_repos pr JOIN projects p ON p.id=pr.project_id
        WHERE p.org_id=$1 AND pr.removed_at IS NULL`,
          [orgId],
        )
      )[0]!.n,
    ).toBe(2);
    const again = await t.req('POST', `/api/platform/orgs/${orgId}/demo-scenario`, { cookie: root.cookie });
    expect(again.body).toMatchObject({ projects: 0, agents: 0, cards: 0, schedules: 0 });
  }, 120_000);
});
