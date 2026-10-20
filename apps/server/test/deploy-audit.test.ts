import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requestDeployRun } from '../src/delivery/runs.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import {
  type DeliveryWorld,
  deliveryWorld,
  healthyRun,
  parseFixture,
  passedRegression,
  setWeekday,
} from './helpers/delivery.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { ok, until } from './helpers/world.ts';

/**
 * The audit of a deploy (docs/design/ceo-front-door.md 9.6): `DeliveryRecipeApproved` plus `DeployGateSatisfied`, whose evidence
 * ids are facts the server holds (not text); recipe secrets are names only; the projections replay.
 */
const COMMIT = 'abc1234def5678abc1234def5678abc1234def56';
let d: DeliveryWorld;
let r: FakeRunner;

beforeAll(async () => {
  d = await deliveryWorld();
  r = await d.w.connectRunner({ capabilities: ['ceo:1', 'delivery:1'] });
  await keepOnline(d.w);
  await setWeekday(d);
  const o = await d.observe(parseFixture(), { commit: '9999999aaaaaaa' });
  await ok(d.approve(o.hash));
  await ok(
    d.w.t.req('PUT', `/api/projects/${d.w.projectId}/delivery/mode`, {
      cookie: d.w.owner.cookie,
      body: { mode: 'recipe' },
    }),
  );
});
afterAll(async () => {
  r.close();
  await d.w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  d.w.t.req(method, url, {
    cookie: d.w.owner.cookie,
    headers: { 'x-aom-org': d.orgId },
    ...(body === undefined ? {} : { body }),
  });

describe('DeployGateSatisfied evidence', () => {
  it('names records that exist: the healthy run of the earlier environment and the passed regression run', async () => {
    const runLocal = await healthyRun(d, 'local', COMMIT, 45);
    const reg = await passedRegression(d, 1);
    const res = await ok<any>(
      owner('POST', `/api/projects/${d.w.projectId}/delivery/deploy`, { env: 'production', commit: COMMIT }),
    );
    expect(res.runs[0].status).toBe('queued');
    const [g] = await q(
      `SELECT payload FROM events WHERE type='DeployGateSatisfied' AND payload->>'runId'=$1`,
      [res.runs[0].runId],
    );
    const evidence = g!.payload.evidence as Array<{
      requirement: string;
      ref: string | null;
      detail: string;
    }>;
    expect(evidence.map((e) => e.ref).sort()).toEqual([runLocal, reg].sort());
    for (const e of evidence) {
      const found = await q(
        `SELECT 1 FROM deploy_runs WHERE id=$1 UNION ALL SELECT 1 FROM test_runs WHERE id=$1`,
        [e.ref],
      );
      expect(found, e.requirement).toHaveLength(1);
    }
    // the gate that was evaluated is in the event, and the approval that made it possible is on record
    expect(g!.payload.gate).toEqual([
      expect.objectContaining({ label: 'recipe', requires: expect.any(Array) }),
    ]);
    expect(
      await q(`SELECT 1 FROM events WHERE type='DeliveryRecipeApproved' AND payload->>'hash'=$1`, [
        g!.payload.recipeHash,
      ]),
    ).toHaveLength(1);
    // and the run row shows the same evidence to the Deploys page
    const runs = await ok<any>(owner('GET', '/api/delivery/runs'));
    const dto = runs.runs.find((x: any) => x.id === res.runs[0].runId);
    expect(dto).toMatchObject({
      status: 'queued',
      releasedBy: { kind: 'owner' },
      recipeHash: g!.payload.recipeHash,
    });
    expect(dto.evidence).toHaveLength(2);
  });
});

describe('recipe secrets: names only, sealed to the runner', () => {
  const key = () =>
    q(
      `INSERT INTO workstation_keys (workstation_id, key_id, public_key, updated_at) VALUES ($1,'abcd1234abcd1234','AAAA',now())
       ON CONFLICT (workstation_id) DO UPDATE SET key_id = EXCLUDED.key_id`,
      [d.w.workstationId],
    );
  const url = () => `/api/workstations/${d.w.workstationId}/deploy-secrets`;
  const body = (over: Record<string, unknown> = {}) => ({
    projectId: d.w.projectId,
    name: 'P5_PROD_DEPLOY_KEY',
    keyId: 'abcd1234abcd1234',
    ciphertext: 'c2VhbGVk',
    ...over,
  });

  it('relays the sealed value, forgets it when answered, and remembers only that the name has a value', async () => {
    await key();
    const from = r.received.length;
    expect((await owner('PUT', url(), body())).status).toBe(202);
    const frame = (await r.waitFor('command', (f) => f.command === 'deploy.secret.set', 5000, from)) as any;
    expect(frame.payload).toMatchObject({
      projectId: d.w.projectId,
      name: 'P5_PROD_DEPLOY_KEY',
      ciphertext: 'c2VhbGVk',
    });
    r.send('command.result', { commandId: frame.commandId, ok: true, result: { stored: true } });
    await until(async () => (await q(`SELECT 1 FROM deploy_secret_status`)).length === 1, 4000, 'status');
    expect(
      (await q(`SELECT payload FROM runner_commands WHERE id=$1`, [frame.commandId]))[0]!.payload,
    ).toEqual({});
    const s = await ok<any>(owner('GET', `/api/projects/${d.w.projectId}/delivery`));
    expect(s.secrets).toEqual([
      expect.objectContaining({ workstationId: d.w.workstationId, name: 'P5_PROD_DEPLOY_KEY' }),
    ]);
    expect(await q(`SELECT 1 FROM events WHERE payload::text LIKE '%c2VhbGVk%'`)).toHaveLength(0);
    expect(
      await q(`SELECT 1 FROM events WHERE type='DeploySecretSet' AND payload->>'name'='P5_PROD_DEPLOY_KEY'`),
    ).toHaveLength(1);
  });

  it('refuses a name the recipe does not use, a stale key and a workstation that is not yours', async () => {
    await key();
    expect((await owner('PUT', url(), body({ name: 'SOMETHING_ELSE' }))).body.error.code).toBe(
      'unknown_secret_name',
    );
    expect((await owner('PUT', url(), body({ keyId: 'ffff' }))).body.error.code).toBe('sudo_key_changed');
    expect((await owner('PUT', url(), body({ name: 'lower_case' }))).status).toBe(400);
    const stranger = await d.w.t.userSession(`s-${randomUUID().slice(0, 6)}@example.test`);
    expect((await d.w.t.req('PUT', url(), { cookie: stranger.cookie, body: body() })).status).toBe(404);
  });
});

describe('the projections replay', () => {
  it('rebuilding from the events gives the same recipes, presets, runs and mode', async () => {
    await ok(
      owner('PUT', '/api/delivery/presets', {
        name: 'standard',
        gate: { requires: [{ checksPassed: 'regression' }], window: { days: 'mon-fri', hours: '08-16' } },
      }),
    );
    await ok(
      owner('PUT', '/api/delivery/bindings', {
        projectId: d.w.projectId,
        envMatch: 'production',
        preset: 'standard',
      }),
    );
    await requestDeployRun(d.w.t.app.ctx, {
      projectId: d.w.projectId,
      env: 'local',
      commit: COMMIT,
      trigger: 'request',
      requester: { kind: 'trigger', id: null },
    });
    const snap = async () => ({
      recipe: await q(
        'SELECT status, observed_hash, approved_hash, approved_commit, version, parsed, approved_parsed, lint, files, approved_files FROM delivery_recipes',
      ),
      presets: await q('SELECT name, gate FROM gate_presets ORDER BY name'),
      bindings: await q('SELECT project_id, env_match, preset FROM gate_bindings'),
      runs: await q(
        "SELECT id, env, target_name, status, commit, hash, trigger, requested_by, released_by, evidence, health, refusal, missing, trial FROM deploy_runs WHERE hash <> repeat('c', 64) ORDER BY id",
      ),
      mode: await q('SELECT delivery_mode FROM projects WHERE id=$1', [d.w.projectId]),
    });
    const before = await snap();
    expect(before.runs.length).toBeGreaterThanOrEqual(2);
    await rebuildProjections(d.w.t.app.ctx.pool, d.w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
  });
});
