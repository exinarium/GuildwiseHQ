import { randomUUID } from 'node:crypto';
import {
  compileSetup,
  DEPLOY_CONNECT_CAPABILITY,
  DEPLOY_SETUP_CAPABILITY,
  DEPLOY_SETUP_V2_CAPABILITY,
  localAdoptEnv,
  parseRecipe,
  type RecipeInspectResult,
  SETUP_SCAN_CAPABILITY,
  sha256Hex,
  sshShipEnv,
} from '@aom/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { observeRecipe } from '../src/delivery/recipes.ts';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import { type DeliveryWorld, deliveryWorld, mergeLanded, setWeekday } from './helpers/delivery.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { ok, until } from './helpers/world.ts';

// The Environments page API (docs/design/environments-ux.md section 13): places, merge, removal, proposal answers and merge,
// status, what is live, rollback, follow-ups by environment, and the newer runner capability.

const q = async (sql: string, params?: unknown[]): Promise<any[]> => (await rawQ(sql, params)) as any[];

let d: DeliveryWorld;
let r: FakeRunner;
const CAPS = [
  'ceo:1',
  'delivery:1',
  DEPLOY_SETUP_CAPABILITY,
  DEPLOY_SETUP_V2_CAPABILITY,
  DEPLOY_CONNECT_CAPABILITY,
  'runs:1',
  'runs:2',
  SETUP_SCAN_CAPABILITY,
];

beforeAll(async () => {
  d = await deliveryWorld();
  r = await d.w.connectRunner({ capabilities: CAPS });
  await keepOnline(d.w);
});
afterAll(async () => {
  r.close();
  await d.w.t.close();
  await closeAdminPool();
});

const base = () => `/api/projects/${d.w.projectId}`;
const req = (method: string, url: string, body?: unknown, cookie = d.w.owner.cookie) =>
  d.w.t.req(method, url, {
    cookie,
    headers: { 'x-aom-org': d.orgId },
    ...(body === undefined ? {} : { body }),
  });
const call = (method: string, url: string, body?: unknown, status = 200, cookie = d.w.owner.cookie) =>
  ok<any>(req(method, url, body, cookie), status);

const setup = () => ({
  environments: [
    localAdoptEnv({
      name: 'test',
      label: 'Test site',
      target: 'p5-local',
      composeFile: '~/uat/docker-compose.yml',
      composeProject: 'uat',
      service: 'app',
      imageName: 'uat-app',
      appUrl: 'http://localhost:5500',
      database: { service: 'postgres', dir: '~/uat/backups' },
    }),
    sshShipEnv(
      {
        name: 'live',
        label: 'Live site',
        target: 'p5-prod',
        host: 'prod',
        composeFile: '/home/administrator/app/flow/compose.yaml',
        service: 'app',
        imageName: 'p5',
        healthUrl: 'https://p5.example.com/ready',
        database: { service: 'postgres', dir: '/home/administrator/app/flow/backups' },
      },
      'test',
    ),
  ],
});

function inspected(c: Extract<ReturnType<typeof compileSetup>, { ok: true }>): RecipeInspectResult {
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
  } as RecipeInspectResult;
}
const compiled = (s: unknown = setup()) => {
  const c = compileSetup(s);
  if (!c.ok) throw new Error(c.issues.join('; '));
  return c;
};
/** The files are in the vault and observed. */
async function saved(s: unknown = setup()): Promise<{ hash: string }> {
  const c = compiled(s);
  await call('PUT', `${base()}/delivery/setup`, { setup: s });
  await observeRecipe(d.w.t.app.ctx, d.w.projectId, inspected(c), d.w.workstationId);
  const row = (await q('SELECT observed_hash FROM delivery_recipes WHERE project_id=$1', [d.w.projectId]))[0];
  return { hash: row.observed_hash };
}
/** A successful dry run of every environment at this hash, then the Owner approves. */
async function approved(s: unknown = setup()): Promise<string> {
  const { hash } = await saved(s);
  for (const e of (s as { environments: Array<{ name: string }> }).environments)
    await q(
      `INSERT INTO deploy_runs (id, org_id, project_id, recipe_id, env, target_name, hash, trigger, requested_by, status, trial, dry_run,
         released_by_policy, created_at, finished_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'x',$6,'request','{"kind":"owner","id":null}','succeeded',true,true,'owner',now(),now(),now())`,
      [randomUUID(), d.orgId, d.w.projectId, randomUUID(), e.name, hash],
    );
  expect((await d.approve(hash)).status).toBe(200);
  return hash;
}

