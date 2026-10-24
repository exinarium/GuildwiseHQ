import { randomUUID } from 'node:crypto';
import {
  indexPack,
  PACKS_CAPABILITY,
  packSnapshotOf,
  SESSION_TURNS_CAPABILITY,
  SESSION_VERBS_CAPABILITY,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeGate } from '../src/commands/finalize.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * S-B1: "What it may do" and approval gates. Defaults first (no gate on an existing agent), then who may switch a gate, then the
 * server choke points: a gated action pauses, raises a desk item, and goes through once after the approval.
 */
const q = async (sql: string, params: unknown[] = []): Promise<any[]> => rawQ(sql, params) as Promise<any[]>;
let w: World;
let r: FakeRunner;
let orgId: string;
let admin: { id: string; cookie: string };
let member: { id: string; cookie: string };
let agentId = '';
let shiftId = '';

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({
    capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY, PACKS_CAPABILITY],
  });
  orgId = (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]?.org_id as string;
  admin = await w.t.userSession(uniqueEmail('admin'));
  member = await w.t.userSession(uniqueEmail('member'));
  await w.t.addOrgMember(orgId, admin.id, 'admin');
  await w.t.addOrgMember(orgId, member.id, 'member');
  agentId = (await w.hire('Cy', 'ba', 'senior')).id;
  shiftId = randomUUID();
  await q(
    `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
     VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
    [shiftId, orgId, agentId, w.workstationId],
  );
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const as = (u: { cookie: string }) => ({ cookie: u.cookie, headers: { 'x-aom-org': orgId } });
const call = (u: { cookie: string }, method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { ...as(u), ...(body !== undefined ? { body } : {}) });
const owner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );
const rpc = async (id: string, method: string, params: Record<string, unknown> = {}) => {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId: id, method, params });
  return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
};
const gateItems = () =>
  q(`SELECT * FROM desk_items WHERE subkind='agent_gate' AND (data->>'agentId')=$1 ORDER BY created_at`, [
    agentId,
  ]);
const setGate = (who: { cookie: string }, actionClass: string, gated: boolean) =>
  call(who, 'PUT', `/api/agents/${agentId}/gates`, { actionClass, gated });

describe('What it may do', () => {
  it('shows tools, repos, data, provider, grants, spend and the gates in one answer', async () => {
    const d = await owner('GET', `/api/agents/${agentId}/may-do`);
    expect(d).toMatchObject({ agentId, agentName: 'Cy', canGate: true, canUngate: true });
    expect(d.tools.allowedTools).toEqual(expect.arrayContaining(['read']));
    expect(d.repos).toMatchObject({ readOrgRepos: expect.any(Boolean) });
    expect(d.data).toHaveProperty('projects');
    expect(d.provider).toMatchObject({ runtime: 'mock', keySource: 'unknown' });
    expect(Array.isArray(d.delegation)).toBe(true);
    expect(d.gates.map((g: any) => g.actionClass)).toEqual([
      'merge_push',
      'deploy',
      'outbound_mail',
      'pack_scripts',
      'delegation',
      'playbook_run',
    ]);
  });

  it('defaults: no new gate on an existing agent; outbound mail always asks', async () => {
    const d = await owner('GET', `/api/agents/${agentId}/may-do`);
    const by = Object.fromEntries(d.gates.map((g: any) => [g.actionClass, g]));
    for (const c of ['merge_push', 'deploy', 'pack_scripts', 'delegation', 'playbook_run'])
      expect(by[c].gated).toBe(false);
    expect(by.outbound_mail).toMatchObject({ gated: true, enforcement: 'always' });
    expect(by.pack_scripts.enforcement).toBe('not_enforced');
    expect((await q('SELECT 1 FROM agent_action_gates')).length).toBe(0);
  });

  it('lists delegation grants with the role-inherited and the excluded ones marked', async () => {
    await owner('PUT', `/api/agents/${agentId}/delegate-grants`, {
      targetKind: 'persona',
      targetKey: 'devils-advocate',
      grant: { maxCalls: 3, timeoutSec: 90, maxProfile: null },
    });
    const d = await owner('GET', `/api/agents/${agentId}/may-do`);
    expect(d.delegation).toEqual([
      expect.objectContaining({
        kind: 'persona',
        handle: 'devils-advocate',
        inherited: false,
        excluded: false,
        maxCalls: 3,
      }),
    ]);
    await owner('PUT', `/api/agents/${agentId}/delegate-grants`, {
      targetKind: 'persona',
      targetKey: 'devils-advocate',
      grant: null,
    });
  });

  it('is for members of the organization only', async () => {
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect(
      (
        await w.t.req('GET', `/api/agents/${agentId}/may-do`, {
          cookie: stranger.cookie,
          headers: { 'x-aom-org': orgId },
        })
      ).status,
    ).toBeGreaterThanOrEqual(403);
    expect((await call(member, 'GET', `/api/agents/${agentId}/may-do`)).status).toBe(200);
    expect((await call(member, 'GET', `/api/agents/${agentId}/may-do`)).body.canGate).toBe(false);
  });

  it('shows full detail to the Owner and a summary without other projects’ names and budgets to a plain member', async () => {
    const before = (await q('SELECT allowed_project_ids FROM agents WHERE id=$1', [agentId]))[0];
    await q('UPDATE agents SET allowed_project_ids=$2 WHERE id=$1', [agentId, [w.projectId]]);
    try {
      const full = await owner('GET', `/api/agents/${agentId}/may-do`);
      expect(full.data.projects).toHaveLength(1);
      expect(full.spend).not.toBeNull();
      const mine = (await call(member, 'GET', `/api/agents/${agentId}/may-do`)).body;
      expect(mine.data.projects).toEqual([]); // the member is not on that project
      expect(mine.spend).toBeNull();
      expect(JSON.stringify(mine)).not.toContain(full.data.projects[0].name);
    } finally {
      await q('UPDATE agents SET allowed_project_ids=$2 WHERE id=$1', [agentId, before?.allowed_project_ids]);
    }
  });
});

describe('who switches a gate', () => {
  it('a Member who does not manage the agent cannot; an Admin turns it on, only an Owner or Admin turns it off', async () => {
    expect((await setGate(member, 'playbook_run', true)).status).toBe(404);
    const on = await setGate(admin, 'playbook_run', true);
    expect(on.status).toBe(200);
    expect(on.body.gates.find((g: any) => g.actionClass === 'playbook_run').gated).toBe(true);
    expect((await setGate(admin, 'playbook_run', true)).status).toBe(200); // idempotent
    expect(
      (await q('SELECT 1 FROM events WHERE type=$1 AND stream_id=$2', ['AgentGateSet', `agent-${agentId}`]))
        .length,
    ).toBe(1);
    // the hiring manager (a Member) may switch it on but not off
    await q('UPDATE agents SET manager_user_id=$2 WHERE id=$1', [agentId, member.id]);
    try {
      expect((await setGate(member, 'delegation', true)).status).toBe(200);
      const off = await setGate(member, 'delegation', false);
      expect(off.status).toBe(403);
      expect((await setGate(admin, 'delegation', false)).status).toBe(200);
    } finally {
      await q('UPDATE agents SET manager_user_id=$2 WHERE id=$1', [agentId, w.owner.id]);
    }
    expect((await setGate(admin, 'playbook_run', false)).status).toBe(200);
  });

  it('refuses classes that always ask or cannot be gated yet, and the CEO', async () => {
    const always = await setGate(admin, 'outbound_mail', true);
    expect(always.status).toBe(400);
    expect(always.body.error.code).toBe('always_gated');
    expect((await setGate(admin, 'pack_scripts', true)).body.error.code).toBe('not_enforced');
    const ceo = (await q(`SELECT id FROM agents WHERE org_id=$1 AND role_key='ceo' LIMIT 1`, [orgId]))[0]?.id;
    if (ceo) {
      const r2 = await call(admin, 'PUT', `/api/agents/${ceo}/gates`, { actionClass: 'deploy', gated: true });
      expect(r2.status).toBe(400);
      expect(r2.body.error.code).toBe('ceo_policy');
    }
  });
});

describe('a gated playbook run', () => {
  it('pauses, raises a desk item, and goes through once after the approval', async () => {
    await owner('PUT', `/api/agents/${agentId}/playbook-grants`, { key: 'brainstorm', granted: true });
    // not gated: it just starts
    expect((await rpc(shiftId, 'playbook.run', { key: 'brainstorm' })).ok).toBe(true);
    await setGate(w.owner, 'playbook_run', true);
    const first = await rpc(shiftId, 'playbook.run', { key: 'brainstorm', input: 'naming' });
    expect(first.ok).toBe(false);
    expect(first.error).toContain('approval_required');
    const items = await gateItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'approval', status: 'open' });
    expect(items[0].title).toContain('Cy');
    // asking again does not raise another one
    const again = await rpc(shiftId, 'playbook.run', { key: 'brainstorm', input: 'naming' });
    expect(again.error).toContain('approval_pending');
    expect(await gateItems()).toHaveLength(1);
    // the owner approves on the desk
    await owner('POST', `/api/desk/${items[0].id}/resolve`, { resolution: 'approved' });
    expect(
      (await q('SELECT status FROM gated_actions WHERE desk_item_id=$1', [items[0].id]))[0]?.status,
    ).toBe('approved');
    // the agent's retry goes through, once
    const go = await rpc(shiftId, 'playbook.run', { key: 'brainstorm', input: 'naming' });
    expect(go.ok).toBe(true);
    expect(
      (await q('SELECT status FROM gated_actions WHERE desk_item_id=$1', [items[0].id]))[0]?.status,
    ).toBe('used');
    const next = await rpc(shiftId, 'playbook.run', { key: 'brainstorm', input: 'naming' });
    expect(next.ok).toBe(false);
    expect(next.error).toContain('approval_required');
    expect(await gateItems()).toHaveLength(2);
  });

  it('an approval is for that playbook and nothing else', async () => {
    const [, second] = await gateItems();
    await owner('POST', `/api/desk/${second.id}/resolve`, { resolution: 'approved' });
    await owner('PUT', `/api/agents/${agentId}/playbook-grants`, { key: 'prd', granted: true });
    const other = await rpc(shiftId, 'playbook.run', { key: 'prd' });
    expect(other.error).toContain('approval_required');
    // the approved one is still usable
    expect((await rpc(shiftId, 'playbook.run', { key: 'brainstorm', input: 'naming' })).ok).toBe(true);
  });

  it('a rejection is reported and the agent is not asked to wait', async () => {
    const open = (await gateItems()).find(
      (i) => i.status === 'open' && i.title.includes('Cy') && JSON.stringify(i.body).includes('prd'),
    );
    expect(open).toBeTruthy();
    await owner('POST', `/api/desk/${open?.id}/resolve`, { resolution: 'rejected' });
    const res = await rpc(shiftId, 'playbook.run', { key: 'prd' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('approval_rejected');
    const before = (await gateItems()).length;
    await rpc(shiftId, 'playbook.run', { key: 'prd' });
    expect((await gateItems()).length).toBe(before); // does not nag the desk
  });
});

describe('a gated delegation', () => {
  it('waits for an approval of that target, then goes through once', async () => {
    await owner('PUT', `/api/agents/${agentId}/delegate-grants`, {
      targetKind: 'persona',
      targetKey: 'devils-advocate',
      grant: { maxCalls: 3, timeoutSec: 90, maxProfile: null },
    });
    const begin = () =>
      rpc(shiftId, 'delegate.begin', {
        delegateId: randomUUID(),
        target: 'devils-advocate',
        model: { runtime: 'claude-code', model: 'haiku' },
        taskChars: 20,
      });
    const plain = await begin();
    expect(plain.error ?? '').toBe('');
    expect(plain.ok).toBe(true);
    await setGate(w.owner, 'delegation', true);
    const blocked = await begin();
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toContain('approval_required');
    const item = (await gateItems()).find((i) => i.status === 'open' && i.title.includes('delegat'));
    expect(item).toBeTruthy();
    await owner('POST', `/api/desk/${item?.id}/resolve`, { resolution: 'approved' });
    expect((await begin()).ok).toBe(true);
    expect((await begin()).error).toContain('approval_required');
    await setGate(w.owner, 'delegation', false);
  });
});

describe('a gated landing (merge, push, pull request)', () => {
  it('turns every landing of a card this agent built into a desk approval, whatever its size', async () => {
    const card = (await q(`SELECT * FROM cards WHERE project_id=$1 LIMIT 1`, [w.projectId]))[0];
    if (!card) return;
    const c = {
      ...card,
      original_builder_agent_id: agentId,
      risk_tier: 'small',
      workflow_version_id: card.workflow_version_id,
    };
    const plain = await mergeGate(w.t.app.ctx.pool, c, 'pr');
    await setGate(w.owner, 'merge_push', true);
    try {
      expect(await mergeGate(w.t.app.ctx.pool, c, 'pr')).toBe('approval');
      expect(await mergeGate(w.t.app.ctx.pool, c, 'merge')).toBe('approval');
      expect(await mergeGate(w.t.app.ctx.pool, c, 'push_branch')).toBe('approval');
      // another builder's card is not affected
      expect(
        await mergeGate(
          w.t.app.ctx.pool,
          { ...c, original_builder_agent_id: randomUUID(), last_agent_id: null },
          'pr',
        ),
      ).toBe(plain);
    } finally {
      await setGate(w.owner, 'merge_push', false);
    }
    expect(await mergeGate(w.t.app.ctx.pool, c, 'pr')).toBe(plain);
  });
});

describe('gate hardening', () => {
  it('asks for the landing approval even when the workflow has the lean team owner approval step', async () => {
    const card = (await q(`SELECT * FROM cards WHERE project_id=$1 LIMIT 1`, [w.projectId]))[0];
    if (!card) return;
    const c = { ...card, original_builder_agent_id: agentId, risk_tier: 'small' };
    await q(
      `INSERT INTO workflow_stages (workflow_version_id, stage_id, ordinal, kind, column_key)
       VALUES ($1,'owner_approval',99,'manual','review') ON CONFLICT DO NOTHING`,
      [card.workflow_version_id],
    );
    try {
      expect(await mergeGate(w.t.app.ctx.pool, c, 'merge')).toBe('none');
      await setGate(w.owner, 'merge_push', true);
      expect(await mergeGate(w.t.app.ctx.pool, c, 'merge')).toBe('approval');
    } finally {
      await setGate(w.owner, 'merge_push', false);
      await q(
        `DELETE FROM workflow_stages WHERE workflow_version_id=$1 AND stage_id='owner_approval' AND ordinal=99`,
        [card.workflow_version_id],
      );
    }
  });

  it('binds an approval to the playbook input: another input asks again', async () => {
    await owner('PUT', `/api/agents/${agentId}/playbook-grants`, { key: 'brainstorm', granted: true });
    await setGate(w.owner, 'playbook_run', true);
    try {
      const a = await rpc(shiftId, 'playbook.run', { key: 'brainstorm', input: 'alpha plan' });
      expect(a.error).toContain('approval_required');
      const item = (await gateItems()).find((i) => i.status === 'open' && i.body.includes('alpha plan'));
      await owner('POST', `/api/desk/${item?.id}/resolve`, { resolution: 'approved' });
      const other = await rpc(shiftId, 'playbook.run', {
        key: 'brainstorm',
        input: 'something else entirely',
      });
      expect(other.error).toContain('approval_required');
      const go = await rpc(shiftId, 'playbook.run', { key: 'brainstorm', input: 'alpha plan' });
      expect(go.error ?? '').not.toContain('approval_');
    } finally {
      await setGate(w.owner, 'playbook_run', false);
    }
  });

  it('lets only an Owner or Admin, the agent manager or the person who set the gate decide a gate item', async () => {
    await setGate(w.owner, 'playbook_run', true);
    try {
      await rpc(shiftId, 'playbook.run', { key: 'brainstorm', input: 'for the admin to decide' });
      const item = (await gateItems()).find((i) => i.status === 'open' && i.body.includes('for the admin'));
      expect(item).toBeTruthy();
      expect([403, 404]).toContain(
        (await call(member, 'POST', `/api/desk/${item?.id}/resolve`, { resolution: 'approved' })).status,
      );
      expect(
        (await call(admin, 'POST', `/api/desk/${item?.id}/resolve`, { resolution: 'approved' })).status,
      ).toBe(200);
    } finally {
      await setGate(w.owner, 'playbook_run', false);
    }
  });
});

describe('scopes on a grant', () => {
  let packId = '';
  it('warns when the playbook needs a scope the agent lacks, and grants only on confirmation', async () => {
    packId = (
      await owner(
        'POST',
        '/api/packs',
        { name: 'scoped', url: 'https://github.com/x/scoped.git', ref: 'v1' },
        201,
      )
    ).pack.id;
    const tree = {
      'pack.yaml': 'scopes: [web]\nplaybooks:\n  - dir: flows/ship\n    scopes: [shell, commit]\n',
      'flows/ship/workflow.md': '---\nname: ship\ndescription: Ship it\n---\n\nShip.\n',
      'flows/ship/steps/step-01-go.md': '# Step 1\n\nGo.\n',
    };
    const snap = packSnapshotOf({
      name: 'scoped',
      ref: 'v1',
      sha: 'c'.repeat(40),
      index: indexPack({ name: 'scoped', adapter: 'auto', tree }),
    });
    r.send('packs.report', { packId, state: 'resolved', snapshot: snap });
    await until(
      async () =>
        (await owner('GET', '/api/packs')).packs.find((p: any) => p.id === packId)?.status === 'ready',
    );
    await owner('POST', `/api/packs/${packId}/trust`, { sha: snap.sha, contentHash: snap.contentHash });
    // the menu shows what the playbook needs
    const menu = await owner('GET', '/api/slash-commands?context=session');
    expect(menu.items.find((i: any) => i.key === 'scoped:ship')?.scopes).toEqual(['web', 'shell', 'commit']);
    // the BA agent has no shell, no web, no commit: refused until confirmed
    const refused = await call(w.owner, 'PUT', `/api/agents/${agentId}/playbook-grants`, {
      key: 'scoped:ship',
      granted: true,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('scopes_missing');
    expect(refused.body.error.details.missing).toEqual(['commit']);
    expect(refused.body.error.details.required.map((x: any) => x.scope)).toEqual(['web', 'shell', 'commit']);
    expect(
      (
        await q('SELECT 1 FROM agent_playbook_grants WHERE agent_id=$1 AND playbook_key=$2', [
          agentId,
          'scoped:ship',
        ])
      ).length,
    ).toBe(0);
    const ok1 = await call(w.owner, 'PUT', `/api/agents/${agentId}/playbook-grants`, {
      key: 'scoped:ship',
      granted: true,
      confirmScopes: true,
    });
    expect(ok1.status).toBe(200);
    expect(ok1.body.keys).toContain('scoped:ship');
    // revoking needs no confirmation
    expect(
      (
        await call(w.owner, 'PUT', `/api/agents/${agentId}/playbook-grants`, {
          key: 'scoped:ship',
          granted: false,
        })
      ).status,
    ).toBe(200);
  });

  it('a capability with no declared scopes is granted without a question', async () => {
    const res = await call(w.owner, 'PUT', `/api/agents/${agentId}/playbook-grants`, {
      key: 'brainstorm',
      granted: true,
    });
    expect(res.status).toBe(200);
  });

  it('shows the scopes of what the agent holds on its What it may do screen', async () => {
    await call(w.owner, 'PUT', `/api/agents/${agentId}/playbook-grants`, {
      key: 'scoped:ship',
      granted: true,
      confirmScopes: true,
    });
    const d = await owner('GET', `/api/agents/${agentId}/may-do`);
    expect(d.playbooks.map((p: any) => p.key)).toContain('scoped:ship');
  });
});

describe('replay', () => {
  it('survives a rebuild of the projections', async () => {
    await setGate(w.owner, 'deploy', true);
    const before = await q('SELECT request_id, status, action_class FROM gated_actions ORDER BY request_id');
    const gates = await q('SELECT agent_id, action_class FROM agent_action_gates ORDER BY 1,2');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(await q('SELECT request_id, status, action_class FROM gated_actions ORDER BY request_id')).toEqual(
      before,
    );
    expect(await q('SELECT agent_id, action_class FROM agent_action_gates ORDER BY 1,2')).toEqual(gates);
  });
});
