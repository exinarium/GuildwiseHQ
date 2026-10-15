import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sweepIntegrations } from '../src/commands/integrations.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
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
const targetsUrl = () => `/api/projects/${w.projectId}/deploy-targets`;

const rpc = async (shiftId: string, method: string, params: Record<string, unknown> = {}) => {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId, method, params });
  return r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 30_000, from);
};

const TARGET = {
  name: 'staging',
  kind: 'local_docker',
  appUrl: 'https://staging.example.test',
  notes: '',
  testEnabled: true,
  testHosts: ['api.staging.example.test'],
  secretNames: ['TEST_USER_PASSWORD'],
};
const addTarget = async (over: Record<string, unknown> = {}, status = 201) =>
  call('POST', targetsUrl(), { ...TARGET, ...over }, status);

beforeEach(async () => {
  await q(
    `TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages,
       desk_items, card_blockers, ledger_entries, devops_requests, runner_commands, runner_inbox,
       run_environments, run_plans, test_suite_results, deploy_targets, target_secret_status CASCADE`,
  );
  await q('DELETE FROM agents WHERE NOT is_devops');
  await call('PUT', settingsUrl(), { settings: { mode: 'off' } });
  dispatcher().cooldown.clear();
});

describe('deploy targets that may be tested', () => {
  it('opts a target in with its extra hosts and the names of its test accounts', async () => {
    const res = await addTarget();
    const list = (await call('GET', targetsUrl())).targets;
    expect(list[0]).toMatchObject({
      id: res.target?.id ?? list[0].id,
      name: 'staging',
      testEnabled: true,
      production: false,
      destructiveOk: false,
      testHosts: ['api.staging.example.test'],
      secretNames: ['TEST_USER_PASSWORD'],
    });
    const id = list[0].id;
    await call('PATCH', `/api/deploy-targets/${id}`, { destructiveOk: true, secretNames: ['A', 'B'] });
    const after = (await call('GET', targetsUrl())).targets[0];
    expect(after).toMatchObject({ destructiveOk: true, secretNames: ['A', 'B'], testEnabled: true });
  });

  it('refuses a production target that is tested, and a tested target with no URL', async () => {
    const bad = await addTarget({ production: true }, 422);
    expect(bad.error.code).toBe('production_not_tested');
    const noUrl = await addTarget({ appUrl: undefined }, 422);
    expect(noUrl.error.code).toBe('test_needs_url');
    await addTarget({ testEnabled: false, production: true });
    const prod = (await call('GET', targetsUrl())).targets[0];
    const again = await call('PATCH', `/api/deploy-targets/${prod.id}`, { testEnabled: true }, 422);
    expect(again.error.code).toBe('production_not_tested');
    // the database says no as well
    await expect(q('UPDATE deploy_targets SET test_enabled = true WHERE id=$1', [prod.id])).rejects.toThrow(
      /deploy_targets_no_production_tests/,
    );
  });

  it('rejects hosts that are not hostnames and secret names that are not names', async () => {
    await addTarget({ testHosts: ['https://x.test/path'] }, 400);
    await addTarget({ secretNames: ['has space'] }, 400);
  });
});

describe('the remote mode setting', () => {
  it('needs a target the tester may test', async () => {
    await call('PUT', settingsUrl(), { settings: { mode: 'remote', deployTargetId: randomUUID() } }, 400);
    await addTarget({ name: 'off', testEnabled: false });
    await addTarget({ name: 'prod', testEnabled: false, production: true });
    await addTarget({ name: 'ok' });
    const targets = (await call('GET', targetsUrl())).targets;
    const id = (n: string) => targets.find((t: any) => t.name === n).id;
    const shown = (await call('GET', settingsUrl())).targets;
    expect(shown.map((t: any) => [t.name, t.testEnabled, t.production])).toEqual([
      ['off', false, false],
      ['ok', true, false],
      ['prod', false, true],
    ]);
    await call('PUT', settingsUrl(), { settings: { mode: 'remote', deployTargetId: id('off') } }, 400);
    await call('PUT', settingsUrl(), { settings: { mode: 'remote', deployTargetId: id('prod') } }, 400);
    const saved = await call('PUT', settingsUrl(), {
      settings: { mode: 'remote', deployTargetId: id('ok') },
    });
    expect(saved.settings).toMatchObject({ mode: 'remote', deployTargetId: id('ok') });
  });
});

