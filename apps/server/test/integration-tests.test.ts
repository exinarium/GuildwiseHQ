import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expireRuns } from '../src/commands/runs.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { approve, cardRow, handoff, hireTeam, pipeline, testFail, testPass } from './helpers/pipeline.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  // the production default: integration tests are off until the owner switches them on
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' }, integrationTests: 'off' });
  r = await w.connectRunner({ capabilities: ['runs:1', 'runs:2', 'runs:3'] });
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const dispatcher = () => w.t.app.ctx.services.dispatcher;
const call = (method: string, url: string, body?: unknown, status = 200, cookie = w.owner.cookie) =>
  ok<any>(w.t.req(method, url, { cookie, ...(body !== undefined ? { body } : {}) }), status);
const settingsUrl = () => `/api/projects/${w.projectId}/integration-tests`;
const SUITES = [
  { name: 'api', repoId: () => w.repoId, cmd: ['npm', 'run', 'it'], kind: 'integration' },
  {
    name: 'e2e',
    repoId: () => w.repoId,
    cmd: ['npx', 'playwright', 'test'],
    kind: 'e2e',
    junit: 'results/*.xml',
  },
];
const setSettings = (over: Record<string, unknown> = {}, suites = SUITES) =>
  call('PUT', settingsUrl(), {
    settings: {
      mode: 'local',
      suites: suites.map((s) => ({ ...s, repoId: s.repoId() })),
      keepOnFailureMin: 60,
      flakyRetry: 1,
      ...over,
    },
  });

async function fresh() {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages,
       desk_items, card_blockers, ledger_entries, devops_requests, runner_commands, runner_inbox,
       run_environments, run_plans, test_suite_results CASCADE`,
  );
  await q('DELETE FROM agents WHERE NOT is_devops');
  dispatcher().cooldown.clear();
}
beforeEach(async () => {
  await fresh();
  await call('PUT', settingsUrl(), { settings: { mode: 'off' } });
});

const envOf = async (cardId: string) =>
  (
    await q(
      `SELECT * FROM run_environments WHERE card_id=$1
        ORDER BY (state NOT IN ('stopped','failed')) DESC, created_at DESC`,
      [cardId],
    )
  )[0];
const rpc = async (shiftId: string, method: string, params: Record<string, unknown> = {}) => {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId, method, params });
  return r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 30_000, from);
};
const services = (port = 5173) => [
  {
    name: 'web',
    state: 'healthy',
    ports: [{ name: 'http', port, url: `http://localhost:${port}/` }],
    urls: [`http://localhost:${port}/`],
    health: 'passing',
    restarts: 0,
    sandbox: 'sandboxed',
  },
];
const status = async (envId: string, state: string, extra: Record<string, unknown> = {}) => {
  r.send('run.status', { envId, state, services: state === 'healthy' ? services() : [], ...extra });
  await r.barrier();
};
const PLAN = () => ({
  version: 1,
  repos: [{ repoId: w.repoId }],
  setup: [],
  services: [
    {
      name: 'web',
      repoId: w.repoId,
      cwd: '.',
      cmd: ['npm', 'run', 'dev'],
      env: {},
      ports: [{ name: 'http', default: 5173, envVar: 'PORT' }],
      health: { kind: 'none', graceSec: 3 },
      startTimeoutSec: 300,
      after: [],
      docker: false,
    },
  ],
  notes: 'test plan',
});

/** A card through build and review, waiting at Test. */
async function cardAtTest(title = 'Needs the app') {
  const card = await w.card({ title });
  await p.toTest('Bea', ['Rex']);
  return card;
}
const startFrames = () => r.of('command').filter((f) => f.command === 'run.start');
const testerStartsFrom = (from: number) =>
  r.received.slice(from).filter((f) => f.type === 'shift.start' && f.agent.name === 'Tess');

