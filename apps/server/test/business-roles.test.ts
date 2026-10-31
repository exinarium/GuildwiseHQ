import { BUILTIN_ROLES, BUSINESS_ROLE_KEYS, isBusinessRoleKey } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const roleKeys = async () =>
  (
    await ok<{ roles: { definition: { key: string } }[] }>(
      w.t.req('GET', '/api/roles', { cookie: w.owner.cookie }),
    )
  ).roles.map((r) => r.definition.key);
const hireReq = (name: string, roleKey: string) =>
  w.t.req('POST', '/api/agents', {
    cookie: w.owner.cookie,
    body: {
      name,
      roleKey,
      seniority: 'senior',
      workstationId: w.workstationId,
      runtime: 'mock',
      model: 'mock',
    },
  });
const setMode = (mode: 'dev' | 'business') =>
  q('UPDATE organizations SET mode=$2 WHERE id=$1', [w.owner.id, mode]);

describe('business roles in the catalogue (AC 1)', () => {
  it('boot registers the seven as global rows, once each', async () => {
    const rows = await q(`SELECT key FROM role_definitions WHERE org_id IS NULL AND key = ANY($1)`, [
      [...BUSINESS_ROLE_KEYS],
    ]);
    expect(rows.map((r) => r.key).sort()).toEqual([...BUSINESS_ROLE_KEYS].sort());
  });
});

describe('a dev organization (AC 5)', () => {
  it('lists exactly the built-in roles it had before, and none of the business roles', async () => {
    await setMode('dev');
    const keys = await roleKeys();
    for (const k of BUSINESS_ROLE_KEYS) expect(keys).not.toContain(k);
    for (const r of BUILTIN_ROLES.filter((x) => !isBusinessRoleKey(x.key))) expect(keys).toContain(r.key);
  });

  it('refuses to hire a business role (role_not_in_mode)', async () => {
    const r = await hireReq('Dora', 'front_desk');
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('role_not_in_mode');
  });

  it('does not list the business department', async () => {
    const d = await ok<{ departments: { name: string }[] }>(
      w.t.req('GET', '/api/departments', { cookie: w.owner.cookie }),
    );
    expect(d.departments.map((x) => x.name)).not.toContain('business');
  });
});

describe('a business organization (AC 1, AC 3)', () => {
  it('lists the seven roles and hires each one', async () => {
    await setMode('business');
    const keys = await roleKeys();
    for (const k of BUSINESS_ROLE_KEYS) expect(keys).toContain(k);
    let n = 0;
    for (const k of BUSINESS_ROLE_KEYS) await ok(hireReq(`Biz ${++n}`, k), 201);
    const hired = await q(`SELECT role_key FROM agents WHERE org_id=$1 AND role_key = ANY($2)`, [
      w.owner.id,
      [...BUSINESS_ROLE_KEYS],
    ]);
    expect(hired).toHaveLength(7);
  });

  it('hiring a business role creates no organization role row', async () => {
    const own = await q(`SELECT 1 FROM role_definitions WHERE org_id=$1 AND key = ANY($2)`, [
      w.owner.id,
      [...BUSINESS_ROLE_KEYS],
    ]);
    expect(own).toHaveLength(0);
  });
});