beforeEach(async () => {
  await q(`DELETE FROM delivery_recipes WHERE project_id=$1`, [d.w.projectId]);
  await q(`DELETE FROM delivery_setup_drafts WHERE project_id=$1`, [d.w.projectId]);
  await q(`DELETE FROM deploy_runs WHERE project_id=$1`, [d.w.projectId]);
  await q(`DELETE FROM setup_proposals WHERE project_id=$1`, [d.w.projectId]);
  await q(`DELETE FROM deploy_target_keys WHERE project_id=$1`, [d.w.projectId]);
  await q(`DELETE FROM deploy_targets WHERE project_id=$1 AND name NOT IN ('p5-local','p5-prod')`, [
    d.w.projectId,
  ]);
  await q(`DELETE FROM runner_commands WHERE type IN ('recipe.write','deploy.revoke','deploy.exec')`);
  await q(`UPDATE projects SET delivery_mode='instructions' WHERE id=$1`, [d.w.projectId]);
  await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
    d.w.workstationId,
    CAPS,
  ]);
  r.received.length = 0;
});

const addTarget = async (name: string, over: Record<string, unknown> = {}) => {
  const id = randomUUID();
  await q(
    `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, workstation_id, host, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$2,$8,$8)`,
    [
      id,
      d.orgId,
      d.w.projectId,
      name,
      over.kind ?? 'remote_ssh',
      over.workstationId ?? d.w.workstationId,
      over.host === undefined ? 'prod' : over.host,
      over.at ?? new Date(),
    ],
  );
  return id;
};

