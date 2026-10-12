import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let orgId: string;
beforeAll(async () => {
  w = await createWorld();
  r = await w.connectRunner();
  orgId = (
    await q('SELECT org_id FROM org_members WHERE user_id=$1 AND status=$2', [w.owner.id, 'active'])
  )[0]?.org_id;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const put = (cookie: string, workstationId: string, body: unknown) =>
  w.t.req('PUT', `/api/workstations/${workstationId}/org-folder`, { cookie, body });
const workstation = async (cookie = w.owner.cookie) =>
  (await ok<any>(w.t.req('GET', '/api/workstations', { cookie }))).workstations.find(
    (x: any) => x.id === w.workstationId,
  );

describe('organisation source folder', () => {
  it('refuses a user who does not own the workstation (and shows them nothing)', async () => {
    const other = await w.t.userSession(uniqueEmail('other'));
    const res = await put(other.cookie, w.workstationId, { orgId, path: '/home/x/src/acme' });
    expect(res.status).toBe(404);
    expect(await workstation(other.cookie)).toBeUndefined();
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='org.folder'`)).toHaveLength(0);
  });

  it('refuses an organisation the user is not a member of', async () => {
    const other = await w.t.userSession(uniqueEmail('stranger'));
    const strangerOrg = (
      await q('SELECT org_id FROM org_members WHERE user_id=$1 AND status=$2', [other.id, 'active'])
    )[0]?.org_id;
    expect(strangerOrg).toBeTruthy();
    const res = await put(w.owner.cookie, w.workstationId, { orgId: strangerOrg, path: '/home/x/src/acme' });
    expect(res.status).toBe(403);
    expect(await q(`SELECT 1 FROM runner_commands WHERE type='org.folder'`)).toHaveLength(0);
  });

  it('rejects an empty path and a bad body', async () => {
    expect((await put(w.owner.cookie, w.workstationId, { orgId, path: '' })).status).toBe(400);
    expect((await put(w.owner.cookie, w.workstationId, { orgId: 'nope', path: null })).status).toBe(400);
  });

  it('queues org.folder for the runner and stores what the runner reports', async () => {
    const from = r.received.length;
    const res = await put(w.owner.cookie, w.workstationId, { orgId, path: '/home/x/src/acme' });
    expect(res.status).toBe(202);
    const cmd = await r.waitFor('command', (c) => c.command === 'org.folder', 5000, from);
    expect(cmd.payload).toEqual({ orgId, path: '/home/x/src/acme' });
    r.send('command.result', { commandId: cmd.commandId, ok: true, result: { ok: true } });
    r.send('org.folders', {
      folders: [{ orgId, folder: '/home/x/src/acme', valid: true, reason: null, repoCount: 3 }],
      candidates: ['/home/x/src/acme', '/home/x/src/other'],
    });
    await until(async () => (await workstation()).orgFolders?.folders.length === 1, 3000, 'report stored');
    expect((await workstation()).orgFolders).toMatchObject({
      folders: [{ orgId, folder: '/home/x/src/acme', valid: true, repoCount: 3 }],
      errors: {},
      candidates: ['/home/x/src/acme', '/home/x/src/other'],
    });
  });

  it('keeps the reason of a refusal until the next success, and a periodic report does not wipe it', async () => {
    const from = r.received.length;
    await put(w.owner.cookie, w.workstationId, { orgId, path: '/etc' });
    const cmd = await r.waitFor('command', (c) => c.command === 'org.folder', 5000, from);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: false, error: '/etc must be a folder inside one of the runner repoRoots' },
    });
    await until(async () => !!(await workstation()).orgFolders?.errors[orgId], 3000, 'refusal stored');
    r.send('org.folders', { folders: [], candidates: [] });
    await until(async () => (await workstation()).orgFolders?.folders.length === 0, 3000, 'report stored');
    expect((await workstation()).orgFolders.errors[orgId]).toContain('repoRoots');

    const from2 = r.received.length;
    await put(w.owner.cookie, w.workstationId, { orgId, path: null });
    const clear = await r.waitFor('command', (c) => c.command === 'org.folder', 5000, from2);
    expect(clear.payload).toEqual({ orgId, path: null });
    r.send('command.result', { commandId: clear.commandId, ok: true, result: { ok: true } });
    await until(async () => !(await workstation()).orgFolders?.errors[orgId], 3000, 'error cleared');
  });

  it('keeps the folder paths out of the admin list', async () => {
    const root = await w.t.userSession(uniqueEmail('admin'), 'admin');
    const list = await ok<any>(w.t.req('GET', '/api/admin/workstations', { cookie: root.cookie }));
    expect(list.workstations.length).toBeGreaterThan(0);
    expect(list.workstations[0].orgFolders).toBeUndefined();
  });
});
