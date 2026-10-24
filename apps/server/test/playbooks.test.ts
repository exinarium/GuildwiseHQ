import { randomUUID } from 'node:crypto';
import {
  type AuthoredCapability,
  indexPack,
  PACK_AUTHORING_CAPABILITY,
  PACKS_CAPABILITY,
  type PackSnapshot,
  PLAYBOOK_LIMITS,
  packSnapshotOf,
  packTree,
  SESSION_TURNS_CAPABILITY,
  SESSION_VERBS_CAPABILITY,
} from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bmadFixtureStable } from '../../../packages/shared/test/fixtures/bmad-fixture.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, ok, pairWorkstation, until, type World } from './helpers/world.ts';

/**
 * Revision R3b, playbooks as `/` commands (docs/ARCHITECTURE.md section 38.10): the menu and who sees what, guided sessions
 * started by a person and by a granted agent, the step the facilitator reports, grants and who may change them, replay.
 */
const q = async (sql: string, params: unknown[] = []): Promise<any[]> => rawQ(sql, params) as Promise<any[]>;
let w: World;
let r: FakeRunner; // the Owner's workstation
let mem: FakeRunner; // a member's workstation
let memberWs = '';
let member: Awaited<ReturnType<typeof w.t.userSession>>;
let stranger: Awaited<ReturnType<typeof w.t.userSession>>;
const seen = new Set<string>();

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({
    capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY, PACKS_CAPABILITY],
  });
  member = await w.t.userSession(uniqueEmail('pb-member'));
  await w.t.addOrgMember(w.owner.id, member.id, 'member');
  const paired = await pairWorkstation(w.t, member, 'member-desk');
  memberWs = paired.workstationId;
  mem = await FakeRunner.connect(w.baseUrl, paired.runnerToken);
  mem.hello({
    runtimes: MOCK_RUNTIME,
    capabilities: [
      PACKS_CAPABILITY,
      PACK_AUTHORING_CAPABILITY,
      SESSION_TURNS_CAPABILITY,
      SESSION_VERBS_CAPABILITY,
    ],
  });
  await mem.waitFor('welcome');
  stranger = await w.t.userSession(uniqueEmail('pb-stranger'));
});
afterAll(async () => {
  r.close();
  mem.close();
  await w.t.close();
  await closeAdminPool();
});

// biome-ignore lint/suspicious/noExplicitAny: response bodies
const asOwner = (method: string, url: string, body?: unknown, expected = 200): Promise<any> =>
  ok(w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }), expected);
// biome-ignore lint/suspicious/noExplicitAny: response bodies
const asMember = (method: string, url: string, body?: unknown, expected = 200): Promise<any> =>
  ok(
    w.t.req(method, url, {
      cookie: member.cookie,
      headers: { 'x-aom-org': w.owner.id },
      ...(body !== undefined ? { body } : {}),
    }),
    expected,
  );
const rawOwner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) });
const rawMember = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, {
    cookie: member.cookie,
    headers: { 'x-aom-org': w.owner.id },
    ...(body !== undefined ? { body } : {}),
  });

const keysOf = (r2: { items: Array<{ key: string }> }): string[] => r2.items.map((i) => i.key);

/** The next facilitator turn the runner is sent, and the rpc a facilitator makes in it. */
const nextStart = async (pred: (f: any) => boolean = () => true): Promise<any> => {
  const f = await r.waitFor('chat.start', (x) => !seen.has(x.chatId) && pred(x), 15_000);
  seen.add(f.chatId);
  return f;
};
const call = async (
  from: FakeRunner,
  shiftId: string,
  method: string,
  params: Record<string, unknown> = {},
) => {
  const rpcId = randomUUID();
  const at = from.received.length;
  from.send('rpc.request', { rpcId, shiftId, method, params });
  return (await from.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, at)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
};
const finish = async (start: any) => {
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: 'ok',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  await until(
    async () =>
      (await q('SELECT status FROM session_turns WHERE id=$1', [start.chatId]))[0]?.status === 'done',
  );
};

const secretPlaybook: AuthoredCapability = {
  kind: 'playbook',
  key: 'secret-play',
  description: 'A private playbook of the member.',
  workflow: '# Secret\n\nDo the secret thing.\n',
  steps: [{ slug: 'one', text: '# Step 1: One\n\nAsk.\n' }],
  files: {},
};
const mineSkill: AuthoredCapability = {
  kind: 'skill',
  key: 'secret-skill',
  description: 'A private skill.',
  body: 'Be quiet.',
  files: {},
};
function revision(pack: string, caps: AuthoredCapability[]): PackSnapshot {
  const index = indexPack({ name: pack, adapter: 'generic', tree: packTree(caps) });
  const s = packSnapshotOf({ name: pack, ref: 'v1', sha: 'a'.repeat(64), index });
  return { ...s, sha: s.contentHash };
}