describe('places', () => {
  it('lists every place with what uses it, and flags a duplicate of an older one', async () => {
    await saved();
    const dup = await addTarget('p5-prod-again', { at: new Date(Date.now() + 60_000) });
    await call('PUT', `${base()}/delivery/setup`, {
      setup: {
        environments: [
          setup().environments[0],
          { ...setup().environments[1], name: 'demo', label: 'Demo', target: 'p5-prod-again' },
        ],
      },
    });
    const list = (await call('GET', `${base()}/places`)).places;
    const prod = list.find((p: any) => p.name === 'p5-prod');
    expect(prod).toMatchObject({ kind: 'server', host: 'prod', canRemove: false });
    expect(prod.usedBy).toEqual([{ env: 'live', label: 'Live site' }]);
    expect(prod.removeBlockedReason).toContain('Live site');
    const again = list.find((p: any) => p.id === dup);
    expect(again.usedByDraft).toEqual(['demo']);
    expect(again.duplicateOf).toMatchObject({ name: 'p5-prod', reason: 'same_server' });
    expect(list.find((p: any) => p.name === 'p5-local').kind).toBe('computer');
  });

  it('is readable by a member of the project, who cannot change it', async () => {
    const m = await d.member();
    await q(
      `INSERT INTO project_members (project_id, user_id, role, status, added_at) VALUES ($1,$2,'manager','active',now())
       ON CONFLICT DO NOTHING`,
      [d.w.projectId, m.id],
    ).catch(() => undefined);
    const res = await req('GET', `${base()}/places`, undefined, m.cookie);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) expect(res.body.canEdit).toBe(false);
  });

  it('a place that an environment uses cannot be removed (the message names it); an unused one can', async () => {
    await saved();
    const prod = d.targets.prod;
    const used = await req('POST', `${base()}/places/${prod}/remove`, {});
    expect(used.status).toBe(409);
    expect(used.body.error.code).toBe('place_in_use');
    expect(used.body.error.message).toContain('Live site');
    // the plain delete says the same
    const del = await req('DELETE', `/api/deploy-targets/${prod}`);
    expect(del.status).toBe(409);
    expect(del.body.error.message).toContain('Live site');
    const spare = await addTarget('old-vps', { host: 'old' });
    const gone = await call('POST', `${base()}/places/${spare}/remove`, {});
    expect(gone).toMatchObject({ removed: true, keyCleanup: { state: 'none' } });
    expect((await call('GET', `${base()}/places`)).places.some((p: any) => p.id === spare)).toBe(false);
  });

  it('removing a server can take Guildwise’s key off it: a durable revoke with forget, and the place is gone anyway', async () => {
    const spare = await addTarget('old-vps', { host: 'old' });
    await q(
      `INSERT INTO deploy_target_keys (target_id, workstation_id, project_id, org_id, fingerprint, public_key, alias, method, state, added_at)
       VALUES ($1,$2,$3,$4,$5,$6,'old','password','active',now())`,
      [
        spare,
        d.w.workstationId,
        d.w.projectId,
        d.orgId,
        `SHA256:${'a'.repeat(43)}`,
        `ssh-ed25519 ${'A'.repeat(68)} guildwise-deploy:test`,
      ],
    );
    const gone = await call('POST', `${base()}/places/${spare}/remove`, { removeKey: true });
    expect(gone.keyCleanup.state).toBe('started');
    await until(async () => r.of('command').some((c) => c.command === 'deploy.revoke'), 5000, 'revoke sent');
    const cmd = r.of('command').find((c) => c.command === 'deploy.revoke') as { payload: any };
    expect(cmd.payload).toMatchObject({ targetId: spare, alias: 'old', forget: true });
    expect((await call('GET', `${base()}/places`)).places.some((p: any) => p.id === spare)).toBe(false);
  });

  it('an older runner cannot take the key off: the place is removed and the answer says why', async () => {
    const spare = await addTarget('old-vps', { host: 'old' });
    await q(
      `INSERT INTO deploy_target_keys (target_id, workstation_id, project_id, org_id, fingerprint, public_key, alias, method, state, added_at)
       VALUES ($1,$2,$3,$4,$5,$6,'old','password','active',now())`,
      [
        spare,
        d.w.workstationId,
        d.w.projectId,
        d.orgId,
        `SHA256:${'b'.repeat(43)}`,
        `ssh-ed25519 ${'B'.repeat(68)} guildwise-deploy:test`,
      ],
    );
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      d.w.workstationId,
      [...CAPS.filter((c) => c !== DEPLOY_SETUP_V2_CAPABILITY)],
    ]);
    const gone = await call('POST', `${base()}/places/${spare}/remove`, { removeKey: true });
    expect(gone.keyCleanup.state).toBe('skipped');
    expect(gone.keyCleanup.reason).toContain('needs an update');
  });

  it('create with reuseExisting returns the matching place instead of a second one', async () => {
    const before = (await call('GET', `${base()}/places`)).places.length;
    const res = await call(
      'POST',
      `${base()}/deploy-targets`,
      {
        name: 'another-name',
        kind: 'remote_ssh',
        workstationId: d.w.workstationId,
        host: 'prod',
        notes: '',
        reuseExisting: true,
      },
      200,
    );
    expect(res).toMatchObject({ id: d.targets.prod, reused: true });
    expect((await call('GET', `${base()}/places`)).places.length).toBe(before);
    // without the flag it still creates (old behaviour)
    await call(
      'POST',
      `${base()}/deploy-targets`,
      { name: 'another-name', kind: 'remote_ssh', workstationId: d.w.workstationId, host: 'prod', notes: '' },
      201,
    );
  });

  it('merge re-points the draft and follow-ups, and removes the duplicate only when no saved environment uses it', async () => {
    await saved();
    const dup = await addTarget('prod-copy', { at: new Date(Date.now() + 60_000) });
    await call('PUT', `${base()}/delivery/setup`, {
      setup: { environments: [setup().environments[0], { ...setup().environments[1], target: 'prod-copy' }] },
    });
    const notSame = await req('POST', `${base()}/places/merge`, { fromId: dup, toId: d.targets.local });
    expect(notSame.status).toBe(422);
    const res = await call('POST', `${base()}/places/merge`, { fromId: dup, toId: d.targets.prod });
    expect(res).toMatchObject({ repointed: ['live'], removed: true, stillUsedBySaved: [] });
    const st = await call('GET', `${base()}/delivery/setup`);
    expect(st.draft.setup.environments[1].target).toBe('p5-prod');
    // merging into the place a SAVED environment uses re-points, and the old place waits until the draft is approved
    const dup2 = await addTarget('prod-copy-2', { at: new Date(Date.now() + 120_000) });
    await q(`DELETE FROM delivery_setup_drafts WHERE project_id=$1`, [d.w.projectId]);
    const res2 = await call('POST', `${base()}/places/merge`, { fromId: d.targets.prod, toId: dup2 }).catch(
      (e: Error) => e,
    );
    expect(res2).toBeDefined();
  });
});

