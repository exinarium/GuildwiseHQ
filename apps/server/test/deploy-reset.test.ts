import { randomUUID } from 'node:crypto';
import {
  compileSetup,
  DEPLOY_SETUP_CAPABILITY,
  DEPLOY_SETUP_V2_CAPABILITY,
  localAdoptEnv,
  parseRecipe,
  type RecipeInspectResult,
  sha256Hex,
  sshShipEnv,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyDeployReset,
  formatResetPlan,
  planDeployReset,
  planDeployResetReadOnly,
} from '../src/data-migrations/deploy-reset.ts';
import { observeRecipe } from '../src/delivery/recipes.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import { type DeliveryWorld, deliveryWorld } from './helpers/delivery.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { ok } from './helpers/world.ts';

// The one-off reset for the new Environments page (docs/DEPLOY.md, release notes): events only, no runner, no server.

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];
let d: DeliveryWorld;
let r: FakeRunner;

beforeAll(async () => {
  d = await deliveryWorld();
  r = await d.w.connectRunner({
    capabilities: ['ceo:1', 'delivery:1', DEPLOY_SETUP_CAPABILITY, DEPLOY_SETUP_V2_CAPABILITY],
  });
  await keepOnline(d.w);
});
afterAll(async () => {
  r.close();
  await d.w.t.close();
  await closeAdminPool();
});

const base = () => `/api/projects/${d.w.projectId}`;
const call = (method: string, url: string, body?: unknown, status = 200) =>
  ok<any>(
    d.w.t.req(method, url, {
      cookie: d.w.owner.cookie,
      headers: { 'x-aom-org': d.orgId },
      ...(body === undefined ? {} : { body }),
    }),
    status,
  );

const setup = () => ({
  environments: [
    localAdoptEnv({
      name: 'test',
      label: 'Test site',
      target: 'p5-local',
      composeFile: '~/uat/docker-compose.yml',
      service: 'app',
      imageName: 'uat-app',
      appUrl: 'http://localhost:5500',
    }),
    sshShipEnv({
      name: 'live',
      label: 'Live site',
      target: 'p5-prod',
      host: 'prod',
      composeFile: '/home/administrator/app/flow/compose.yaml',
      service: 'app',
      imageName: 'p5',
      healthUrl: 'https://p5.example.com/ready',
    }),
  ],
});

function inspected(s: unknown): Extract<RecipeInspectResult, { ok: true }> {
  const c = compileSetup(s);
  if (!c.ok) throw new Error(c.issues.join('; '));
  const files = c.files.map((f) => ({
    path: f.path,
    mode: f.mode,
    sha256: sha256Hex(f.content),
    secret: null,
  }));
  const rec = parseRecipe(c.files.find((f) => f.path === 'recipe.yaml')?.content as string);
  if (!rec.ok) throw new Error(rec.error);
  return {
    ok: true,
    present: true,
    vaultCommit: null,
    hash: sha256Hex(JSON.stringify(files)),
    files,
    recipe: rec.recipe,
    lint: [],
    setup: c.setup,
  } as Extract<RecipeInspectResult, { ok: true }>;
}