describe('the / menu', () => {
  it('lists the built-in playbooks and skills, playbooks first, without personas or templates', async () => {
    const chat = await asOwner('GET', '/api/slash-commands?context=chat');
    const pb = chat.items.filter((i: { kind: string }) => i.kind === 'playbook');
    expect(keysOf({ items: pb })).toEqual(expect.arrayContaining(['brainstorm', 'prd', 'product-brief']));
    expect(chat.items.some((i: { kind: string }) => i.kind === 'persona')).toBe(false);
    expect(chat.items.some((i: { kind: string }) => i.kind === 'skill')).toBe(true);
    expect(chat.items[0].kind).toBe('playbook');
    expect(
      pb.every((i: { canStartSession: boolean; description: string }) => i.canStartSession && i.description),
    ).toBe(true);
    // a session composer offers playbooks only
    const session = await asOwner('GET', '/api/slash-commands?context=session');
    expect(session.items.every((i: { kind: string }) => i.kind === 'playbook')).toBe(true);
  });

  let bmadId = '';
  it('lists the BMAD workflows once the pack is approved, as playbooks, and not its templates', async () => {
    bmadId = (
      await asOwner(
        'POST',
        '/api/packs',
        { preset: 'bmad', url: 'https://github.com/x/bmad.git', ref: 'v6.12.4' },
        201,
      )
    ).pack.id;
    const snap = packSnapshotOf({
      name: 'bmad',
      ref: 'v6.12.4',
      sha: 'b'.repeat(40),
      index: indexPack({ name: 'bmad', adapter: 'auto', tree: bmadFixtureStable() }),
    });
    r.send('packs.report', { packId: bmadId, state: 'resolved', snapshot: snap });
    await until(
      async () =>
        (await asOwner('GET', '/api/packs')).packs.find((p: any) => p.id === bmadId)?.status === 'ready',
    );
    // not approved yet: not listed
    expect(keysOf(await asOwner('GET', '/api/slash-commands'))).not.toContain(
      'bmad:create-epics-and-stories',
    );
    await asOwner('POST', `/api/packs/${bmadId}/trust`, { sha: snap.sha, contentHash: snap.contentHash });
    const list = await asOwner('GET', '/api/slash-commands?context=session');
    const keys = keysOf(list);
    expect(keys).toEqual(expect.arrayContaining(['bmad:create-epics-and-stories', 'bmad:brainstorming']));
    expect(keys).not.toContain('bmad:prd'); // a template, loaded by other playbooks
    expect(keys).not.toContain('bmad:product-brief');
    const epics = list.items.find((i: { key: string }) => i.key === 'bmad:create-epics-and-stories');
    expect(epics).toMatchObject({ kind: 'playbook', source: 'pack', canStartSession: true, packId: bmadId });
  });

  let privId = '';
  it('lists a private pack to its owner only', async () => {
    privId = (
      await asMember(
        'POST',
        '/api/my-capabilities',
        { name: 'mine', visibility: 'private', workstationId: memberWs },
        201,
      )
    ).pack.id;
    mem.send('packs.report', {
      packId: privId,
      state: 'resolved',
      snapshot: revision('mine', [secretPlaybook, mineSkill]),
    });
    await until(async () =>
      (await asMember('GET', '/api/slash-commands')).items.some((i: any) => i.key === 'mine:secret-play'),
    );
    const mine = await asMember('GET', '/api/slash-commands');
    expect(mine.items.find((i: any) => i.key === 'mine:secret-play')).toMatchObject({
      kind: 'playbook',
      visibility: 'private',
      canStartSession: true,
    });
    expect(keysOf(mine)).toContain('mine:secret-skill');
    // the Owner, an Admin, another member and another organization never see it, in either context
    const admin = await w.t.userSession(uniqueEmail('pb-admin'));
    await w.t.addOrgMember(w.owner.id, admin.id, 'admin');
    const other = await w.t.userSession(uniqueEmail('pb-other'));
    await w.t.addOrgMember(w.owner.id, other.id, 'member');
    const viewers = [
      { cookie: w.owner.cookie },
      { cookie: admin.cookie, headers: { 'x-aom-org': w.owner.id } },
      { cookie: other.cookie, headers: { 'x-aom-org': w.owner.id } },
      { cookie: stranger.cookie },
    ];
    for (const v of viewers)
      for (const ctx of ['chat', 'session']) {
        const res = await w.t.req('GET', `/api/slash-commands?context=${ctx}`, v);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).not.toContain('secret');
      }
  });
});

