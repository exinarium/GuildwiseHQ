import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureOrgVaultIn } from '../src/commands/vaults.ts';
import { withAppendTx } from '../src/db/tx.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// The organization's automatic local vault (project-graphs) takes a git remote, the same way a project's local vault does.

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_PROJECT_GRAPHS: 'true', AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  await until(
    async () => (await q(`SELECT 1 FROM vaults WHERE project_id IS NOT NULL`)).length === 1,
    4000,
    'project vault',
  );
  await withAppendTx(w.t.app.ctx.pool, (tx) => ensureOrgVaultIn(w.t.app.ctx, tx, w.owner.id));
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
const orgVault = async () =>
  (
    await q(`SELECT * FROM vaults WHERE org_id=$1 AND kind='org' AND project_id IS NULL`, [w.owner.id])
  )[0] as Record<string, any>;

describe('the organization vault takes a git remote', () => {
  it('starts as an automatic local vault', async () => {
    expect(await orgVault()).toMatchObject({ storage: 'local', remote_url: '' });
  });

  it('registering a git URL converts that same vault (no vault_exists), and a second one is refused', async () => {
    const before = await orgVault();
    const res = await ok<any>(
      owner()('/api/vaults', { kind: 'org', remoteUrl: 'git@example.test:me/org.git', syncIntervalSec: 60 }),
      201,
    );
    expect(res.id).toBe(before.id);
    expect(await orgVault()).toMatchObject({
      id: before.id,
      storage: 'git',
      remote_url: 'git@example.test:me/org.git',
      sync_interval_sec: 60,
      local_workstation_id: null,
    });
    const again = await owner()('/api/vaults', { kind: 'org', remoteUrl: 'git@example.test:x/y.git' });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('vault_exists');
  });

  it('a local org vault also takes the remote through an edit (PATCH)', async () => {
    await q(`UPDATE vaults SET storage='local', remote_url='', local_workstation_id=$2 WHERE id=$1`, [
      (await orgVault()).id,
      w.workstationId,
    ]);
    const id = (await orgVault()).id;
    const res = await owner()(`/api/vaults/${id}`, { remoteUrl: 'git@example.test:me/two.git' }, 'PATCH');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await orgVault()).toMatchObject({ id, storage: 'git', remote_url: 'git@example.test:me/two.git' });
  });
});