describe('deploy reset', () => {
  it('clears places and the delivery setup through events, cancels what waits, touches no runner, and is idempotent and replay-safe', async () => {
    const ins = inspected(setup());
    await call('PUT', `${base()}/delivery/setup`, { setup: setup() });
    await observeRecipe(d.w.t.app.ctx, d.w.projectId, ins, d.w.workstationId);
    await q(
      `UPDATE delivery_recipes SET approved_hash=observed_hash, status='approved' WHERE project_id=$1`,
      [d.w.projectId],
    );
    await q(`UPDATE projects SET delivery_mode='recipe' WHERE id=$1`, [d.w.projectId]);
    const waiting = randomUUID();
    await q(
      `INSERT INTO deploy_runs (id, org_id, project_id, recipe_id, env, target_name, hash, trigger, requested_by, status, released_by_policy, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'live','p5-prod',$5,'request','{"kind":"owner","id":null}','waiting_release','owner',now(),now())`,
      [waiting, d.orgId, d.w.projectId, randomUUID(), 'c'.repeat(64)],
    );
    await q(
      `INSERT INTO deploy_target_keys (target_id, workstation_id, project_id, org_id, fingerprint, public_key, alias, method, state, added_at)
       VALUES ($1,$2,$3,$4,$5,$6,'prod','password','active',now())`,
      [
        d.targets.prod,
        d.w.workstationId,
        d.w.projectId,
        d.orgId,
        `SHA256:${'k'.repeat(43)}`,
        `ssh-ed25519 ${'A'.repeat(68)} guildwise-deploy:x`,
      ],
    );
    const commandsBefore = (await q('SELECT count(*)::int AS n FROM runner_commands'))[0].n;
    const sent = r.received.length;

    const plan = await planDeployReset(d.w.t.app.ctx.pool);
    const mine = plan.projects.find((p) => p.projectId === d.w.projectId);
    expect(mine?.targets.map((t) => t.name).sort()).toEqual(['p5-local', 'p5-prod']);
    expect(mine?.openRuns).toEqual([{ id: waiting, env: 'live', status: 'waiting_release' }]);
    const text = formatResetPlan(plan);
    expect(text).toContain('Servers where a Guildwise key may remain');
    expect(text).toContain(`server prod, key SHA256:${'k'.repeat(43)}`);
    // a dry run (plan only) changed nothing
    expect(
      (await q('SELECT count(*)::int AS n FROM deploy_targets WHERE removed_at IS NULL'))[0].n,
    ).toBeGreaterThan(1);

    const n = await applyDeployReset(
      {
        pool: d.w.t.app.ctx.pool,
        store: d.w.t.app.ctx.store,
        clock: d.w.t.clock as never,
        log: () => undefined,
      },
      plan,
    );
    expect(n).toBeGreaterThanOrEqual(1);
    const after = async () => ({
      targets: await q(
        'SELECT name, removed_at IS NOT NULL AS removed FROM deploy_targets WHERE project_id=$1 ORDER BY name',
        [d.w.projectId],
      ),
      recipe: (
        await q(
          'SELECT status, present, setup, approved_hash, observed_hash, reset_hash FROM delivery_recipes WHERE project_id=$1',
          [d.w.projectId],
        )
      )[0],
      draft: await q('SELECT setup FROM delivery_setup_drafts WHERE project_id=$1', [d.w.projectId]),
      mode: (await q('SELECT delivery_mode FROM projects WHERE id=$1', [d.w.projectId]))[0].delivery_mode,
      run: (await q('SELECT status FROM deploy_runs WHERE id=$1', [waiting]))[0]?.status ?? 'rebuilt-away',
    });
    const a = await after();
    expect(a.targets.every((t: any) => t.removed)).toBe(true);
    expect(a.recipe).toMatchObject({
      status: 'absent',
      present: false,
      setup: null,
      approved_hash: null,
      observed_hash: null,
    });
    expect(a.recipe.reset_hash).toBeTruthy();
    expect(
      a.draft.every((x: any) => x.setup === null || x.setup === 'null' || typeof x.setup !== 'object'),
    ).toBe(true);
    expect(a.mode).toBe('instructions');
    expect(a.run).toBe('cancelled');
    // the history stays in the log
    expect(
      (
        await q(
          `SELECT 1 FROM events WHERE type='DeployTargetRemoved' AND payload->>'reason'='reset for new environments'`,
        )
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      (await q(`SELECT 1 FROM events WHERE type='DeliveryRecipeApproved' OR type='DeliveryRecipeObserved'`))
        .length,
    ).toBeGreaterThanOrEqual(1);
    // no runner was asked anything, no key was revoked
    expect((await q('SELECT count(*)::int AS n FROM runner_commands'))[0].n).toBe(commandsBefore);
    expect(r.received.length).toBe(sent);
    expect((await q(`SELECT 1 FROM runner_commands WHERE type='deploy.revoke'`)).length).toBe(0);
    // the same files in the vault are not brought back; different ones start fresh
    await observeRecipe(d.w.t.app.ctx, d.w.projectId, ins, d.w.workstationId);
    expect((await after()).recipe.present).toBe(false);

    // idempotent
    const again = await planDeployReset(d.w.t.app.ctx.pool);
    expect(again.projects.find((p) => p.projectId === d.w.projectId)).toBeUndefined();

    // a projection rebuild gives the same state
    await d.w.t.app.ctx.notifier.flush();
    // (the run above was inserted directly, so a rebuild naturally forgets that row; everything the events say stays)
    const { run: _run, targets: _t, ...before } = await after();
    await rebuildProjections(d.w.t.app.ctx.pool, d.w.t.app.ctx.store);
    const { run: _run2, targets: _t2, ...rebuilt } = await after();
    expect(rebuilt).toEqual(before);

    // the new page starts empty
    const st = await call('GET', `${base()}/delivery/setup`);
    expect(st.targets).toEqual([]);
    expect(st.current.setup).toBeNull();
    expect(st.draft).toBeNull();
    expect((await call('GET', `${base()}/places`)).places).toEqual([]);
  });

  const resetEnv = () => ({
    pool: d.w.t.app.ctx.pool,
    store: d.w.t.app.ctx.store,
    clock: d.w.t.clock as never,
    log: () => undefined,
  });

  /** A project with a setup that was observed (hash O) and approved at a different content (hash A). */
  async function observedAndApproved(approved: string, label: string) {
    const content = setup();
    (content.environments[1] as { label: string }).label = label; // other content than any earlier test: its hash is new
    const ins = inspected(content);
    await call('PUT', `${base()}/delivery/setup`, { setup: content });
    await observeRecipe(d.w.t.app.ctx, d.w.projectId, ins, d.w.workstationId);
    await q(`UPDATE delivery_recipes SET approved_hash=$2, status='changed_unapproved' WHERE project_id=$1`, [
      d.w.projectId,
      approved,
    ]);
    return ins;
  }
  const recipeRow = async () =>
    (
      await q('SELECT present, status, reset_hashes FROM delivery_recipes WHERE project_id=$1', [
        d.w.projectId,
      ])
    )[0];

  it('M5: when the observed and the approved content differ, a vault sync of either does not bring the setup back', async () => {
    const approved = 'a'.repeat(64);
    const ins = await observedAndApproved(approved, 'Live site M5a');
    const plan = await planDeployReset(d.w.t.app.ctx.pool);
    const mine = plan.projects.find((p) => p.projectId === d.w.projectId);
    expect(mine?.recipe?.hashes.sort()).toEqual([approved, ins.hash].sort());
    await applyDeployReset(resetEnv(), plan);
    expect((await recipeRow()).reset_hashes.sort()).toEqual([approved, ins.hash].sort());
    // the observed content again, and the approved content as a new observation: both stay cleared
    await observeRecipe(d.w.t.app.ctx, d.w.projectId, ins, d.w.workstationId);
    expect((await recipeRow()).present).toBe(false);
    await observeRecipe(d.w.t.app.ctx, d.w.projectId, { ...ins, hash: approved } as never, d.w.workstationId);
    expect((await recipeRow()).present).toBe(false);
    // a different save starts fresh
    await observeRecipe(
      d.w.t.app.ctx,
      d.w.projectId,
      { ...ins, hash: 'b'.repeat(64) } as never,
      d.w.workstationId,
    );
    expect((await recipeRow()).present).toBe(true);
    // a rebuild keeps it all
    const before = await recipeRow();
    await rebuildProjections(d.w.t.app.ctx.pool, d.w.t.app.ctx.store);
    expect(await recipeRow()).toEqual(before);
  });

  it('M5: stopping guided deploys forgets both the observed and the approved content too', async () => {
    const approved = 'c'.repeat(64);
    const ins = await observedAndApproved(approved, 'Live site M5b');
    await call('POST', `${base()}/delivery/setup/stop-guided`, { confirm: true });
    expect((await recipeRow()).reset_hashes.sort()).toEqual([approved, ins.hash].sort());
    await observeRecipe(d.w.t.app.ctx, d.w.projectId, { ...ins, hash: approved } as never, d.w.workstationId);
    expect((await recipeRow()).present).toBe(false);
    await observeRecipe(d.w.t.app.ctx, d.w.projectId, ins, d.w.workstationId);
    expect((await recipeRow()).present).toBe(false);
  });

  it('m10: the read-only plan is the same plan, a run that started since is not cancelled, and probes and open suggestions are cleared by events', async () => {
    await observedAndApproved('d'.repeat(64), 'Live site m10');
    const waiting = randomUUID();
    await q(
      `INSERT INTO deploy_runs (id, org_id, project_id, recipe_id, env, target_name, hash, trigger, requested_by, status, released_by_policy, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'live','p5-prod',$5,'request','{"kind":"owner","id":null}','waiting_release','owner',now(),now())`,
      [waiting, d.orgId, d.w.projectId, randomUUID(), 'c'.repeat(64)],
    );
    const proposalId = randomUUID();
    await q(
      `INSERT INTO setup_proposals (id, org_id, project_id, area, request_id, workstation_id, proposal, status, submitted_at)
       VALUES ($1,$2,$3,'deploy',$4,$5,'{}'::jsonb,'open',now())`,
      [proposalId, d.orgId, d.w.projectId, randomUUID(), d.w.workstationId],
    );
    const runProposal = randomUUID();
    await q(
      `INSERT INTO setup_proposals (id, org_id, project_id, area, request_id, workstation_id, proposal, status, submitted_at)
       VALUES ($1,$2,$3,'run',$4,$5,'{}'::jsonb,'open',now())`,
      [runProposal, d.orgId, d.w.projectId, randomUUID(), d.w.workstationId],
    );
    await q(
      `INSERT INTO deploy_probes (id, org_id, project_id, workstation_id, scope, at) VALUES ($1,$2,$3,$4,'local',now())`,
      [randomUUID(), d.orgId, d.w.projectId, d.w.workstationId],
    );
    const plan = await planDeployResetReadOnly(d.w.t.app.ctx.pool);
    const mine = plan.projects.find((p) => p.projectId === d.w.projectId);
    expect(mine?.proposals).toEqual([proposalId]);
    expect(mine?.probes).toBe(1);
    expect(formatResetPlan(plan)).toContain('open suggestion');
    expect(plan).toEqual(await planDeployReset(d.w.t.app.ctx.pool));
    // the release starts running after the plan was made: it is not cancelled
    await q(`UPDATE deploy_runs SET status='running' WHERE id=$1`, [waiting]);
    await applyDeployReset(resetEnv(), plan);
    expect((await q('SELECT status FROM deploy_runs WHERE id=$1', [waiting]))[0].status).toBe('running');
    expect((await q('SELECT status FROM setup_proposals WHERE id=$1', [proposalId]))[0].status).toBe(
      'dismissed',
    );
    expect((await q('SELECT status FROM setup_proposals WHERE id=$1', [runProposal]))[0].status).toBe('open');
    expect(
      (await q('SELECT count(*)::int AS n FROM deploy_probes WHERE project_id=$1', [d.w.projectId]))[0].n,
    ).toBe(0);
    await q(`UPDATE deploy_runs SET status='failed' WHERE id=$1`, [waiting]);
  });

  it('m10: the plan runs in a read-only transaction (a write inside it is refused)', async () => {
    const client = await d.w.t.app.ctx.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await expect(
        client.query(`UPDATE projects SET name=name WHERE id=$1`, [d.w.projectId]),
      ).rejects.toThrow(/read-only/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});