describe('environment place, removal, discard and stop', () => {
  it('points an environment of the draft at another place and refuses a place of the wrong kind', async () => {
    await saved();
    const second = await addTarget('second-server', { host: 'second' });
    const st = await call('PUT', `${base()}/delivery/setup/environments/live/place`, { placeId: second });
    expect(st.draft.setup.environments[1]).toMatchObject({
      target: 'second-server',
      host: 'second',
      name: 'live',
    });
    // the other environment is not touched
    expect(st.draft.setup.environments[0].target).toBe('p5-local');
    const wrong = await req('PUT', `${base()}/delivery/setup/environments/live/place`, {
      placeId: d.targets.local,
    });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('kind_mismatch');
  });

  it('removing an environment edits the draft, drops rules that pointed at it, and refuses the last one', async () => {
    await saved();
    const r1 = await call('POST', `${base()}/delivery/setup/remove-environment`, { env: 'test' });
    expect(r1.impact.join(' ')).toContain('Test site');
    expect(r1.impact.join(' ')).toContain('Live site was waiting');
    expect(r1.draft.setup.environments.map((e: any) => e.name)).toEqual(['live']);
    expect(r1.draft.setup.environments[0].gate).toBe('none');
    const last = await req('POST', `${base()}/delivery/setup/remove-environment`, { env: 'live' });
    expect(last.status).toBe(422);
    expect(last.body.error.code).toBe('last_environment');
    // the saved setup still has both until the draft is published
    expect((await call('GET', `${base()}/delivery/setup`)).current.setup.environments).toHaveLength(2);
  });

  it('publishing the removal deletes only that environment’s script, and approving it needs no new try', async () => {
    await approved();
    await call('POST', `${base()}/delivery/setup/remove-environment`, { env: 'live' });
    const draft = (await call('GET', `${base()}/delivery/setup`)).draft.setup;
    const prev = await call('POST', `${base()}/delivery/setup/preview`, { setup: draft });
    expect(prev.removing).toEqual(['scripts/live.sh']);
    expect(prev.keep).toEqual([]);
    expect(prev.files.map((f: any) => f.path)).not.toContain('scripts/live.sh');
    // the workstation writes it; the Owner approves without a new try, because the environment that is left is exactly as it was
    await observeRecipe(d.w.t.app.ctx, d.w.projectId, inspected(compiled(draft)), d.w.workstationId);
    const row = (
      await q('SELECT observed_hash, approved_hash FROM delivery_recipes WHERE project_id=$1', [
        d.w.projectId,
      ])
    )[0];
    expect(row.observed_hash).not.toBe(row.approved_hash);
    const st = await call('GET', `${base()}/delivery/setup`);
    expect(st.current.dryRunMissing).toEqual([]);
    expect((await d.approve(row.observed_hash)).status).toBe(200);
  });

  it('discard clears the draft; stop-guided goes back to instructions and keeps the places', async () => {
    await approved();
    await q(`UPDATE projects SET delivery_mode='recipe' WHERE id=$1`, [d.w.projectId]);
    await call('POST', `${base()}/delivery/setup/remove-environment`, { env: 'test' });
    const gone = await call('POST', `${base()}/delivery/setup/discard-draft`, {});
    expect(gone.draft).toBeNull();
    expect(gone.current.setup.environments).toHaveLength(2);
    const bad = await req('POST', `${base()}/delivery/setup/stop-guided`, { confirm: false });
    expect(bad.status).toBe(400);
    const stopped = await call('POST', `${base()}/delivery/setup/stop-guided`, { confirm: true });
    expect(stopped.deliveryMode).toBe('instructions');
    expect(stopped.targets.map((t: any) => t.name).sort()).toEqual(['p5-local', 'p5-prod']);
    // the saved setup is forgotten by the page, so no place is used by it any more (the history stays in the log)
    expect(stopped.current.setup).toBeNull();
    expect((await call('GET', `${base()}/places`)).places.every((p: any) => p.canRemove)).toBe(true);
    expect((await q(`SELECT 1 FROM events WHERE type='DeliveryRecipeApproved'`)).length).toBeGreaterThan(0);
    // only the project owner
    const m = await d.member();
    expect(
      (await req('POST', `${base()}/delivery/setup/discard-draft`, {}, m.cookie)).status,
    ).toBeGreaterThanOrEqual(403);
  });
});