describe('a person starts a guided session', () => {
  it('opens a Discovery session on the playbook, tells the facilitator about the steps and shows the step it reports', async () => {
    const res = await asOwner(
      'POST',
      '/api/playbooks/run',
      { key: 'prd', input: 'Invoices for freelancers' },
      201,
    );
    expect(res.path).toBe(`/discovery/${res.threadId}`);
    const state = (await asOwner('GET', `/api/discovery/${res.threadId}`)).state;
    expect(state.config).toMatchObject({
      playbook: 'prd',
      idea: 'Invoices for freelancers',
      playbookRun: { key: 'prd', step: null, startedBy: { kind: 'user' } },
    });
    expect(state.config.playbookRun.steps.length).toBe(6);
    const start = await nextStart((f) => f.message.includes('"role":"facilitator"'));
    expect(start.session.instructions).toContain('aom session step');
    expect(start.message).toContain('## This session runs a playbook');
    expect(start.message).toContain('Playbook: prd');
    expect(start.message).toContain('Invoices for freelancers');
    expect(start.message).toContain('begin step 1');
    // it reports step 2 of the six; the page reads it from the state
    const a = await call(r, start.chatId, 'session.step', { step: 2 });
    expect(a.ok).toBe(true);
    expect(a.result.message).toContain('Step 2 of 6: Goals and users');
    expect((await asOwner('GET', `/api/discovery/${res.threadId}`)).state.config.playbookRun).toMatchObject({
      step: 2,
      stepTitle: 'Goals and users',
      total: 6,
    });
    const bad = await call(r, start.chatId, 'session.step', { step: 9 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('6 steps');
    await finish(start);
  });

  it('runs a BMAD workflow of an approved pack, loaded by the facilitator, with titles reported as it goes', async () => {
    const res = await asOwner(
      'POST',
      '/api/playbooks/run',
      { key: 'bmad:create-epics-and-stories', input: 'billing PRD' },
      201,
    );
    const start = await nextStart((f) => f.message.includes('"role":"facilitator"'));
    expect(start.message).toContain('aom skill show playbook:bmad:create-epics-and-stories');
    expect(start.message).toContain("Read the playbook's steps with the `aom skill show`");
    const a = await call(r, start.chatId, 'session.step', {
      step: 1,
      title: 'Validate prerequisites',
      total: 4,
    });
    expect(a.ok).toBe(true);
    const cfg = (await asOwner('GET', `/api/discovery/${res.threadId}`)).state.config.playbookRun;
    expect(cfg).toMatchObject({ step: 1, stepTitle: 'Validate prerequisites', total: 4 });
    // the same turn may also use the normal Discovery machinery: a question card
    const ask = await call(r, start.chatId, 'session.ask', {
      question: 'Which PRD?',
      options: ['Billing', 'Other'],
    });
    expect(ask.ok).toBe(true);
    await finish(start);
  });

  it('refuses a playbook that is unknown, not approved, a template, or another member’s private one', async () => {
    for (const key of ['nope', 'bmad:prd', 'mine:secret-play']) {
      const res = await rawOwner('POST', '/api/playbooks/run', { key });
      expect(res.status, key).toBe(400);
      expect(JSON.stringify(res.body)).toContain('unknown_playbook');
    }
    // the member's own private playbook runs, on the member's workstation (where its files are)
    const own = await rawMember('POST', '/api/playbooks/run', { key: 'mine:secret-play' });
    expect(own.status).toBe(201);
    const memStart = await mem.waitFor('chat.start', (f) =>
      f.message.includes('aom skill show playbook:mine:secret-play'),
    );
    expect(memStart.message).toContain('"role":"facilitator"');
    // another organization has neither the pack nor the member's playbook
    for (const key of ['bmad:create-epics-and-stories', 'mine:secret-play']) {
      const strange = await w.t.req('POST', '/api/playbooks/run', { cookie: stranger.cookie, body: { key } });
      expect(strange.status, key).toBe(400);
    }
  });

  it('refuses the step verb in a session that runs no playbook, and from a turn that is not the facilitator', async () => {
    const s = (await asOwner('POST', '/api/discovery', { title: 'Plain', idea: 'x' }, 201)).state;
    const start = await nextStart(
      (f) => f.message.includes(s.threadId) || f.message.includes('"role":"facilitator"'),
    );
    const a = await call(r, start.chatId, 'session.step', { step: 1 });
    expect(a.ok).toBe(false);
    expect(a.error).toContain('does not run a playbook');
    await finish(start);
  });
});

describe('who may grant a playbook to an agent', () => {
  let agentId = '';
  it('is off by default and changed by an Owner, an Admin or the agent’s manager only', async () => {
    const agent = await w.hire('Bea', 'ba', 'senior');
    agentId = agent.id;
    const g0 = await asOwner('GET', `/api/agents/${agentId}/playbook-grants`);
    expect(g0).toEqual({ agentId, keys: [], canManage: true });
    // a member who is not the manager: the list says they cannot change it, and a change is refused
    const view = await asMember('GET', `/api/agents/${agentId}/playbook-grants`);
    expect(view.canManage).toBe(false);
    const denied = await rawMember('PUT', `/api/agents/${agentId}/playbook-grants`, {
      key: 'prd',
      granted: true,
    });
    expect([403, 404]).toContain(denied.status);
    expect((await asOwner('GET', `/api/agents/${agentId}/playbook-grants`)).keys).toEqual([]);
    const set = await asOwner('PUT', `/api/agents/${agentId}/playbook-grants`, { key: 'prd', granted: true });
    expect(set.keys).toEqual(['prd']);
    // idempotent, and an event is the audit trail
    await asOwner('PUT', `/api/agents/${agentId}/playbook-grants`, { key: 'prd', granted: true });
    const events = await q(
      `SELECT payload FROM events WHERE type='AgentPlaybookGranted' AND payload->>'agentId'=$1`,
      [agentId],
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ playbookKey: 'prd', granted: true, grantedBy: w.owner.id });
  });

  it('refuses a playbook the granter cannot see, and the member’s private playbook for the Owner', async () => {
    for (const key of ['nope', 'mine:secret-play', 'bmad:prd']) {
      const res = await rawOwner('PUT', `/api/agents/${agentId}/playbook-grants`, { key, granted: true });
      expect(res.status, key).toBe(400);
    }
  });

  it('lets the manager of an agent grant for it', async () => {
    const hired = await rawMember('POST', '/api/agents', {
      name: 'Mem',
      roleKey: 'ba',
      seniority: 'senior',
      workstationId: memberWs,
    });
    // a Member may only hire onto a project they are on; when the hire is not possible here, set the manager directly
    let id = hired.status === 201 ? (hired.body as any).id : '';
    if (!id) {
      id = (await w.hire('Dee', 'ba', 'senior')).id;
      await q('UPDATE agents SET manager_user_id=$2 WHERE id=$1', [id, member.id]);
    }
    const res = await rawMember('PUT', `/api/agents/${id}/playbook-grants`, {
      key: 'brainstorm',
      granted: true,
    });
    expect(res.status).toBe(200);
    expect((res.body as any).keys).toEqual(['brainstorm']);
  });
});

describe('the / menu in a chat with an agent', () => {
  it('offers a private pack only to an agent its owner granted it to', async () => {
    const agent = (await q(`SELECT id FROM agents WHERE name='Bea'`))[0].id;
    const url = `/api/slash-commands?context=chat&agentId=${agent}`;
    expect(keysOf(await asMember('GET', url))).not.toContain('mine:secret-play');
    expect(keysOf(await asMember('GET', '/api/slash-commands?context=chat'))).toContain('mine:secret-play');
    const pack = (await q(`SELECT id FROM packs WHERE name='mine'`))[0].id;
    await q(
      'INSERT INTO pack_agent_grants (pack_id, agent_id, granted_by, granted_at) VALUES ($1,$2,$3,now())',
      [pack, agent, member.id],
    );
    expect(keysOf(await asMember('GET', url))).toContain('mine:secret-play');
    // an organization playbook is there either way
    expect(keysOf(await asMember('GET', url))).toContain('prd');
  });
});

describe('an agent starts a playbook itself', () => {
  let agentId = '';
  let shiftId = '';
  const shiftFor = async (agent: string): Promise<string> => {
    const id = randomUUID();
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at)
       VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now())`,
      [id, w.owner.id, agent, w.workstationId],
    );
    return id;
  };
  it('is refused without a grant, for any playbook', async () => {
    const agent = await w.hire('Cy', 'ba', 'senior');
    agentId = agent.id;
    shiftId = await shiftFor(agentId);
    const res = await call(r, shiftId, 'playbook.run', { key: 'prd' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('nobody granted this agent that playbook');
    expect(
      await q(`SELECT 1 FROM threads WHERE session_config->'playbookRun'->'startedBy'->>'agentId'=$1`, [
        agentId,
      ]),
    ).toHaveLength(0);
  });

  it('starts only the granted playbook, for the manager, with their answers on the desk', async () => {
    await asOwner('PUT', `/api/agents/${agentId}/playbook-grants`, { key: 'brainstorm', granted: true });
    const other = await call(r, shiftId, 'playbook.run', { key: 'prd' });
    expect(other.ok).toBe(false);
    const res = await call(r, shiftId, 'playbook.run', { key: 'brainstorm', input: 'ideas for onboarding' });
    expect(res.ok).toBe(true);
    expect(res.result.message).toContain('needs their answers');
    const t = (await q(`SELECT * FROM threads WHERE id=$1`, [res.result.threadId]))[0];
    const manager = (await q('SELECT manager_user_id FROM agents WHERE id=$1', [agentId]))[0].manager_user_id;
    expect(t.created_by).toBe(manager);
    expect(t.session_config).toMatchObject({
      playbook: 'brainstorm',
      idea: 'ideas for onboarding',
      playbookRun: { startedBy: { kind: 'agent', agentId, agentName: 'Cy' } },
    });
    const desk = await q(`SELECT * FROM desk_items WHERE subject_key=$1`, [
      `playbook_session:${res.result.threadId}`,
    ]);
    expect(desk).toHaveLength(1);
    expect(desk[0].title).toContain('Cy started "');
    // the owner's desk carries the link to the session
    const listed = (await asOwner('GET', '/api/desk')).items.find(
      (i: any) => i.subkind === 'playbook_input_needed',
    );
    expect(listed?.data?.threadId).toBe(res.result.threadId);
    // the facilitator is told who started it
    const start = await nextStart((f) => f.message.includes('"role":"facilitator"'));
    expect(start.message).toContain('The agent Cy started this session');
  });

  it('refuses a fourth session in a day, and a revoked grant', async () => {
    for (let i = 0; i < PLAYBOOK_LIMITS.maxPerDay - 1; i++)
      expect((await call(r, shiftId, 'playbook.run', { key: 'brainstorm' })).ok).toBe(true);
    const over = await call(r, shiftId, 'playbook.run', { key: 'brainstorm' });
    expect(over.ok).toBe(false);
    expect(over.error).toContain('a day');
    await asOwner('PUT', `/api/agents/${agentId}/playbook-grants`, { key: 'brainstorm', granted: false });
    const gone = await call(r, shiftId, 'playbook.run', { key: 'brainstorm' });
    expect(gone.error).toContain('nobody granted');
  });

  it('is not available to a session turn', async () => {
    const s = (await asOwner('POST', '/api/discovery', { title: 'Turn', idea: 'x' }, 201)).state;
    const start = await nextStart(
      (f) => f.message.includes('"role":"facilitator"') && f.threadId === s.threadId,
    );
    const res = await call(r, start.chatId, 'playbook.run', { key: 'prd' });
    expect(res.ok).toBe(false);
    await finish(start);
  });
});

describe('replay and isolation', () => {
  it('rebuilds the grants and the guided sessions to the same rows', async () => {
    const snap = async () => ({
      grants: await q(
        'SELECT agent_id, org_id, playbook_key, granted_by FROM agent_playbook_grants ORDER BY 1,3',
      ),
      threads: await q(
        `SELECT id, title, session_config FROM threads WHERE session_config ? 'playbookRun' ORDER BY id`,
      ),
    });
    const before = JSON.parse(JSON.stringify(await snap()));
    expect(before.grants.length).toBeGreaterThan(0);
    expect(before.threads.length).toBeGreaterThan(2);
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(JSON.parse(JSON.stringify(await snap()))).toEqual(before);
  });

  it('gives another organization no view of the grants, the menu entries or the sessions', async () => {
    const agent = (await q(`SELECT id FROM agents WHERE name='Bea'`))[0].id;
    const res = await w.t.req('GET', `/api/agents/${agent}/playbook-grants`, { cookie: stranger.cookie });
    expect(res.status).toBe(404);
    const put = await w.t.req('PUT', `/api/agents/${agent}/playbook-grants`, {
      cookie: stranger.cookie,
      body: { key: 'prd', granted: true },
    });
    expect([403, 404]).toContain(put.status);
    const list = await w.t.req('GET', '/api/slash-commands', { cookie: stranger.cookie });
    expect(JSON.stringify(list.body)).not.toContain('bmad:');
  });
});
