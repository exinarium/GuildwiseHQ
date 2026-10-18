import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  designed,
  freshKeepDevops,
  handoffEv,
  hireLeanTeam,
  leanAttach,
  leanPipeline,
  planned,
  SHA1,
  SHA2,
  verdict,
} from './helpers/lean.ts';
import { cardRow, testPass } from './helpers/pipeline.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof leanPipeline>;
beforeAll(async () => {
  w = await createWorld({
    env: { AOM_FIRST_RUN_HIRE_CAP: 'false' },
    project: { workflowKey: 'code' },
    lean: true,
    integrationTests: 'off',
  });
  r = await w.connectRunner({ capabilities: ['runs:1', 'runs:2', 'runs:3'] });
  p = leanPipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), status);
const setMode = (mode: 'off' | 'local') =>
  call('PUT', `/api/projects/${w.projectId}/integration-tests`, { settings: { mode } });

beforeEach(async () => {
  await freshKeepDevops();
  await call('PUT', `/api/projects/${w.projectId}/policy`, { testWithoutEnvironment: false });
  await setMode('local');
  dispatcher().cooldown.clear();
  await hireLeanTeam(w);
});

const envOf = async (cardId: string) =>
  (await q(`SELECT * FROM run_environments WHERE card_id=$1 ORDER BY created_at DESC`, [cardId]))[0];
const services = [
  {
    name: 'web',
    state: 'healthy',
    ports: [{ name: 'http', port: 5173, url: 'http://localhost:5173/' }],
    urls: ['http://localhost:5173/'],
    health: 'passing',
    restarts: 0,
    sandbox: 'sandboxed',
  },
];
const status = async (envId: string, state: string, extra: Record<string, unknown> = {}) => {
  r.send('run.status', { envId, state, services: state === 'healthy' ? services : [], ...extra });
  await r.barrier();
};

/** A card through Build and the reviews, waiting in the server-run Test deploy (small, low risk: no owner approval). */
async function cardInTestDeploy() {
  const card = await w.card({ title: 'Needs the app' });
  expect(card.fields.integrationTests).toBe(true);
  await p.run('Pia', planned());
  await p.run('Arc', designed(card.ref));
  await p.runAt('Bea', handoffEv(), leanAttach(SHA1), SHA1);
  await p.runAt('Pre', verdict('approve'), {}, SHA1);
  await p.runAt('Rex', verdict('approve'), {}, SHA1);
  expect((await cardRow(card.id)).stage).toBe('test_deploy');
  return card;
}
const startFrames = () => r.of('command').filter((f) => f.command === 'run.start');