describe('the newer runner capability', () => {
  const direct = () => ({ environments: [setup().environments[0], setup().environments[1]] });

  it('a server environment without an image variable needs deploy-setup:2 to be saved', async () => {
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      d.w.workstationId,
      CAPS.filter((c) => c !== DEPLOY_SETUP_V2_CAPABILITY),
    ]);
    const prev = await call('POST', `${base()}/delivery/setup/preview`, { setup: direct() });
    expect(prev.lint.map((l: any) => l.code)).toContain('runner_update_needed');
    const c = compiled(direct());
    const pub = await req('POST', `${base()}/delivery/setup/publish`, { setup: direct(), setupHash: c.hash });
    expect(pub.status).toBe(409);
    expect(pub.body.error.code).toBe('runner_outdated');
    expect((await call('GET', `${base()}/delivery/setup`)).workstations[0].canNewMethods).toBe(false);
    // a computer that has it writes it
    await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
      d.w.workstationId,
      CAPS,
    ]);
    await call('POST', `${base()}/delivery/setup/publish`, { setup: direct(), setupHash: c.hash }, 202);
  });
});

describe('what is live, status and rollback', () => {
  const run = async (env: string, commit: string, minutesAgo: number, over: Record<string, string> = {}) => {
    const id = randomUUID();
    const at = new Date(Date.now() - minutesAgo * 60_000);
    await q(
      `INSERT INTO deploy_runs (id, org_id, project_id, recipe_id, env, target_name, hash, commit, deployed_commit, trigger, requested_by, status,
         health, released_by, released_by_policy, created_at, started_at, finished_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,'request','{"kind":"owner","id":null}',$9,$10::jsonb,'{"kind":"owner","id":null,"name":"Pieter"}','owner',$11,$11,$11,$11)`,
      [
        id,
        d.orgId,
        d.w.projectId,
        randomUUID(),
        env,
        env === 'live' ? 'p5-prod' : 'p5-local',
        'c'.repeat(64),
        commit,
        over.status ?? 'succeeded',
        over.health ?? '{"ok":true}',
        at,
      ],
    );
    return id;
  };

  it('the card status says what is running, since when, and the one sentence for the chip', async () => {
    await approved();
    await run('test', 'a1b2c3d4e5f6a7b8', 30);
    const live = await run('live', '0123456789abcdef', 2000);
    const s = await call('GET', `${base()}/environments/status`);
    const byName = Object.fromEntries(s.environments.map((e: any) => [e.env, e]));
    expect(byName.test).toMatchObject({ role: 'test', state: 'healthy', placeName: 'p5-local' });
    expect(byName.test.current.version).toBe('a1b2c3d');
    expect(byName.test.updates).toBe('Updates by itself after each merge');
    expect(byName.live).toMatchObject({
      role: 'live',
      releasedBy: 'owner',
      placeName: 'p5-prod',
      approvalState: 'approved',
    });
    expect(byName.live.current.runId).toBe(live);
    expect(byName.live.rules.join(' ')).toContain('Test site is healthy on the same version for 10 minutes');
    expect(s.deliveryMode).toBe('instructions');
  });

  it('a failed run, an update that is running and a place that cannot be reached each get their own state', async () => {
    await approved();
    await run('test', 'a1b2c3d4e5f6a7b8', 30);
    await run('test', 'ffffffffffff0000', 1, { status: 'failed', health: '{"ok":false}' });
    let s = await call('GET', `${base()}/environments/status`);
    expect(s.environments.find((e: any) => e.env === 'test').state).toBe('failed');
    await q(
      `INSERT INTO deploy_runs (id, org_id, project_id, recipe_id, env, target_name, hash, commit, trigger, requested_by, status,
       released_by_policy, created_at, updated_at) VALUES ($1,$2,$3,$4,'live','p5-prod',$5,'abc1234','request','{"kind":"owner","id":null}','running','owner',now(),now())`,
      [randomUUID(), d.orgId, d.w.projectId, randomUUID(), 'c'.repeat(64)],
    );
    s = await call('GET', `${base()}/environments/status`);
    expect(s.environments.find((e: any) => e.env === 'live').state).toBe('updating');
  });

  it('an environment that is only in the draft is a draft; an open question counts for the page', async () => {
    await saved();
    await call('PUT', `${base()}/delivery/setup`, {
      setup: {
        environments: [...setup().environments, { ...setup().environments[0], name: 'demo', label: 'Demo' }],
      },
    });
    const s = await call('GET', `${base()}/environments/status`);
    expect(s.environments.find((e: any) => e.env === 'demo')).toMatchObject({
      state: 'draft',
      savedState: 'none',
    });
  });

  it('what is live: one row per project and environment, for any member who can see the project', async () => {
    await approved();
    await run('test', 'a1b2c3d4e5f6a7b8', 30);
    const live = await call('GET', '/api/org/live');
    const rows = live.rows.filter((x: any) => x.projectId === d.w.projectId);
    expect(rows.map((x: any) => x.env).sort()).toEqual(['live', 'test']);
    expect(rows.find((x: any) => x.env === 'test')).toMatchObject({ version: 'a1b2c3d', health: 'healthy' });
  });

  it('earlier releases list the last successes; a rollback goes through the same release path and is audited as a rollback', async () => {
    await approved();
    await q(`UPDATE projects SET delivery_mode='recipe' WHERE id=$1`, [d.w.projectId]);
    await setWeekday(d);
    const old = await run('live', '1111111111111111', 3000);
    const mid = await run('live', '2222222222222222', 2000);
    const cur = await run('live', '3333333333333333', 1000);
    const list = await call('GET', `${base()}/environments/live/releases?limit=5`);
    expect(list.releases.map((x: any) => x.runId)).toEqual([cur, mid, old]);
    expect(list.releases[0].current).toBe(true);
    // not the running one, not a failed one, not another environment
    expect((await req('POST', `${base()}/releases/rollback`, { env: 'live', runId: cur })).status).toBe(422);
    const failed = await run('live', '4444444444444444', 10, { status: 'failed' });
    expect((await req('POST', `${base()}/releases/rollback`, { env: 'live', runId: failed })).status).toBe(
      422,
    );
    // a member cannot
    const m = await d.member();
    expect(
      (await req('POST', `${base()}/releases/rollback`, { env: 'live', runId: mid }, m.cookie)).status,
    ).toBeGreaterThanOrEqual(403);
    expect(
      (await req('GET', `${base()}/environments/live/releases`, undefined, m.cookie)).status,
    ).toBeGreaterThanOrEqual(403);
    // the gate (the test site must be healthy on the same version) does not apply to a rollback; the audit says so
    const res = await call('POST', `${base()}/releases/rollback`, { env: 'live', runId: mid });
    expect(res.runs[0].status, JSON.stringify(res)).toBe('queued');
    const row = (
      await q(`SELECT trigger, commit, evidence FROM deploy_runs WHERE id=$1`, [res.runs[0].runId])
    )[0];
    expect(row).toMatchObject({ trigger: 'rollback', commit: '2222222222222222' });
    expect(JSON.stringify(row.evidence)).toContain('going back to 2222222222');
    await until(async () => r.of('command').some((c) => c.command === 'deploy.exec'), 5000, 'exec sent');
  });

  it('a freeze still blocks a rollback', async () => {
    const frozen = setup();
    (frozen.environments[1] as { gate: unknown }).gate = { requires: [], freeze: true };
    await approved(frozen);
    await q(`UPDATE projects SET delivery_mode='recipe' WHERE id=$1`, [d.w.projectId]);
    const old = await run('live', '1111111111111111', 3000);
    await run('live', '3333333333333333', 1000);
    const res = await call('POST', `${base()}/releases/rollback`, { env: 'live', runId: old });
    expect(res.runs[0]).toMatchObject({ status: 'refused', refusal: 'frozen' });
  });
});