describe('the project setting', () => {
  it('is off for every project until the owner switches it on, and only the owner changes it', async () => {
    const s = await call('GET', settingsUrl());
    expect(s.settings).toMatchObject({ mode: 'off', suites: [], keepOnFailureMin: 60, flakyRetry: 1 });
    expect(s.repos).toEqual([{ repoId: w.repoId, name: 'toy' }]);
    expect(s.canProvision).toBe(true);

    const on = await setSettings();
    expect(on.settings.mode).toBe('local');
    expect(on.settings.suites.map((x: any) => x.name)).toEqual(['api', 'e2e']);
    const stranger = await w.t.userSession(`o-${randomUUID().slice(0, 6)}@example.test`);
    await call('PUT', settingsUrl(), { settings: { mode: 'off' } }, 404, stranger.cookie);
  });

  it('refuses suites the project does not have and a remote mode without a target', async () => {
    await call(
      'PUT',
      settingsUrl(),
      { settings: { mode: 'local', suites: [{ name: 'x', repoId: randomUUID(), cmd: ['t'] }] } },
      400,
    );
    await call(
      'PUT',
      settingsUrl(),
      { settings: { mode: 'local', suites: [{ name: 'x', repoId: w.repoId, cmd: ['t'], cwd: '../up' }] } },
      400,
    );
    await call('PUT', settingsUrl(), { settings: { mode: 'remote' } }, 400);
  });

  it('confirms a suite a tester proposed', async () => {
    await setSettings({}, []);
    await hireTeam(w);
    const card = await cardAtTest();
    expect(card).toBeTruthy();
    // a proposal needs a tester shift: use the rpc of the next tester shift
    await q(`UPDATE run_environments SET state='stopped'`);
    // drive a tester shift without an environment: put the project back to off then on is not needed; propose directly
    await q(`UPDATE projects SET integration_tests = jsonb_set(integration_tests, '{mode}', '"off"')`);
    await dispatcher().run();
    const start = await p.next('Tess');
    await p.startShift(r, start);
    const res = await rpc(start.shiftId, 'env.suites.propose', {
      suites: [{ name: 'smoke', cmd: ['npx', 'playwright', 'test', 'smoke'], kind: 'e2e', repo: 'toy' }],
    });
    expect(res.ok).toBe(true);
    const got = await call('GET', settingsUrl());
    expect(got.settings.suites).toMatchObject([{ name: 'smoke', confirmed: false, kind: 'e2e' }]);
    const after = await call('POST', `${settingsUrl()}/suites/smoke/confirm`, { confirmed: true });
    expect(after.settings.suites[0].confirmed).toBe(true);
    await call('POST', `${settingsUrl()}/suites/ghost/confirm`, { confirmed: true }, 404);
  });
});

describe('the card follows the setting', () => {
  it('takes integrationTests from the project at creation and can be changed per card', async () => {
    const off = await w.card();
    expect(off.fields.integrationTests).toBe(false);
    await setSettings();
    const on = await w.card();
    expect(on.fields.integrationTests).toBe(true);
    await call('PATCH', `/api/cards/${on.id}`, { integrationTests: false });
    expect((await cardRow(on.id)).fields.integrationTests).toBe(false);
    await call('PATCH', `/api/cards/${off.id}`, { integrationTests: true });
    expect((await cardRow(off.id)).fields.integrationTests).toBe(true);
  });

  it('skips the Test stage when integration tests are off for the card', async () => {
    await hireTeam(w);
    const card = await w.card({ title: 'No integration tests' });
    expect(card.fields.integrationTests).toBe(false);
    await p.toTest('Bea', ['Rex']);
    // review approval goes past Test (docs needed? no) to Finalize
    expect((await cardRow(card.id)).stage).toBe('finalize');
  });

  it('moves a card started on code v3 to v4 when it leaves Review, with the project setting applied', async () => {
    await setSettings();
    await hireTeam(w);
    const card = await w.card({ title: 'In flight' });
    const v3 = (
      await q(`SELECT id FROM workflow_versions WHERE key='code' AND version=3 AND org_id IS NULL`)
    )[0];
    // the card was pinned to v3 and never had the flag (it started before this version existed)
    await q(`UPDATE cards SET workflow_version_id=$2, fields = fields - 'integrationTests' WHERE id=$1`, [
      card.id,
      v3.id,
    ]);
    await p.toTest('Bea', ['Rex']);
    const row = await cardRow(card.id);
    expect(row.stage).toBe('test');
    expect(row.fields.integrationTests).toBe(true);
    const v4 = (
      await q(`SELECT id FROM workflow_versions WHERE key='code' AND version=4 AND org_id IS NULL`)
    )[0];
    expect(row.workflow_version_id).toBe(v4.id);
  });

  it('leaves a card that already reached Test on its version', async () => {
    await hireTeam(w);
    const card = await w.card({ title: 'Already testing' });
    const v3 = (
      await q(`SELECT id FROM workflow_versions WHERE key='code' AND version=3 AND org_id IS NULL`)
    )[0];
    await q(`UPDATE cards SET workflow_version_id=$2 WHERE id=$1`, [card.id, v3.id]);
    await p.toTest('Bea', ['Rex']);
    // project is off, but v3 always tests: the card stays on v3 and is tested as before
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finalize' });
  });
});

