import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** Agent toolchains: the workstation's report, shown to its owner only, and the owner's "remove". */
let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld();
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const DOTNET = {
  name: 'dotnet',
  source: 'detected',
  version: '8.0.425, 10.0.401 (~/.dotnet)',
  binDirs: ['/home/me/.dotnet'],
  readDirs: ['/home/me/.dotnet'],
  envKeys: ['DOTNET_ROOT'],
};
const ZIG = {
  name: 'zig',
  source: 'devops',
  binDirs: ['/home/me/.local/zig'],
  readDirs: [],
  envKeys: [],
  addedAt: '2026-10-13T10:00:00.000Z',
  addedBy: 'devops',
};
const workstation = async (cookie = w.owner.cookie) =>
  (await ok<any>(w.t.req('GET', '/api/workstations', { cookie }))).workstations.find(
    (x: any) => x.id === w.workstationId,
  );

describe('agent toolchains', () => {
  it('stores the report and shows it to the owner, with the report time', async () => {
    r.send('toolchains.report', { toolchains: [DOTNET, ZIG] });
    await until(async () => (await workstation()).toolchains?.items.length === 2, 3000, 'report stored');
    const t = (await workstation()).toolchains;
    expect(t.items.map((i: any) => i.name)).toEqual(['dotnet', 'zig']);
    expect(t.checkedAt).toBeTruthy();
  });

  it('survives a projection rebuild', async () => {
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect((await workstation()).toolchains?.items).toHaveLength(2);
  });

  it('only the owner can remove: others get 404 and nothing is queued', async () => {
    const other = await w.t.userSession(uniqueEmail('other'));
    const res = await w.t.req('POST', `/api/workstations/${w.workstationId}/toolchains/remove`, {
      cookie: other.cookie,
      body: { name: 'zig' },
    });
    expect(res.status).toBe(404);
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='toolchain.remove'`)).toHaveLength(0);
  });

  it('the owner queues toolchain.remove for the runner', async () => {
    const from = r.received.length;
    const res = await w.t.req('POST', `/api/workstations/${w.workstationId}/toolchains/remove`, {
      cookie: w.owner.cookie,
      body: { name: 'zig' },
    });
    expect(res.status).toBe(202);
    const cmd = await r.waitFor('command', (c) => c.command === 'toolchain.remove', 5000, from);
    expect(cmd.payload).toEqual({ name: 'zig' });
    r.send('command.result', { commandId: cmd.commandId, ok: true, result: { removed: true } });
    r.send('toolchains.report', { toolchains: [DOTNET] });
    await until(async () => (await workstation()).toolchains?.items.length === 1, 3000, 'report updated');
  });
});