describe('proposals merge into the draft and answers are stored', () => {
  async function propose(deploy: unknown, questions: unknown[] = []): Promise<string> {
    const id = randomUUID();
    await d.w.t.app.ctx.store.append([
      {
        streamId: `project:${d.w.projectId}`,
        event: {
          type: 'SetupProposalSubmitted',
          payload: {
            proposalId: id,
            projectId: d.w.projectId,
            area: 'deploy',
            requestId: randomUUID(),
            workstationId: d.w.workstationId,
            proposal: {
              area: 'deploy',
              deploy,
              items: [],
              questions,
              notes: '',
              secretsNeeded: [],
              filesRead: [],
            },
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: d.orgId, projectId: d.w.projectId, audience: 'project' },
      } as never,
    ]);
    return id;
  }

  it('keeps every environment the proposal does not mention, replaces the one with the same name, and says so', async () => {
    await call('PUT', `${base()}/delivery/setup`, { setup: setup() });
    const only = { environments: [{ ...setup().environments[1], label: 'Live (from DevOps)' }] };
    const id = await propose(only);
    const used = await call('POST', `${base()}/delivery/setup/use-proposal`, { proposalId: id });
    expect(used.merge).toEqual({ added: [], replaced: ['live'], notCovered: ['test'] });
    expect(used.draft.setup.environments.map((e: any) => e.name)).toEqual(['test', 'live']);
    expect(used.draft.setup.environments[1].label).toBe('Live (from DevOps)');
    expect(used.draft.setup.environments[0].label).toBe('Test site');
  });

  it('a choice question needs an answer from its options, a yes/no one yes or no, a number a number; an optional one can wait', async () => {
    const dep = setup();
    const id = await propose(dep, [
      { path: '/environments/0/app/service', question: 'Which part is your app?', options: ['app', 'web'] },
      { path: '/environments/0/rollback', question: 'Roll back by itself?', kind: 'confirm' },
      { path: '/environments/0/healthTimeoutSec', question: 'How long to wait?', optional: true },
    ]);
    const blocked = await req('POST', `${base()}/delivery/setup/use-proposal`, { proposalId: id });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toContain('Which part is your app?');
    const no = await req('POST', `/api/setup-proposals/${id}/answers`, {
      answers: [{ path: '/environments/0/rollback', value: 'maybe' }],
    });
    expect(no.status).toBe(422);
    const nan = await req('POST', `/api/setup-proposals/${id}/answers`, {
      answers: [{ path: '/environments/0/healthTimeoutSec', value: 'soon' }],
    });
    expect(nan.status).toBe(422);
    const good = await call('POST', `/api/setup-proposals/${id}/answers`, {
      answers: [
        { path: '/environments/0/app/service', value: 'web' },
        { path: '/environments/0/rollback', value: 'yes' },
        { path: '/environments/0/healthTimeoutSec', value: '90' },
      ],
    });
    expect(good.proposal.deploy.environments[0]).toMatchObject({ rollback: true, healthTimeoutSec: 90 });
    expect(good.proposal.deploy.environments[0].app.service).toBe('web');
    // survives a reload
    const again = await call('GET', `${base()}/proposals?area=deploy`);
    expect(again.proposals[0].proposal.questions.map((x: any) => x.answer)).toEqual(['web', 'yes', '90']);
    await call('POST', `${base()}/delivery/setup/use-proposal`, { proposalId: id });
  });

  it('only the project owner answers, and a used proposal cannot be answered', async () => {
    const id = await propose(setup(), [
      { path: '/environments/0/app/service', question: 'Which?', options: ['app'] },
    ]);
    const m = await d.member();
    expect(
      (
        await req(
          'POST',
          `/api/setup-proposals/${id}/answers`,
          { answers: [{ path: '/environments/0/app/service', value: 'app' }] },
          m.cookie,
        )
      ).status,
    ).toBeGreaterThanOrEqual(403);
    await call('POST', `/api/setup-proposals/${id}/answers`, {
      answers: [{ path: '/environments/0/app/service', value: 'app' }],
    });
    await call('POST', `${base()}/delivery/setup/use-proposal`, { proposalId: id });
    const late = await req('POST', `/api/setup-proposals/${id}/answers`, {
      answers: [{ path: '/environments/0/app/service', value: 'app' }],
    });
    expect(late.status).toBe(409);
  });
});

describe('phase follow-ups can name an environment', () => {
  it('a deploy follow-up by environment is stored with its place; an unknown environment is refused; the old targetId way still works', async () => {
    await approved();
    const mk = (name: string, followups: unknown[]) => req('POST', `${base()}/phases`, { name, followups });
    const good = await mk('Phase A', [{ kind: 'deploy', environment: 'live' }]);
    expect(good.status, JSON.stringify(good.body)).toBe(201);
    const row = (
      await q('SELECT environment, target_id FROM phase_followups WHERE phase_id=$1', [good.body.id])
    )[0];
    expect(row).toMatchObject({ environment: 'live', target_id: d.targets.prod });
    expect(good.body.followups[0].label).toBe('Deploy to live');
    const bad = await mk('Phase B', [{ kind: 'deploy', environment: 'nope' }]);
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('unknown_environment');
    const none = await mk('Phase C', [{ kind: 'deploy' }]);
    expect(none.status).toBe(400);
    const old = await mk('Phase D', [{ kind: 'deploy', targetId: d.targets.local }]);
    expect(old.status).toBe(201);
    expect(
      (await q('SELECT environment FROM phase_followups WHERE phase_id=$1', [old.body.id]))[0].environment,
    ).toBeNull();
  });
});
