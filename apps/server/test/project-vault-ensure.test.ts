import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { vaultForProject } from '../src/commands/vaults.ts';
import { migrateProjectVaults } from '../src/data-migrations/project-vaults.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_PROJECT_GRAPHS: 'true', AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

const owner =
  () =>
  (url: string, body?: unknown, method = 'POST') =>
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body === undefined ? {} : { body }) });
const vaultRows = () => q('SELECT * FROM vaults ORDER BY created_at');
const lastConfigure = (runner: FakeRunner) =>
  runner
    .of('command')
    .filter((c) => c.command === 'vault.configure')
    .at(-1)?.payload as any;

describe('every project has a vault (project-graphs design section 3)', () => {
  it('a project created before any workstation has an open request and no vault yet', async () => {
    expect(await vaultRows()).toEqual([]);
    const events = await q(
      `SELECT payload FROM events WHERE type='ProjectVaultEnsureRequested' AND payload->>'projectId'=$1`,
      [w.projectId],
    );
    // the world pairs its workstation after creating the project; the request was recorded by createProject
    expect(events).toHaveLength(1);
    expect(events[0]!.payload.reason).toBe('created');
  });

  it("the owner's runner connecting gets a local vault for the project, bound to it", async () => {
    r = await w.connectRunner();
    await until(async () => (await vaultRows()).length === 1, 4000, 'local vault');
    const [v] = await vaultRows();
    expect(v).toMatchObject({
      project_id: w.projectId,
      kind: 'project',
      storage: 'local',
      remote_url: '',
      local_workstation_id: w.workstationId,
    });
    await until(
      async () => lastConfigure(r)?.vaults?.some((x: any) => x.storage === 'local'),
      4000,
      'vault.configure with the local vault',
    );
    const cfg = lastConfigure(r).vaults.find((x: any) => x.storage === 'local');
    expect(cfg).toMatchObject({ vaultId: v!.id, kind: 'project', projectId: w.projectId, remoteUrl: '' });
    // reconnecting does not make a second one
    r.close();
    r = await w.connectRunner();
    await until(async () => lastConfigure(r)?.vaults?.length === 1, 4000, 'configure again');
    expect(await vaultRows()).toHaveLength(1);
  });

  it('a project created while a workstation exists gets its vault at once', async () => {
    const p = await ok<any>(owner()('/api/projects', { key: 'TWO', name: 'Two' }), 201);
    const rows = await q('SELECT * FROM vaults WHERE project_id=$1', [p.project.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ storage: 'local', local_workstation_id: w.workstationId });
    // the other workstations of the organization never get a local vault: it is configured on its own workstation only
    const dto = await ok<any>(owner()('/api/vaults', undefined, 'GET'));
    expect(dto.vaults.filter((v: any) => v.storage === 'local')).toHaveLength(2);
  });

  it('the project vault does not displace an organization vault that already holds the knowledge', async () => {
    const org = await ok<any>(
      owner()('/api/vaults', { kind: 'org', remoteUrl: 'git@example.test:me/org.git' }),
      201,
    );
    const row = await q('SELECT user_id FROM workstations WHERE id=$1', [w.workstationId]);
    const v = await vaultForProject(w.t.app.ctx.pool, w.projectId, row[0]!.user_id);
    expect(v).toMatchObject({ id: org.id, kind: 'org' });
  });

  it('a repository registered for the project turns its local vault into a synced one (same vault)', async () => {
    const [before] = await q('SELECT id FROM vaults WHERE project_id=$1', [w.projectId]);
    const res = await ok<any>(
      owner()('/api/vaults', {
        kind: 'project',
        projectId: w.projectId,
        remoteUrl: 'git@example.test:me/toy-vault.git',
      }),
      201,
    );
    expect(res.id).toBe(before!.id);
    const [after] = await q('SELECT * FROM vaults WHERE project_id=$1', [w.projectId]);
    expect(after).toMatchObject({
      id: before!.id,
      storage: 'git',
      remote_url: 'git@example.test:me/toy-vault.git',
      local_workstation_id: null,
    });
    // a second repository for a project that has one is refused
    const again = await owner()('/api/vaults', {
      kind: 'project',
      projectId: w.projectId,
      remoteUrl: 'git@example.test:x/y.git',
    });
    expect(again.body.error.code).toBe('vault_exists');
  });

  it('a local vault cannot be given a remote by editing it', async () => {
    const [two] = await q(`SELECT id FROM vaults WHERE storage='local' LIMIT 1`);
    const res = await owner()(`/api/vaults/${two!.id}`, { remoteUrl: 'git@example.test:a/b.git' }, 'PATCH');
    expect(res.status).toBe(409);
    expect((await owner()(`/api/vaults/${two!.id}`, { name: 'Renamed' }, 'PATCH')).status).toBe(200);
    const [row] = await q('SELECT name, storage, local_workstation_id FROM vaults WHERE id=$1', [two!.id]);
    expect(row).toMatchObject({ name: 'Renamed', storage: 'local', local_workstation_id: w.workstationId });
  });

  it('a local vault write is queued to its own workstation, without a push', async () => {
    const [two] = await q(`SELECT id FROM vaults WHERE storage='local' LIMIT 1`);
    const { enqueueVaultWrite } = await import('../src/commands/vaults.ts');
    const res = await enqueueVaultWrite(w.t.app.ctx, w.t.app.ctx.pool, two!.id, {
      path: 'projects/two/notes.md',
      mode: 'create',
      content: 'x\n',
      commitMessage: 'x',
    } as never);
    expect(res).toMatchObject({ queued: true, workstationId: w.workstationId });
    const [cmd] = await q(`SELECT payload FROM runner_commands WHERE id=$1`, [res.commandId]);
    expect(cmd!.payload.push).toBe(false);
  });

  it('survives a projection rebuild', async () => {
    const before = await vaultRows();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const after = await vaultRows();
    const pick = (rows: any[]) => rows.map((v) => [v.id, v.storage, v.local_workstation_id, v.remote_url]);
    expect(pick(after)).toEqual(pick(before));
  });
});

describe('data migration project-vaults-2026-10', () => {
  it('records the intent for projects without a vault, once, and only while the setting is on', async () => {
    // a project made with the feature off has no vault and no request
    const off = await q(`SELECT 1 FROM vaults v JOIN projects p ON p.id=v.project_id WHERE p.key='TWO'`);
    expect(off.length).toBeGreaterThan(0); // TWO has one (created with the feature on)
    await q(`DELETE FROM vaults WHERE project_id=(SELECT id FROM projects WHERE key='TWO')`);
    const env = {
      pool: w.t.app.ctx.pool,
      store: w.t.app.ctx.store,
      clock: w.t.clock,
      log: () => {},
    } as any;
    expect(await migrateProjectVaults({ ...env, projectGraphs: false })).toBeNull();
    const report = await migrateProjectVaults(env);
    expect(report).toEqual({ requested: ['TWO'] });
    expect(await migrateProjectVaults(env)).toBeNull();
    const reqs = await q(
      `SELECT payload FROM events WHERE type='ProjectVaultEnsureRequested' AND payload->>'reason'='migration'`,
    );
    expect(reqs).toHaveLength(1);
    // the owner's runner connecting answers it
    r.close();
    r = await w.connectRunner();
    await until(
      async () =>
        (await q(`SELECT 1 FROM vaults v JOIN projects p ON p.id=v.project_id WHERE p.key='TWO'`)).length ===
        1,
      4000,
      'vault for TWO',
    );
  });
});