describe('provisioning a test environment (local mode)', () => {
  it('starts the card commit on its workstation, files a DevOps request without a plan, and the tester claims it once healthy', async () => {
    await setSettings();
    await hireTeam(w);
    const card = await cardAtTest();
    const before = startFrames().length;
    const mark = r.received.length;
    await dispatcher().run();
    await r.barrier();
    // the card waits for its environment: no tester shift yet
    expect(testerStartsFrom(mark)).toHaveLength(0);
    const env = await envOf(card.id);
    expect(env).toMatchObject({ purpose: 'test', state: 'requested', card_id: card.id });
    const frame = (await r.waitFor(
      'command',
      (f) => f.command === 'run.start' && f.payload.envId === env.id,
    )) as any;
    expect(startFrames().length).toBe(before + 1);
    expect(frame.payload).toMatchObject({
      purpose: 'test',
      projectKey: 'TOY',
      rebaseCard: { repoId: w.repoId, baseBranch: 'main' },
    });
    expect(frame.payload.rebaseCard.cardWorktreePath).toMatch(/^\/work\/TOY-/);
    // no saved plan: the DevOps engineer is asked, with the card in context
    expect(frame.payload.requestId).toBe(env.devops_request_id);
    const req = (await q('SELECT * FROM devops_requests WHERE id=$1', [env.devops_request_id]))[0];
    expect(req.context).toMatchObject({ requestKind: 'run', envId: env.id, cardId: card.id });
    expect(req.summary).toContain(`integration tests of ${card.ref}`);

    // the card page says why nothing happens yet
    const waiting = (await call('GET', `/api/cards/${card.id}`)).workability;
    expect(waiting).toMatchObject({ ok: false, level: 'waiting' });
    expect(waiting.reason).toMatch(/starting its test environment/);

    // one environment per card: a second pass starts nothing
    await dispatcher().run();
    expect(startFrames().length).toBe(before + 1);

    await status(env.id, 'healthy', { sources: [{ repoId: w.repoId, commit: 'abc1234' }] });
    expect((await call('GET', `/api/cards/${card.id}`)).workability.ok).toBe(true);
    await dispatcher().run();
    const start = await p.next('Tess');
    expect(start.brief.environment).toMatchObject({
      mode: 'local',
      envId: env.id,
      flakyRetry: 1,
      suites: [{ name: 'api' }, { name: 'e2e' }],
    });
    expect(start.brief.shift.maxShiftMinutes).toBe(120);
  });

  it('replays a saved plan with no DevOps request', async () => {
    await setSettings();
    await hireTeam(w);
    const first = await cardAtTest('First');
    await dispatcher().run();
    const e1 = await envOf(first.id);
    r.send('run.plan.saved', { envId: e1.id, plan: PLAN(), buildHash: 'h' });
    await r.barrier();
    await status(e1.id, 'failed', { error: 'give up', endReason: 'failed' });
    // the second card finds the plan
    await q(`UPDATE cards SET status='cancelled' WHERE id=$1`, [first.id]);
    const second = await cardAtTest('Second');
    await dispatcher().run();
    const e2 = await envOf(second.id);
    expect(e2).toMatchObject({ purpose: 'test', replayed: true, devops_request_id: null });
    const frame = (await r.waitFor(
      'command',
      (f) => f.command === 'run.start' && f.payload.envId === e2.id,
    )) as any;
    expect(frame.payload.replay).toMatchObject({ version: expect.any(Number), buildHash: 'h' });
    expect(frame.payload.requestId).toBeNull();
  });

  it('does not wait for an environment when the runner cannot start one (old runner)', async () => {
    await setSettings();
    await hireTeam(w);
    await q(
      `UPDATE workstation_capabilities SET capabilities = ARRAY['runs:1','runs:2'] WHERE workstation_id=$1`,
      [w.workstationId],
    );
    const card = await cardAtTest('Old runner');
    await dispatcher().run();
    expect(await envOf(card.id)).toBeUndefined();
    const start = await p.next('Tess');
    expect(start.brief.environment).toBeUndefined();
    await q(
      `UPDATE workstation_capabilities SET capabilities = ARRAY['runs:1','runs:2','runs:3'] WHERE workstation_id=$1`,
      [w.workstationId],
    );
  });

  it('a card the owner opted out of is not provisioned', async () => {
    await setSettings();
    await hireTeam(w);
    const card = await w.card({ title: 'Docs only' });
    await call('PATCH', `/api/cards/${card.id}`, { integrationTests: false });
    await p.toTest('Bea', ['Rex']);
    await dispatcher().run();
    expect(await envOf(card.id)).toBeUndefined();
    expect((await cardRow(card.id)).stage).toBe('finalize');
  });

  it('a runner that refuses the rebase conflict sends the card to Rework with the files', async () => {
    await setSettings();
    await hireTeam(w);
    const card = await cardAtTest('Conflicting');
    await dispatcher().run();
    const env = await envOf(card.id);
    await status(env.id, 'failed', {
      error: 'the card branch conflicts with main: src/a.ts',
      endReason: 'failed',
      rebaseConflictFiles: ['src/a.ts'],
    });
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ stage: 'build', rework_round: 1 });
    const msg = (
      await q(`SELECT body FROM thread_messages WHERE thread_id=$1 ORDER BY created_at DESC LIMIT 3`, [
        card.id,
      ])
    )
      .map((m: any) => m.body)
      .join('\n');
    expect(msg).toMatch(/src\/a\.ts/);
  });

  it('tries again after the DevOps request ended without a running environment, and needs a person the third time', async () => {
    await setSettings();
    await hireTeam(w);
    const card = await cardAtTest('Cannot run');
    const fail = async (envId: string, requestId: string) => {
      await q(`UPDATE devops_requests SET status='failed', updated_at=$2 WHERE id=$1`, [
        requestId,
        new Date(w.t.clock.now().getTime() - 60_000),
      ]);
      await expireRuns(w.t.app.ctx);
      await status(envId, 'failed', { error: 'could not start', endReason: 'failed' });
      await dispatcher().run(); // parks the card on the (finished) DevOps request
      await dispatcher().run(); // which returns it to the queue, and a new environment starts
    };
    await dispatcher().run();
    const e1 = await envOf(card.id);
    await fail(e1.id, e1.devops_request_id);
    const e2 = await envOf(card.id);
    expect(e2.id).not.toBe(e1.id);
    expect(e2.state).toBe('requested');
    expect((await cardRow(card.id)).env_parks).toBe(1);

    await fail(e2.id, e2.devops_request_id);
    const e3 = await envOf(card.id);
    expect(e3.id).not.toBe(e2.id);
    expect((await cardRow(card.id)).env_parks).toBe(2);

    await fail(e3.id, e3.devops_request_id);
    const item = (await q(`SELECT * FROM desk_items WHERE subkind='test_environment' AND status='open'`))[0];
    expect(item).toBeTruthy();
    expect(item.blocking).toBe(true);
    expect(item.title).toMatch(/cannot be tested/);
    expect(item.body).toMatch(/already tried to make the project run twice/);
  });
});

