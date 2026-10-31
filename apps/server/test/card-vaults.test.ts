import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  // no automatic local project vault: each test decides which vaults exist
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_PROJECT_GRAPHS: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const cookie = () => w.owner.cookie;
const addVault = async (body: Record<string, unknown>) =>
  (
    await ok<any>(
      w.t.req('POST', '/api/vaults', {
        cookie: cookie(),
        body: { remoteUrl: `git@example.test:srv/${Math.random().toString(36).slice(2)}.git`, ...body },
      }),
      201,
    )
  ).vault?.id as string | undefined;

const builderStart = async () => {
  await freshState();
  await q('DELETE FROM vaults');
};

describe('a card shift carries the organization vault and the project vault', () => {
  it('both vaults: vaults lists both, vault stays the project vault (the write target)', async () => {
    await builderStart();
    const orgId = await addVault({ kind: 'org' });
    const prjId = await addVault({ kind: 'project', projectId: w.projectId });
    await w.hire('Bo', 'builder', 'senior');
    await w.card({ title: 'Both vaults' });
    const start = await p.next('Bo');
    expect(start.vault).toMatchObject({ vaultId: prjId, kind: 'project' });
    expect(start.vaults?.map((v: any) => v.vaultId)).toEqual([prjId, orgId]);
  });

  it('a project without a vault: only the organization vault, no error', async () => {
    await builderStart();
    const orgId = await addVault({ kind: 'org' });
    await w.hire('Bo2', 'builder', 'senior');
    await w.card({ title: 'Org only' });
    const start = await p.next('Bo2');
    expect(start.vaults?.map((v: any) => v.vaultId)).toEqual([orgId]);
  });

  it('no organization vault: only the project vault', async () => {
    await builderStart();
    const prjId = await addVault({ kind: 'project', projectId: w.projectId });
    await w.hire('Bo3', 'builder', 'senior');
    await w.card({ title: 'Project only' });
    const start = await p.next('Bo3');
    expect(start.vaults?.map((v: any) => v.vaultId)).toEqual([prjId]);
  });

  it('no vault at all: no vaults key, the shift still starts', async () => {
    await builderStart();
    await w.hire('Bo4', 'builder', 'senior');
    await w.card({ title: 'No vault' });
    const start = await p.next('Bo4');
    expect(start.vault).toBeNull();
    expect(start.vaults).toBeUndefined();
  });

  it('a workstation user who is not an owner or admin does not get the organization vault', async () => {
    await builderStart();
    await addVault({ kind: 'org' });
    const prjId = await addVault({ kind: 'project', projectId: w.projectId });
    await q(`UPDATE org_members SET role='member' WHERE user_id=$1`, [w.owner.id]);
    try {
      await w.hire('Bo5', 'builder', 'senior');
      await w.card({ title: 'Non manager' });
      const start = await p.next('Bo5');
      expect(start.vaults?.map((v: any) => v.vaultId)).toEqual([prjId]);
    } finally {
      await q(`UPDATE org_members SET role='owner' WHERE user_id=$1`, [w.owner.id]);
    }
  });
});