describe('a tester testing a deployed target', () => {
  async function setup(destructiveOk: boolean) {
    await addTarget({ destructiveOk });
    const target = (await call('GET', targetsUrl())).targets[0];
    await call('PUT', settingsUrl(), {
      settings: {
        mode: 'remote',
        deployTargetId: target.id,
        suites: [
          { name: 'api', repoId: w.repoId, cmd: ['npm', 'run', 'it'] },
          { name: 'wipe', repoId: w.repoId, cmd: ['npm', 'run', 'reset'], destructive: true },
        ],
      },
    });
    await hireTeam(w);
    const card = await w.card({ title: 'Remote' });
    expect(card.fields.integrationTests).toBe(true);
    await p.toTest('Bea', ['Rex']);
    return { target, card };
  }
  const suite = (shiftId: string, name: string, status: string) =>
    rpc(shiftId, 'test.suite', { name, status, passed: 2 });

  it('starts nothing for the card and briefs the tester with the target', async () => {
    const { target, card } = await setup(false);
    const before = r.of('command').filter((f) => f.command === 'run.start').length;
    await dispatcher().run();
    expect(await q('SELECT 1 FROM run_environments WHERE card_id=$1', [card.id])).toHaveLength(0);
    expect(r.of('command').filter((f) => f.command === 'run.start').length).toBe(before);
    const start = await p.next('Tess');
    expect(start.brief.environment).toMatchObject({
      mode: 'remote',
      target: {
        id: target.id,
        name: 'staging',
        url: 'https://staging.example.test',
        hosts: ['api.staging.example.test'],
        destructiveOk: false,
        secretNames: ['TEST_USER_PASSWORD'],
      },
    });
    expect(start.brief.environment?.suites.map((s: any) => s.name)).toEqual(['api', 'wipe']);
    expect(start.brief.environment?.envId).toBeUndefined();
  });

  it('skips a destructive suite on a target that does not allow it, and the pass does not wait for it', async () => {
    const { target, card } = await setup(false);
    const start = await p.next('Tess');
    await p.startShift(r, start);
    const refused = await suite(start.shiftId, 'wipe', 'passed');
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/does not allow that.*--status skipped/);
    expect((await suite(start.shiftId, 'wipe', 'skipped')).ok).toBe(true);
    // api is still open
    expect((await p.report(r, start.shiftId, testPass())).error).toMatch(/no passing result yet: api/);
    expect((await suite(start.shiftId, 'api', 'passed')).ok).toBe(true);
    expect((await p.report(r, start.shiftId, testPass())).accepted).toBe(true);
    const rows = await q(
      `SELECT suite, status, env_mode, deploy_target_id, env_id FROM test_suite_results WHERE card_id=$1 ORDER BY created_at`,
      [card.id],
    );
    expect(rows).toEqual([
      { suite: 'wipe', status: 'skipped', env_mode: 'remote', deploy_target_id: target.id, env_id: null },
      { suite: 'api', status: 'passed', env_mode: 'remote', deploy_target_id: target.id, env_id: null },
    ]);
    const detail = await call('GET', `/api/cards/${card.id}`);
    expect(detail.testing.suiteResults.map((x: any) => x.targetName)).toEqual(['staging', 'staging']);
  });

  it('requires the destructive suite when the target allows it', async () => {
    await setup(true);
    const start = await p.next('Tess');
    await p.startShift(r, start);
    expect((await suite(start.shiftId, 'api', 'passed')).ok).toBe(true);
    expect((await p.report(r, start.shiftId, testPass())).error).toMatch(/no passing result yet: wipe/);
    expect((await suite(start.shiftId, 'wipe', 'passed')).ok).toBe(true);
    expect((await p.report(r, start.shiftId, testPass())).accepted).toBe(true);
  });

  it('a target that does not answer is a blocking item for the owner, not a retry loop', async () => {
    const { card } = await setup(false);
    const start = await p.next('Tess');
    r.rejected(start.shiftId, 'environment_not_ready', {
      detail: 'https://staging.example.test: ECONNREFUSED',
      environment: { problem: 'target_unreachable', detail: 'https://staging.example.test: ECONNREFUSED' },
    });
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
      3000,
    );
    const item = (await q(`SELECT * FROM desk_items WHERE subkind='test_environment' AND status='open'`))[0];
    expect(item).toMatchObject({ blocking: true });
    expect(item.title).toMatch(/does not answer/);
    expect(await q('SELECT 1 FROM run_environments WHERE card_id=$1', [card.id])).toHaveLength(0);
  });

  it('a target that was switched off meanwhile gives the tester no environment', async () => {
    const { target } = await setup(false);
    await call('PATCH', `/api/deploy-targets/${target.id}`, { testEnabled: false });
    const start = await p.next('Tess');
    expect(start.brief.environment).toBeUndefined();
  });
});

