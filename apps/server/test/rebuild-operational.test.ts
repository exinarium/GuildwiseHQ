import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections, unsavedCascadeTargets } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const count = async (sql: string, p: unknown[] = []) => Number((await q(sql, p))[0]?.n);

describe('projections:rebuild keeps operational data', () => {
  it('no table that TRUNCATE ... CASCADE would empty is left unsaved', async () => {
    expect(await unsavedCascadeTargets(w.t.app.ctx.pool)).toEqual([]);
  });

  it('reset, API key and cloud workstation rows survive a rebuild', async () => {
    const uid = w.owner.id;
    const org = (await q('SELECT org_id FROM org_members WHERE user_id = $1 LIMIT 1', [uid]))[0]
      ?.org_id as string;
    expect(org).toBeTruthy();

    await q(
      `INSERT INTO password_resets (user_id, requested_by, token_hash, created_at, expires_at)
       VALUES ($1, $1, 'h-pr', now(), now() + interval '1 day')`,
      [uid],
    );
    await q(
      `INSERT INTO blog_api_keys (id, name, prefix, key_hash, scopes, created_at)
       VALUES (gen_random_uuid(), 'k', 'gw_', 'h-key', ARRAY['posts:write'], now())`,
    );
    await q(
      `INSERT INTO cloud_workstations (org_id, user_id, provider, name, config, created_at, updated_at)
       VALUES ($1, $2, 'ssh', 'vps', '{}', now(), now())`,
      [org, uid],
    );

    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);

    expect(
      await count(`SELECT count(*) n FROM password_resets WHERE user_id = $1 AND token_hash = 'h-pr'`, [uid]),
    ).toBe(1);
    expect(await count(`SELECT count(*) n FROM blog_api_keys WHERE key_hash = 'h-key'`)).toBe(1);
    expect(
      await count(`SELECT count(*) n FROM cloud_workstations WHERE org_id = $1 AND name = 'vps'`, [org]),
    ).toBe(1);
  });
});
