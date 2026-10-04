import { parseDefinitionFile } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer, responderRole, roleInput, triagerRole, workflowInput } from './helpers/designer.ts';
import { addMember, hireFor, type Member } from './helpers/members.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let d: ReturnType<typeof designer>;
beforeAll(async () => {
  w = await createWorld();
  d = designer(w);
  await ok(w.t.req('POST', '/api/departments', { cookie: w.owner.cookie, body: { name: 'support' } }), 201);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const codes = (r: { body: any }) =>
  (r.body.error?.details?.issues ?? r.body.issues ?? []).map((i: any) => i.code);
const get = (url: string, cookie = w.owner.cookie) => ok<any>(w.t.req('GET', url, { cookie }));

describe('validation blocks submission', () => {
  beforeAll(async () => {
    await d.publish('roles', triagerRole());
    await d.publish('roles', responderRole());
  });

  const submitDraft = async (input: unknown) => {
    const draft = await d.draft('workflows', input);
    const res = await d.req('POST', `/api/workflows/${draft.id}/submit`);
    return { draft, res };
  };

  it('a stage that cannot be reached cannot be submitted', async () => {
    const wf = workflowInput('unreach') as any;
    wf.stages.splice(3, 0, {
      id: 'orphan',
      label: 'Orphan',
      column: 'Orphan',
      kind: 'agent',
      claimRole: 'responder',
      doneCriteria: 'x',
      outcomes: [{ id: 'ok', label: 'ok', kind: 'success', to: 'done', event: 'StageCompleted' }],
    });
    const { draft, res } = await submitDraft(wf);
    // The draft is saved with its issues shown inline; submitting is refused.
    expect(draft.issues.map((i: any) => i.code)).toContain('unreachable_stage');
    expect(res.status).toBe(422);
    expect(codes(res)).toContain('unreachable_stage');
    expect((await q('SELECT status FROM workflow_versions WHERE id=$1', [draft.id]))[0]!.status).toBe(
      'draft',
    );
  });

  it('a failure path that never ends cannot be submitted', async () => {
    const wf = workflowInput('loops') as any;
    // escalate -> a stage that only goes back to resolve: the failure route never terminates.
    wf.stages.splice(3, 0, {
      id: 'limbo',
      label: 'Limbo',
      column: 'Limbo',
      kind: 'agent',
      claimRole: 'triager',
      doneCriteria: 'x',
      outcomes: [{ id: 'again', label: 'again', kind: 'success', to: 'limbo', event: 'StageCompleted' }],
    });
    wf.stages[2].outcomes[1].to = 'limbo';
    const { res } = await submitDraft(wf);
    expect(res.status).toBe(422);
    expect(codes(res)).toContain('failure_no_path_to_terminal');
  });

  it('a stage no role can claim cannot be submitted', async () => {
    const wf = workflowInput('unclaimable') as any;
    wf.stages[2].claimRole = 'triager'; // triager may claim only support.triage, and the key differs anyway
    const { res } = await submitDraft(wf);
    expect(res.status).toBe(422);
    expect(codes(res)).toContain('role_cannot_claim_stage');
    const wf2 = workflowInput('ghost') as any;
    wf2.stages[1].claimRole = 'nobody';
    expect(codes(await submitDraft(wf2).then((r) => r.res))).toContain('unknown_role');
  });

  it('custom workflows cannot use built-in keys, other field sets or the built-in machinery', async () => {
    const res = await d.req('POST', '/api/workflows', workflowInput('code'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('builtin_protected');
    const wf = workflowInput('machinery') as any;
    wf.fieldSet = 'code';
    wf.stages[1].outcomes[0].event = 'ReviewRequested';
    wf.stages[2].outcomes[0].effect = 'finalize';
    const { draft } = await submitDraft(wf);
    expect(draft.issues.map((i: any) => i.code)).toEqual(
      expect.arrayContaining(['invalid_field_set', 'unsupported_custom_event', 'invalid_effect']),
    );
  });

  it('an unknown department is an error until the department exists', async () => {
    const wf = workflowInput('dept', { department: 'marketing' });
    const { draft } = await submitDraft(wf);
    expect(draft.issues.map((i: any) => i.code)).toContain('unknown_department');
  });
});

describe('draft, validate, desk approval, availability', () => {
  it('a role is only available after the owner approves it on the desk', async () => {
    const draft = await d.draft(
      'roles',
      roleInput('writer2', [['content', '*']], { department: 'delivery' }),
    );
    expect(draft).toMatchObject({ key: 'writer2', version: 1, status: 'draft', issues: [] });
    const keys = async () => (await get('/api/roles')).roles.map((r: any) => r.definition.key);
    expect(await keys()).not.toContain('writer2');
    const sub = await d.submit('roles', draft.id);
    expect(sub.status).toBe('pending_approval');
    expect(await keys()).not.toContain('writer2');
    // Cannot hire it yet.
    const hire = await w.t.req('POST', '/api/agents', {
      cookie: w.owner.cookie,
      body: { name: 'Early', roleKey: 'writer2', seniority: 'junior', workstationId: w.workstationId },
    });
    expect(hire.status).toBe(400);
    const item = (await get('/api/desk')).items.find((i: any) => i.id === sub.deskItemId);
    expect(item).toMatchObject({ kind: 'approval', subkind: 'definition', status: 'open' });
    expect((await d.resolve(sub.deskItemId, 'approved')).status).toBe(200);
    expect(await keys()).toContain('writer2');
    const h = await w.hire('Wendy', 'writer2', 'junior');
    expect(h.roleKey).toBe('writer2');
  });

  it('a rejected definition never becomes available and can be removed', async () => {
    const draft = await d.draft('roles', roleInput('nope', [['x', '*']], { department: 'delivery' }));
    const sub = await d.submit('roles', draft.id);
    expect((await d.resolve(sub.deskItemId, 'rejected')).status).toBe(200);
    expect((await get('/api/roles')).roles.map((r: any) => r.definition.key)).not.toContain('nope');
    expect((await d.req('DELETE', `/api/roles/${draft.id}`)).status).toBe(200);
    expect((await q('SELECT 1 FROM role_definitions WHERE id=$1', [draft.id])).length).toBe(0);
  });

  it('a workflow cannot be approved before the custom role it names is approved', async () => {
    const t = await d.draft('roles', roleInput('tg', [['pair', 'a']], { department: 'delivery' }));
    const wf = workflowInput('pair', { department: 'delivery' }) as any;
    wf.stages[1].claimRole = 'tg';
    wf.stages[2].claimRole = 'tg';
    const ws = await d.draft('workflows', wf);
    await d.req(
      'PUT',
      `/api/roles/${t.id}`,
      roleInput(
        'tg',
        [
          ['pair', 'triage'],
          ['pair', 'resolve'],
        ],
        { department: 'delivery' },
      ),
    );
    const wfSub = await d.submit('workflows', ws.id);
    const early = await d.resolve(wfSub.deskItemId, 'approved');
    expect(early.status).toBe(422);
    expect(early.body.error.message).toMatch(/approve the role first/);
    const roleSub = await d.submit('roles', t.id);
    expect((await d.resolve(roleSub.deskItemId, 'approved')).status).toBe(200);
    expect((await d.resolve(wfSub.deskItemId, 'approved')).status).toBe(200);
  });

  it('versions: a second draft is v2; the approved v2 supersedes v1; v1 stays on record', async () => {
    const base = roleInput('versioned', [['vw', '*']], { department: 'delivery' });
    const id1 = await d.publish('roles', base);
    const second = await d.draft('roles', { ...base, purpose: 'Second version' });
    expect(second.version).toBe(2);
    const dup = await d.req('POST', '/api/roles', base);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('draft_exists');
    const s = await d.submit('roles', second.id);
    await d.resolve(s.deskItemId, 'approved');
    const rows = await q('SELECT version, status FROM role_definitions WHERE key=$1 ORDER BY version', [
      'versioned',
    ]);
    expect(rows).toEqual([
      { version: 1, status: 'superseded' },
      { version: 2, status: 'active' },
    ]);
    expect(id1).toBeTruthy();
    const cat = await get('/api/org/catalogue');
    const entry = cat.roles.find((r: any) => r.key === 'versioned');
    expect(entry.versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(entry.versions[0].vaultPath).toBe('organization/roles/versioned/v2.yaml');
  });

  it('the definition is available as a provider neutral file and survives a round trip', async () => {
    const cat = await get('/api/org/catalogue');
    const role = cat.roles.find((r: any) => r.key === 'triager').versions[0];
    const file = await get(`/api/org/definitions/${role.id}/file`);
    expect(file.path).toBe('organization/roles/triager/v1.yaml');
    expect(file.content).not.toMatch(/claude|anthropic/i);
    const parsed = parseDefinitionFile(file.content);
    expect(parsed).toMatchObject({
      kind: 'role',
      definition: { key: 'triager', version: 1, builtIn: false },
    });
  });

  it('approval writes the definition file to the owner vault (a durable vault.write)', async () => {
    const v = await ok<any>(
      w.t.req('POST', '/api/vaults', {
        cookie: w.owner.cookie,
        body: { kind: 'work', remoteUrl: 'git@example.test:acme/vault.git' },
      }),
      201,
    );
    expect(v).toBeTruthy();
    await d.publish('roles', roleInput('stored', [['sw', '*']], { department: 'delivery' }));
    const mine = await until(
      async () => {
        const cmds = await q(
          `SELECT payload FROM runner_commands WHERE type='vault.write' ORDER BY created_at`,
        );
        return cmds.map((c) => c.payload).find((p: any) => p.path === 'organization/roles/stored/v1.yaml');
      },
      5000,
      'definition vault.write',
    );
    expect(mine.mode).toBe('replace');
    expect(parseDefinitionFile(mine.content).definition).toMatchObject({ key: 'stored' });
  });
});

describe('built-in roles and workflows are protected', () => {
  it('cannot be replaced or removed', async () => {
    expect((await d.req('POST', '/api/roles', roleInput('builder', [['x', '*']]))).status).toBe(409);
    const cat = await get('/api/org/catalogue');
    const builder = cat.roles.find((r: any) => r.key === 'builder');
    expect(builder.builtIn).toBe(true);
    expect((await d.req('DELETE', `/api/roles/${builder.versions[0].id}`)).status).toBe(403);
    const code = cat.workflows.find((x: any) => x.key === 'code');
    expect(code.builtIn).toBe(true);
    expect((await d.req('DELETE', `/api/workflows/${code.versions[0].id}`)).status).toBe(403);
    expect(
      (await d.req('PUT', `/api/roles/${builder.versions[0].id}`, roleInput('builder', [['x', '*']]))).status,
    ).toBe(409);
    expect((await d.req('POST', '/api/departments', { name: 'delivery' })).status).toBe(409);
  });

  it('an approved definition cannot be removed either', async () => {
    const cat = await get('/api/org/catalogue');
    const triager = cat.roles.find((r: any) => r.key === 'triager').versions[0];
    expect(triager.status).toBe('active');
    expect((await d.req('DELETE', `/api/roles/${triager.id}`)).status).toBe(409);
  });
});

describe('extending built-in roles', () => {
  let member: Member;
  beforeAll(async () => {
    member = await addMember(w, 'ext-member');
  });

  it('the owner adds instructions, skills and standing orders; core rules cannot be sent or changed', async () => {
    const before = (await get('/api/org/catalogue')).roles.find((r: any) => r.key === 'reviewer').versions[0]
      .definition;
    const res = await d.req('PUT', '/api/roles/reviewer/extensions', {
      instructions: 'Also check accessibility.',
      skills: ['a11y'],
      standingOrders: ['Never approve without a screenshot.'],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ roleKey: 'reviewer' });
    const bad = await d.req('PUT', '/api/roles/reviewer/extensions', {
      instructions: 'x',
      coreRules: [],
    });
    expect(bad.status).toBe(400);
    const after = (await get('/api/org/catalogue')).roles.find((r: any) => r.key === 'reviewer');
    expect(after.versions[0].definition.coreRules).toEqual(before.coreRules);
    expect(after.extensions).toMatchObject({
      skills: ['a11y'],
      standingOrders: ['Never approve without a screenshot.'],
    });
    // Custom roles are changed by new versions, not extensions; unknown roles do not exist.
    expect((await d.req('PUT', '/api/roles/triager/extensions', { instructions: 'x' })).status).toBe(404);
    expect((await d.req('PUT', '/api/roles/devops/extensions', { instructions: 'x' })).status).toBe(400);
    expect((await d.req('PUT', '/api/roles/reviewer/extensions', {})).status).toBe(400);
  });

  it("a member cannot change the owner's catalogue", async () => {
    const as = designer(w, member.cookie, `?projectId=${w.projectId}`);
    const ext = await as.req('PUT', '/api/roles/builder/extensions', { instructions: 'sneaky' });
    expect(ext.status).toBe(403);
    expect(ext.body.error.message).toMatch(/organization owner/);
    expect((await as.req('POST', '/api/roles', roleInput('sneaky', [['x', '*']]))).status).toBe(403);
    expect((await as.req('POST', '/api/workflows', workflowInput('sneaky'))).status).toBe(403);
    expect((await as.req('POST', '/api/departments', { name: 'sneaky' })).status).toBe(403);
    expect((await as.req('POST', '/api/roles/builder/reset')).status).toBe(403);
    const cat = await ok<any>(as.req('GET', '/api/org/catalogue'));
    expect(cat.canEdit).toBe(false);
    // They only see approved versions of the owner's catalogue.
    expect(
      cat.roles
        .flatMap((r: any) => r.versions)
        .every((v: any) => ['active', 'superseded'].includes(v.status)),
    ).toBe(true);
    expect((await q(`SELECT 1 FROM role_extensions WHERE role_key='builder'`)).length).toBe(0);
    // Their own organization is theirs to design.
    expect(
      (
        await w.t.req('PUT', '/api/roles/builder/extensions', {
          cookie: member.cookie,
          body: { instructions: 'mine' },
        })
      ).status,
    ).toBe(200);
    expect((await q(`SELECT org_id FROM role_extensions WHERE role_key='builder'`))[0]!.org_id).toBe(
      member.id,
    );
    // A stranger cannot even read the owner's catalogue.
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const r = await w.t.req('GET', `/api/org/catalogue?projectId=${w.projectId}`, {
      cookie: stranger.cookie,
    });
    expect(r.status).toBe(404);
  });
});

describe('shared projects use the owner catalogue', () => {
  beforeAll(async () => {
    await d.publish('workflows', workflowInput('support'));
  });
  it('a member hires custom roles of the owner for the project and sees them on the Hire form', async () => {
    const m = await addMember(w, 'hire-member');
    const roles = await ok<any>(w.t.req('GET', `/api/roles?projectId=${w.projectId}`, { cookie: m.cookie }));
    expect(roles.roles.map((r: any) => r.definition.key)).toEqual(
      expect.arrayContaining(['triager', 'responder']),
    );
    // Their own organization does not have them.
    const own = await ok<any>(w.t.req('GET', '/api/roles', { cookie: m.cookie }));
    expect(own.roles.map((r: any) => r.definition.key)).not.toContain('triager');
    const wfs = await ok<any>(
      w.t.req('GET', `/api/workflows?projectId=${w.projectId}`, { cookie: m.cookie }),
    );
    expect(wfs.workflows.map((x: any) => x.definition.key)).toContain('support');
    const hired = await hireFor(w, m, 'Tara', 'triager', 'junior');
    expect(hired).toMatchObject({ roleKey: 'triager', orgId: w.owner.id, managerUserId: m.id });
    // ... but not outside the project: their own org has no such role.
    const out = await w.t.req('POST', '/api/agents', {
      cookie: m.cookie,
      body: { name: 'Nope', roleKey: 'triager', seniority: 'junior', workstationId: m.workstationId },
    });
    expect(out.status).toBe(400);
  });
});

describe('departments', () => {
  it('group roles and workflows, and the HR board, agents and projects filter by them', async () => {
    const created = await ok<any>(
      w.t.req('POST', '/api/departments', { cookie: w.owner.cookie, body: { name: 'sales' } }),
      201,
    );
    expect(created).toMatchObject({ name: 'sales', builtIn: false });
    expect((await d.req('POST', '/api/departments', { name: 'Sales' })).status).toBe(409);
    await d.publish('roles', roleInput('dept-role', [['dw', '*']], { department: 'sales' }));
    const deps = (await get('/api/departments')).departments as any[];
    expect(deps.map((x) => x.name)).toEqual(
      expect.arrayContaining(['delivery', 'research', 'feeds', 'operations', 'support', 'sales']),
    );
    expect(deps.find((x) => x.name === 'sales').roleKeys).toEqual(expect.arrayContaining(['dept-role']));
    expect(deps.find((x) => x.name === 'delivery').workflowKeys).toContain('code');

    await w.hire('Dora', 'dept-role', 'junior');
    await w.hire('Bob', 'builder', 'junior');
    const hr = async (dep?: string) =>
      (await get(`/api/hr/board${dep ? `?department=${dep}` : ''}`)).agents
        .filter((a: any) => !a.agent.isDevops)
        .map((a: any) => a.agent.name);
    expect(await hr('sales')).toEqual(['Dora']);
    expect((await hr('delivery')).sort()).toEqual(['Bob', 'Wendy']);
    expect((await hr()).sort()).toEqual(['Bob', 'Dora', 'Tara', 'Wendy']);
    expect(await hr('support')).toEqual(['Tara']);
    const agents = (await get('/api/agents?department=sales')).agents.map((a: any) => a.name);
    expect(agents).toEqual(['Dora']);
    expect((await get('/api/agents')).agents.find((a: any) => a.name === 'Bob').department).toBe('delivery');

    // Projects take their department from the workflow that is their type.
    expect((await get('/api/projects')).projects[0].department).toBe('delivery');
    expect((await get('/api/projects?department=sales')).projects).toEqual([]);
    expect((await get('/api/projects?department=delivery')).projects.length).toBe(1);
  });
});

describe('rebuild', () => {
  it('projections rebuild reproduces the designer tables', async () => {
    const snap = async () => ({
      roles: await q(
        'SELECT org_id, key, version, status, department, desk_item_id, vault_path FROM role_definitions ORDER BY key, version, org_id NULLS FIRST',
      ),
      wfs: await q(
        'SELECT org_id, key, version, status, department, desk_item_id FROM workflow_versions ORDER BY key, version, org_id NULLS FIRST',
      ),
      stages: await q('SELECT count(*)::int AS n FROM workflow_stages'),
      deps: await q('SELECT name FROM departments ORDER BY name'),
      ext: await q('SELECT org_id, role_key, extensions FROM role_extensions ORDER BY org_id, role_key'),
    });
    const before = await snap();
    const { rebuildProjections } = await import('../src/projections/rebuild.ts');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
  });
});