describe('the server-run Test deploy', () => {
  it('starts the environment for the reviewed commit without a rebase and moves the card to Test when it is healthy at that commit', async () => {
    const card = await cardInTestDeploy();
    const before = startFrames().length;
    await dispatcher().run();
    await r.barrier();
    const env = await envOf(card.id);
    expect(env).toMatchObject({ purpose: 'test', state: 'requested', card_id: card.id });
    const frame = (await r.waitFor(
      'command',
      (f) => f.command === 'run.start' && f.payload.envId === env.id,
    )) as any;
    expect(startFrames().length).toBe(before + 1);
    // the reviewed commit is the tested commit: the card branch is not rebased
    expect(frame.payload.rebaseCard).toBeUndefined();
    // nobody is assigned to the stage: no tester starts yet
    expect((await cardRow(card.id)).stage).toBe('test_deploy');
    expect(
      r.of('shift.start').filter((f) => f.agent.name === 'Tess' && f.brief.card.ref === card.ref),
    ).toHaveLength(0);

    await status(env.id, 'healthy', { sources: [{ repoId: w.repoId, commit: SHA1 }] });
    await dispatcher().run();
    await until(async () => (await cardRow(card.id)).stage === 'test', 5000, 'the card to reach Test');
    expect((await cardRow(card.id)).test_deploy_state).toBe('healthy');
    const start = await p.next('Tess');
    expect(start.brief.environment).toMatchObject({ mode: 'local', envId: env.id });
    await p.startShift(r, start, SHA1);
    const res = await p.report(r, start.shiftId, testPass());
    // a local environment needs no suites listed: the pass is accepted
    expect(res.accepted).toBe(true);
  });

  it('an environment healthy at another commit is not accepted: it is stopped and started again', async () => {
    const card = await cardInTestDeploy();
    await dispatcher().run();
    const env = await envOf(card.id);
    await status(env.id, 'healthy', { sources: [{ repoId: w.repoId, commit: SHA2 }] });
    await dispatcher().run();
    await r.barrier();
    expect((await cardRow(card.id)).stage).toBe('test_deploy');
    const stop = await r.waitFor('command', (f) => f.command === 'run.stop' && f.payload.envId === env.id);
    expect(stop).toBeTruthy();
  });

  it('a failed start raises the DevOps request path and the card stays in Test deploy', async () => {
    const card = await cardInTestDeploy();
    await dispatcher().run();
    const env = await envOf(card.id);
    await status(env.id, 'failed', { error: 'the plan did not come up', endReason: 'failed' });
    await dispatcher().run();
    await r.barrier();
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'test_deploy', status: 'waiting', park_problem: 'run_failed' });
    const req = (await q('SELECT * FROM devops_requests WHERE id=$1', [row.parked_request_id]))[0];
    expect(req).toBeTruthy();
    expect(req.context).toMatchObject({ cardId: card.id });
    // no tester is ever offered a card without a healthy environment
    expect(
      r.of('shift.start').filter((f) => f.agent.name === 'Tess' && f.brief.card.ref === card.ref),
    ).toHaveLength(0);
  });

  it('with "test without an environment" the stage is skipped straight to Test', async () => {
    await call('PUT', `/api/projects/${w.projectId}/policy`, { testWithoutEnvironment: true });
    const card = await cardInTestDeploy();
    const before = startFrames().length;
    await dispatcher().run();
    await until(async () => (await cardRow(card.id)).stage === 'test', 5000, 'the stage to be skipped');
    expect((await cardRow(card.id)).test_deploy_state).toBe('skipped');
    expect(startFrames().length).toBe(before);
    const start = await p.next('Tess');
    expect(start.brief.testWithoutEnvironment).toBe(true);
  });

  it('a card with integration tests off skips the stage with the reason on the thread', async () => {
    await setMode('off');
    const card = await w.card({ title: 'plain' });
    expect(card.fields.integrationTests).toBe(false);
    await p.run('Pia', planned());
    await p.run('Arc', designed(card.ref));
    await p.runAt('Bea', handoffEv(), leanAttach(SHA1), SHA1);
    await p.runAt('Pre', verdict('approve'), {}, SHA1);
    await p.runAt('Rex', verdict('approve'), {}, SHA1);
    await dispatcher().run();
    await until(async () => (await cardRow(card.id)).stage === 'test', 5000, 'skipped');
    const msg = await q(
      `SELECT body FROM thread_messages WHERE thread_id=$1 AND body LIKE 'Test deploy skipped%'`,
      [card.id],
    );
    expect(msg[0]?.body).toMatch(/switched off for this card|does not run integration tests/);
  });
});

describe('the tester gate has no escapes in the lean team flow', () => {
  it('a card in Test without a healthy environment is not offered to a tester, however the project is set up', async () => {
    const card = await cardInTestDeploy();
    // somebody moved it on without the deploy (the escapes of the older gate would have let a tester start)
    await q(`UPDATE cards SET stage='test', status='queued', test_deploy_state=NULL WHERE id=$1`, [card.id]);
    await q(`UPDATE workstation_capabilities SET capabilities = array_remove(capabilities, 'runs:3')`);
    const made = await dispatcher().runPass();
    expect(made.filter((m) => m.cardId === card.id)).toHaveLength(0);
    await q(
      `UPDATE projects SET integration_tests = jsonb_set(integration_tests, '{mode}', '"off"') WHERE id=$1`,
      [w.projectId],
    );
    const made2 = await dispatcher().runPass();
    expect(made2.filter((m) => m.cardId === card.id)).toHaveLength(0);
    // only the server's recorded decision (or the project's own switch) opens the gate
    await q(`UPDATE cards SET test_deploy_state='skipped' WHERE id=$1`, [card.id]);
    const made3 = await dispatcher().runPass();
    expect(made3.filter((m) => m.cardId === card.id)).toHaveLength(1);
  });
});