describe('suites, the verdict and the environment', () => {
  /** A card at Test with a healthy environment and a tester shift running on it. */
  async function testing(settings: Record<string, unknown> = {}) {
    await setSettings(settings);
    await hireTeam(w);
    const card = await cardAtTest();
    await dispatcher().run();
    const env = await envOf(card.id);
    await status(env.id, 'healthy');
    const start = await p.next('Tess');
    await p.startShift(r, start);
    return { card, env, start };
  }
  const report = (shiftId: string, rep: Record<string, unknown>) => p.report(r, shiftId, rep);
  const suite = (shiftId: string, name: string, st: string, extra: Record<string, unknown> = {}) =>
    rpc(shiftId, 'test.suite', { name, status: st, passed: 3, failed: st === 'failed' ? 1 : 0, ...extra });

  it('refuses a pass while a confirmed suite has no passing result, then accepts it', async () => {
    const { card, env, start } = await testing();
    const refused = await report(start.shiftId, testPass());
    expect(refused.accepted).toBe(false);
    expect(refused.error).toMatch(/no passing result yet: api, e2e/);

    expect((await suite(start.shiftId, 'api', 'passed')).ok).toBe(true);
    const still = await report(start.shiftId, testPass());
    expect(still.error).toMatch(/e2e/);
    expect((await suite(start.shiftId, 'e2e', 'skipped')).ok).toBe(true);

    const done = await report(start.shiftId, testPass());
    expect(done.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');

    const rows = await q(`SELECT * FROM test_suite_results WHERE card_id=$1 ORDER BY created_at`, [card.id]);
    expect(rows.map((x: any) => [x.suite, x.status, x.kind, x.env_mode, x.env_id])).toEqual([
      ['api', 'passed', 'integration', 'local', env.id],
      ['e2e', 'skipped', 'e2e', 'local', env.id],
    ]);
    // the verdict stops the environment
    const stop = await r.waitFor('command', (f) => f.command === 'run.stop' && f.payload.envId === env.id);
    expect(stop.payload.reason).toBe('verdict');
    expect(await envOf(card.id)).toMatchObject({ state: 'stopping' });
    // the card page shows the table
    const detail = await call('GET', `/api/cards/${card.id}`);
    expect(detail.testing.suiteResults.map((x: any) => [x.suite, x.status])).toEqual([
      ['api', 'passed'],
      ['e2e', 'skipped'],
    ]);
  });

  it('records a pass after a failure as flaky, with the attempts', async () => {
    const { card, start } = await testing();
    const failed = await suite(start.shiftId, 'api', 'failed', { failures: ['api.items > creates'] });
    expect((failed.result as any).message).toMatch(/once more/);
    const second = await suite(start.shiftId, 'api', 'passed');
    expect(second.result as any).toMatchObject({ status: 'flaky', attempts: 2 });
    // a flaky result lets the card pass
    await suite(start.shiftId, 'e2e', 'passed');
    expect((await report(start.shiftId, testPass())).accepted).toBe(true);
    const rows = await q(
      `SELECT suite, status, attempts FROM test_suite_results WHERE card_id=$1 ORDER BY created_at`,
      [card.id],
    );
    expect(rows.map((x: any) => [x.suite, x.status, x.attempts])).toEqual([
      ['api', 'failed', 1],
      ['api', 'flaky', 2],
      ['e2e', 'passed', 1],
    ]);
  });

  it('raises one desk notice when a suite was flaky three times within a week', async () => {
    const { start } = await testing();
    for (let i = 0; i < 3; i++) {
      await suite(start.shiftId, 'api', 'failed');
      await suite(start.shiftId, 'api', 'passed');
    }
    const flaky = await q(`SELECT 1 FROM test_suite_results WHERE status='flaky'`);
    expect(flaky).toHaveLength(3);
    const items = await q(`SELECT * FROM desk_items WHERE subkind='flaky_suite'`);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ title: 'Suite "api" is flaky', blocking: false, status: 'open' });
    // a fourth does not add another while the first is open
    await suite(start.shiftId, 'api', 'failed');
    await suite(start.shiftId, 'api', 'passed');
    expect(await q(`SELECT 1 FROM desk_items WHERE subkind='flaky_suite'`)).toHaveLength(1);
  });

  it('a failing suite blocks the pass until it passes; flaky without a failure is just passed', async () => {
    const { start } = await testing({ flakyRetry: 0 });
    const first = await suite(start.shiftId, 'api', 'failed');
    expect((first.result as any).message).toMatch(/aom test fail/);
    await suite(start.shiftId, 'e2e', 'flaky'); // nothing failed before: a plain pass
    const rows = await q(
      `SELECT suite, status FROM test_suite_results WHERE shift_id=$1 ORDER BY created_at`,
      [start.shiftId],
    );
    expect(rows.at(-1)).toMatchObject({ suite: 'e2e', status: 'passed' });
    expect((await report(start.shiftId, testPass())).error).toMatch(/api/);
  });

  it('only the tester of the claiming shift reports suites', async () => {
    const { start } = await testing();
    const other = await rpc(randomUUID(), 'test.suite', { name: 'api', status: 'passed' });
    expect(other.ok).toBe(false);
    const bad = await rpc(start.shiftId, 'test.suite', { name: 'api', status: 'nope' });
    expect(bad.ok).toBe(false);
  });

  it('keeps the environment for the failed card and stops it after keepOnFailureMin', async () => {
    const { card, env, start } = await testing({ keepOnFailureMin: 30 });
    await suite(start.shiftId, 'api', 'failed');
    const failed = await report(start.shiftId, testFail());
    expect(failed.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    const row = await envOf(card.id);
    expect(row.verdict_at).toBeTruthy();
    expect(row.state).toBe('healthy');
    expect(new Date(row.expires_at).getTime() - w.t.clock.now().getTime()).toBeCloseTo(30 * 60_000, -4);
    expect(r.of('command').some((f) => f.command === 'run.stop' && f.payload.envId === env.id)).toBe(false);
    const detail = await call('GET', `/api/cards/${card.id}`);
    expect(detail.testing.testEnvironment).toMatchObject({ envId: env.id, state: 'healthy' });
    expect(detail.testing.testEnvironment.keptUntil).toBeTruthy();
    // after the time is up the TTL tick stops it
    await q('UPDATE run_environments SET expires_at=$2 WHERE id=$1', [
      env.id,
      new Date(w.t.clock.now().getTime() - 1000),
    ]);
    expect((await expireRuns(w.t.app.ctx)).stopped).toContain(env.id);
  });

  it('a kept environment is not used again: the retest gets a new one', async () => {
    const { card, env, start } = await testing();
    await report(start.shiftId, testFail());
    r.ended(start.shiftId, 'reported');
    expect((await envOf(card.id)).verdict_at).toBeTruthy();
    // the bug child is fixed and reviewed: the card returns to Test
    const bug = (await q(`SELECT id FROM cards WHERE parent_card_id=$1`, [card.id]))[0];
    await p.run('Bea', handoff());
    await p.run('Rex', approve());
    expect(bug.id).toBeTruthy();
    await dispatcher().run();
    const next = await envOf(card.id);
    expect(next.id).not.toBe(env.id);
    expect(next.state).toBe('requested');
  });

  it('stops the environment when the card leaves the stage another way', async () => {
    const { card, env } = await testing();
    await call('POST', `/api/cards/${card.id}/cancel`, { reason: 'not needed' });
    await dispatcher().run();
    const stop = await r.waitFor('command', (f) => f.command === 'run.stop' && f.payload.envId === env.id);
    expect(stop.payload.reason).toBe('verdict');
  });
});

describe('shift start problems', () => {
  it('a tester shift the runner turned away because the environment is gone provisions a new one through DevOps', async () => {
    await setSettings();
    await hireTeam(w);
    const card = await cardAtTest();
    await dispatcher().run();
    const env = await envOf(card.id);
    await status(env.id, 'healthy');
    const start = await p.next('Tess');
    r.rejected(start.shiftId, 'environment_not_ready', {
      detail: 'this runner does not know the test environment (any more)',
      environment: {
        problem: 'run_failed',
        detail: 'this runner does not know the test environment (any more)',
      },
    });
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
      3000,
    );
    const row = await cardRow(card.id);
    expect(row).toMatchObject({ status: 'waiting', park_problem: 'run_failed', env_parks: 1 });
    const fresh2 = await envOf(card.id);
    expect(fresh2.id).not.toBe(env.id);
    expect(fresh2.devops_request_id).toBeTruthy();
    expect((await q('SELECT state FROM run_environments WHERE id=$1', [env.id]))[0].state).toBe('stopping');
  });
});
