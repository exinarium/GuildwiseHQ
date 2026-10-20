import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateGraphBackfill } from '../src/data-migrations/graph-backfill.ts';
import { migrateProjectVaults } from '../src/data-migrations/project-vaults.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, until, type World } from './helpers/world.ts';

/**
 * A 0.1.31 runner rejects `vault.configure` with an empty `remoteUrl` (a local vault) and does not know the graph commands:
 * the server only creates, configures and indexes through a workstation that announced `local-vault:1`.
 */
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

const vaultRows = () => q('SELECT * FROM vaults');
const cmds = (runner: FakeRunner, ...names: string[]) =>
  runner.of('command').filter((c) => names.includes(c.command as string));
const env = () =>
  ({ pool: w.t.app.ctx.pool, store: w.t.app.ctx.store, clock: w.t.clock, log: () => {} }) as any;

describe('local-vault:1 capability', () => {
  it('a runner without it gets no local vault, no empty remoteUrl and no graph command; no failure is recorded', async () => {
    r = await w.connectRunner({ legacyVaults: true });
    await r.barrier();
    expect(await vaultRows()).toEqual([]);
    const conf = cmds(r, 'vault.configure');
    expect(conf.length).toBeGreaterThan(0);
    for (const c of conf) for (const v of (c.payload as any).vaults) expect(v.remoteUrl).not.toBe('');
    expect(cmds(r, 'graph.index', 'graph.update', 'graph.org')).toEqual([]);
    expect(await q(`SELECT 1 FROM events WHERE type='ProjectGraphFailed'`)).toEqual([]);
    expect(await q(`SELECT 1 FROM runner_commands WHERE type LIKE 'graph.%'`)).toEqual([]);
  });

  it('the data migrations leave their requests pending while no capable runner is connected', async () => {
    expect(await migrateProjectVaults(env())).toMatchObject({ requested: expect.any(Array) });
    expect(await migrateGraphBackfill(env())).not.toBeNull();
    expect(await vaultRows()).toEqual([]);
    expect(await q(`SELECT 1 FROM runner_commands WHERE type LIKE 'graph.%'`)).toEqual([]);
    r.close();
    r = await w.connectRunner({ legacyVaults: true });
    await r.barrier();
    expect(await vaultRows()).toEqual([]);
    expect(await q(`SELECT 1 FROM runner_commands WHERE type LIKE 'graph.%'`)).toEqual([]);
    expect(await q(`SELECT 1 FROM events WHERE type='ProjectGraphFailed'`)).toEqual([]);
  });

  it('a capable runner connecting makes the vault, configures it and is asked to index', async () => {
    r.close();
    r = await w.connectRunner();
    await until(async () => (await vaultRows()).length === 1, 4000, 'local vault');
    await until(
      async () => cmds(r, 'graph.index').length === 1,
      4000,
      'graph.index sent to the capable runner',
    );
    const last = cmds(r, 'vault.configure').at(-1)!.payload as any;
    expect(last.vaults.some((v: any) => v.storage === 'local' && v.remoteUrl === '')).toBe(true);
  });

  it('the same workstation reconnecting as a legacy runner no longer gets the local vault', async () => {
    r.close();
    r = await w.connectRunner({ legacyVaults: true });
    await r.barrier();
    const last = cmds(r, 'vault.configure').at(-1)!.payload as any;
    expect(last.vaults).toEqual([]);
    expect(
      await q(`SELECT 1 FROM runner_commands WHERE type LIKE 'graph.%' AND status IN ('pending','sent')`),
    ).toEqual([]);
  });
});