describe('test accounts', () => {
  async function key() {
    await q(
      `INSERT INTO workstation_keys (workstation_id, key_id, public_key, updated_at) VALUES ($1,'abcd1234abcd1234','AAAA',now())
       ON CONFLICT (workstation_id) DO UPDATE SET key_id = EXCLUDED.key_id`,
      [w.workstationId],
    );
  }
  const secretUrl = () => `/api/workstations/${w.workstationId}/target-secrets`;

  it('relays the sealed value to the runner, forgets it when answered and remembers only that the name has a value', async () => {
    await key();
    await addTarget();
    const target = (await call('GET', targetsUrl())).targets[0];
    const from = r.received.length;
    await call(
      'PUT',
      secretUrl(),
      { targetId: target.id, name: 'TEST_USER_PASSWORD', keyId: 'abcd1234abcd1234', ciphertext: 'c2VhbGVk' },
      202,
    );
    const frame = (await r.waitFor('command', (f) => f.command === 'env.secret.set', 5000, from)) as any;
    expect(frame.payload).toMatchObject({
      targetId: target.id,
      name: 'TEST_USER_PASSWORD',
      ciphertext: 'c2VhbGVk',
    });
    r.send('command.result', { commandId: frame.commandId, ok: true, result: { stored: true } });
    await r.barrier();
    const cmd = (await q(`SELECT payload, status FROM runner_commands WHERE id=$1`, [frame.commandId]))[0];
    expect(cmd.payload).toEqual({});
    const status = await call('GET', `/api/projects/${w.projectId}/target-secrets`);
    expect(status.secrets).toMatchObject([
      { workstationId: w.workstationId, targetId: target.id, name: 'TEST_USER_PASSWORD' },
    ]);
    // no event, no log of the value anywhere
    expect(await q(`SELECT 1 FROM events WHERE payload::text LIKE '%c2VhbGVk%'`)).toHaveLength(0);
  });

  it('refuses a name the target did not declare, a stale key and a workstation that is not yours', async () => {
    await key();
    await addTarget();
    const target = (await call('GET', targetsUrl())).targets[0];
    const body = {
      targetId: target.id,
      name: 'TEST_USER_PASSWORD',
      keyId: 'abcd1234abcd1234',
      ciphertext: 'x',
    };
    expect((await call('PUT', secretUrl(), { ...body, name: 'OTHER' }, 422)).error.code).toBe(
      'unknown_secret_name',
    );
    expect((await call('PUT', secretUrl(), { ...body, keyId: 'ffff' }, 409)).error.code).toBe(
      'sudo_key_changed',
    );
    const stranger = await w.t.userSession(`s-${randomUUID().slice(0, 6)}@example.test`);
    await call('PUT', secretUrl(), body, 404, stranger.cookie);
    await call('PUT', secretUrl(), { ...body, name: 'bad name' }, 400);
  });

  it('a sealed value expires: nobody collecting it within a day empties it', async () => {
    await key();
    await addTarget();
    const target = (await call('GET', targetsUrl())).targets[0];
    await call(
      'PUT',
      secretUrl(),
      { targetId: target.id, name: 'TEST_USER_PASSWORD', keyId: 'abcd1234abcd1234', ciphertext: 'c2VhbGVk' },
      202,
    );
    const row = (
      await q(
        `SELECT id, expires_at FROM runner_commands WHERE type='env.secret.set' ORDER BY created_at DESC`,
      )
    )[0];
    expect(new Date(row.expires_at).getTime() - w.t.clock.now().getTime()).toBeCloseTo(24 * 3_600_000, -4);
    await q(`UPDATE runner_commands SET status='pending', expires_at=$2 WHERE id=$1`, [
      row.id,
      new Date(w.t.clock.now().getTime() - 1000),
    ]);
    await sweepIntegrations(w.t.app.ctx);
    expect((await q('SELECT payload, status FROM runner_commands WHERE id=$1', [row.id]))[0]).toMatchObject({
      payload: {},
      status: 'failed',
    });
  });
});

describe('cards not pinned to this setting', () => {
  it('a card of a project in remote mode runs the plain tester stage when the owner opts it out', async () => {
    await addTarget();
    const target = (await call('GET', targetsUrl())).targets[0];
    await call('PUT', settingsUrl(), { settings: { mode: 'remote', deployTargetId: target.id } });
    await hireTeam(w);
    const card = await w.card({ title: 'No tests' });
    await call('PATCH', `/api/cards/${card.id}`, { integrationTests: false });
    await p.toTest('Bea', ['Rex']);
    expect((await cardRow(card.id)).stage).toBe('test');
    // no target in the brief: the tester works as before #59
    expect((await p.next('Tess')).brief.environment).toBeUndefined();
  });
});
