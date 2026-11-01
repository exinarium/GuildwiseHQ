import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plannedVaultPath, projectVault } from '../src/commands/decisions.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, until, type World } from './helpers/world.ts';

// Decisions, standing orders and investigation notes go to the vault `vaultForProject` names
// (docs/design/project-graphs.md section 3): the project's git vault, then the organization vault, then the local one.

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_PROJECT_GRAPHS: 'true', AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  await until(
    async () => (await q(`SELECT 1 FROM vaults WHERE project_id IS NOT NULL`)).length === 1,
    4000,
    'local vault',
  );
});
afterAll(async () => {
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

const post = (body: unknown) => w.t.req('POST', '/api/vaults', { cookie: w.owner.cookie, body });
const target = () => projectVault(w.t.app.ctx.pool, w.projectId);

describe('projectVault follows vaultForProject', () => {
  it('uses the automatic local vault when it is all the project has', async () => {
    const [local] = await q(`SELECT id FROM vaults WHERE project_id=$1`, [w.projectId]);
    expect((await target())?.vaultId).toBe(local?.id);
  });

  it('prefers the organization vault over the project local one', async () => {
    const org = await post({ kind: 'org', remoteUrl: 'git@example.test:me/org.git' });
    expect(org.status).toBe(201);
    expect((await target())?.vaultId).toBe(org.body.id);
    const planned = await plannedVaultPath(w.t.app.ctx.pool, {
      scope: 'standing_order',
      orgId: w.owner.id,
      projectId: w.projectId,
    });
    expect(planned).toMatch(/standing-orders\.md$/);
  });

  it("prefers the project's own git vault over both", async () => {
    const res = await post({
      kind: 'project',
      projectId: w.projectId,
      remoteUrl: 'git@example.test:me/p.git',
    });
    expect(res.status).toBe(201);
    expect((await target())?.vaultId).toBe(res.body.id);
  });
});
