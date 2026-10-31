import { randomUUID } from 'node:crypto';
import {
  BUILTIN_ROLES,
  BUSINESS_ROLE_KEYS,
  isBusinessRoleKey,
  PACK_SEAT_KEYS,
  type PackSnapshot,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hireChecks } from '../src/ceo/actions2.ts';
import { ensureRole } from '../src/commands/pack-hire.ts';
import { withAppendTx } from '../src/db/tx.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer, workflowInput } from './helpers/designer.ts';
import { pipeline } from './helpers/pipeline.ts';
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

describe('a dev organization: more lists (AC 5)', () => {
  it('shows no business role or department in the catalogue, departments and CEO hire checks', async () => {
    await setMode('dev');
    const cat = await ok(w.t.req('GET', '/api/org/catalogue', { cookie: w.owner.cookie }));
    for (const k of BUSINESS_ROLE_KEYS) expect(JSON.stringify(cat)).not.toContain(`"${k}"`);
    const d = await ok<{ departments: { name: string }[] }>(
      w.t.req('GET', '/api/departments', { cookie: w.owner.cookie }),
    );
    expect(d.departments.map((x) => x.name)).not.toContain('business');
    const env = { ctx: w.t.app.ctx, orgId: w.owner.id } as never;
    const c = await hireChecks(env, 'front_desk', [], 1);
    expect(c.refuse).toBeTruthy();
  });

  it('does not refuse a business role for the CEO in a business organization on mode grounds', async () => {
    await setMode('business');
    const env = { ctx: w.t.app.ctx, orgId: w.owner.id } as never;
    const c = await hireChecks(env, 'front_desk', [], 1);
    expect(c.refuse ?? '').not.toMatch(/business role/i);
    await setMode('dev');
  });
});

describe('a persona that matches a business role (AC 2)', () => {
  const pack = {
    id: randomUUID(),
    name: 'crew',
    visibility: 'org',
    owner_user_id: null,
    snapshot: { items: [] } as unknown as PackSnapshot,
  };
  const item = (name: string, hash: string) =>
    ({
      kind: 'persona',
      key: `crew:${name.toLowerCase().replace(/ /g, '-')}`,
      name,
      hash,
      tools: ['read'],
    }) as never;
  const read = (hash: string) => ({ text: 'You greet people.', hash, sha: 'a'.repeat(40) });
  const run = (it: never, hash: string, seat: boolean) =>
    withAppendTx(w.t.app.ctx.pool, (tx) =>
      ensureRole(w.t.app.ctx, tx, w.owner.id, w.owner.id, pack as never, it, read(hash), true, {
        ...(seat ? { seat: true } : {}),
      }),
    );
  const ownRoles = async () =>
    Number((await q('SELECT count(*)::int AS n FROM role_definitions WHERE org_id=$1', [w.owner.id]))[0]?.n);

  it('in a business organization takes the built-in role and registers no role', async () => {
    await setMode('business');
    const before = await ownRoles();
    const def = await run(item('Front Desk', 'h1'), 'h1', true);
    expect(def.key).toBe('front_desk');
    expect(def.builtIn).toBe(true);
    expect(await ownRoles()).toBe(before);
  });

  it('in a dev organization still makes the pack role', async () => {
    await setMode('dev');
    const before = await ownRoles();
    const def = await run(item('Front Desk', 'h1'), 'h1', true);
    expect(def.key).toBe('crew-front-desk');
    expect(def.builtIn).toBeFalsy();
    expect(await ownRoles()).toBe(before + 1);
  });

  it('a persona role made earlier keeps its role in a business organization, and still gets versions', async () => {
    await setMode('business');
    const before = await ownRoles();
    expect((await run(item('Front Desk', 'h1'), 'h1', true)).key).toBe('crew-front-desk');
    expect(await ownRoles()).toBe(before);
    const v2 = await run(item('Front Desk', 'h2'), 'h2', true);
    expect(v2.key).toBe('crew-front-desk');
    expect(v2.version).toBe(2);
  });

  it('without the seat option (the role-update path) a matching persona still makes its own role', async () => {
    await setMode('business');
    const def = await run(item('Billing Clerk', 'b1'), 'b1', false);
    expect(def.key).toBe('crew-billing-clerk');
    await setMode('dev');
  });
});

describe('a business role in an organization with no repository (AC 3)', () => {
  it('starts a shift without a worktree, a repository read or a project path', async () => {
    await setMode('business');
    const d = designer(w);
    const stage = (id: string, to: string) => ({
      id,
      label: id,
      column: id,
      kind: 'agent',
      claimRole: 'front_desk',
      doneCriteria: 'The enquiry has an answer.',
      outcomes: [{ id: 'ok', label: 'ok', kind: 'success', to, event: 'StageCompleted' }],
    });
    const wf = workflowInput('enquiries', { department: 'business', cardTypes: ['enquiry'] }) as any;
    wf.stages = [wf.stages[0], stage('triage', 'done'), wf.stages[3]];
    wf.stages[0].outcomes[0].to = 'triage';
    await d.publish('workflows', wf);
    const runner = await w.connectRunner();
    const p = pipeline(w, runner);
    await w.hire('Fiona', 'front_desk', 'senior');
    const res = await w.t.req('POST', '/api/cards', {
      cookie: w.owner.cookie,
      body: {
        projectId: w.projectId,
        title: 'Enquiry',
        cardType: 'enquiry',
        workflowKey: 'enquiries',
        fields: { customer: 'Acme' },
        specify: true,
      },
    });
    expect(res.status).toBe(201);
    await q('UPDATE cards SET repo_id=NULL WHERE id=$1', [res.body.card.id]);
    const start = (await p.next('Fiona')) as any;
    expect(start.worktree ?? null).toBeNull();
    expect(start.brief.role.key).toBe('front_desk');
    expect(start.brief.project?.projectPath).toBeUndefined();
    expect(start.readRepos ?? []).toEqual([]);
    runner.close();
    await setMode('dev');
  });

  it('keeps the pack seat list of a dev organization as it was', () => {
    expect(PACK_SEAT_KEYS.some((k) => isBusinessRoleKey(k))).toBe(false);
  });
});
