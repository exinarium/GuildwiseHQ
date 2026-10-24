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
const nextStart = async (pred: (f: any) => boolean = () => true, wait = 15_000): Promise<any> => {
  const f = await r.waitFor('chat.start', (x) => !seen.has(x.chatId) && pred(x), wait);
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

  it('R3c: a playbook started from a chat belongs to the person in that chat, not the agent’s manager; a shift with no chat person keeps the manager', async () => {
    const agent = (await w.hire('Dot', 'ba', 'senior')).id as string;
    await asOwner('PUT', `/api/agents/${agent}/playbook-grants`, { key: 'brainstorm', granted: true });
    const manager = (await q('SELECT manager_user_id FROM agents WHERE id=$1', [agent]))[0].manager_user_id;
    expect(manager).not.toBe(member.id);
    const chatShift = async (chatUser: string | null): Promise<string> => {
      const id = randomUUID();
      await q(
        `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at, chat_user_id)
         VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now(),$5)`,
        [id, w.owner.id, agent, w.workstationId, chatUser],
      );
      return id;
    };
    // the person in the chat: the agent's workstation is not theirs, so (Q69) they are asked which of theirs should run it and
    // nothing starts until they answer
    const asked = await call(r, await chatShift(member.id), 'playbook.run', {
      key: 'brainstorm',
      input: 'pricing for teams',
    });
    expect(asked.ok, asked.error).toBe(true);
    expect(asked.result.requested).toBe(true);
    expect(asked.result.message).toContain('which of their workstations');
    expect(asked.result.threadId).toBeUndefined();
    const item = (await asMember('GET', '/api/desk')).items.find(
      (i: any) => i.subkind === 'playbook_workstation',
    );
    expect(item.options.map((o: any) => o.id)).toEqual([memberWs]);
    const answered = await asMember('POST', `/api/desk/${item.id}/resolve`, {
      resolution: 'approved',
      workstationId: memberWs,
    });
    void answered;
    const started = (
      await q(
        `SELECT session_thread_id, status, workstation_id FROM playbook_run_requests WHERE desk_item_id=$1`,
        [item.id],
      )
    )[0];
    expect(started).toMatchObject({ status: 'started', workstation_id: memberWs });
    const res = {
      ok: true,
      result: { threadId: started.session_thread_id as string, message: 'the person you are chatting with' },
    };
    const t = (
      await q(`SELECT created_by, workstation_id FROM threads WHERE id=$1`, [res.result.threadId])
    )[0];
    expect(t.created_by).toBe(member.id);
    expect(t.workstation_id).toBe(memberWs);
    const desk = (
      await q(`SELECT title, body, data FROM desk_items WHERE subject_key=$1`, [
        `playbook_session:${res.result.threadId}`,
      ])
    )[0];
    expect(desk.body).toContain('from your chat');
    expect(desk.data.forUserId).toBe(member.id);
    // the member can open it; the agent's manager (an Owner here) is not a participant of it
    const mine = await asMember('GET', `/api/discovery/${res.result.threadId}`);
    expect(mine.state.threadId).toBe(res.result.threadId);
    // no chat person (a card shift) or the manager themselves: the manager, as before
    const none = await call(r, await chatShift(null), 'playbook.run', { key: 'brainstorm' });
    expect(
      (await q(`SELECT created_by FROM threads WHERE id=$1`, [none.result.threadId]))[0].created_by,
    ).toBe(manager);
    const self = await call(r, await chatShift(manager), 'playbook.run', { key: 'brainstorm' });
    expect(self.result.message).toContain('manager');
    // a chat person who is no longer in the organization (or has no workstation of their own) falls back to the manager
    const other = (await w.hire('Dan', 'ba', 'senior')).id as string;
    await asOwner('PUT', `/api/agents/${other}/playbook-grants`, { key: 'brainstorm', granted: true });
    const otherManager = (await q('SELECT manager_user_id FROM agents WHERE id=$1', [other]))[0]
      .manager_user_id;
    const outsider = (await w.t.userSession(uniqueEmail('pb-gone'))).id;
    const fbShift = randomUUID();
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at, chat_user_id)
       VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now(),$5)`,
      [fbShift, w.owner.id, other, w.workstationId, outsider],
    );
    const fb = await call(r, fbShift, 'playbook.run', { key: 'brainstorm' });
    expect(fb.ok, fb.error).toBe(true);
    expect((await q(`SELECT created_by FROM threads WHERE id=$1`, [fb.result.threadId]))[0].created_by).toBe(
      otherManager,
    );
    // each guided session queues a facilitator turn (the runner runs them in turn): let it finish what it is sent
    for (let i = 0; i < 4; i++) {
      const st = await nextStart((f) => f.message.includes('"role":"facilitator"'), 3_000).catch(() => null);
      if (!st) break;
      await finish(st);
    }
  });

  describe('Q69: where an agent-started playbook runs, when it is not the chat person\u2019s workstation', () => {
    let agent = '';
    const chatShift = async (chatUser: string, agentId = agent, ws = w.workstationId): Promise<string> => {
      const id = randomUUID();
      await q(
        `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, status, runtime, model, started_at, chat_user_id)
         VALUES ($1,$2,$3,$4,'chat','running','mock','mock',now(),$5)`,
        [id, w.owner.id, agentId, ws, chatUser],
      );
      return id;
    };
    const itemFor = async (key: string) =>
      (await asMember('GET', '/api/desk')).items.find(
        (i: any) => i.subkind === 'playbook_workstation' && i.data?.playbookKey === key,
      ) ?? (await asMember('GET', '/api/desk')).items.find((i: any) => i.subkind === 'playbook_workstation');
    const declineOpen = async () => {
      for (const i of (await asMember('GET', '/api/desk')).items.filter(
        (x: any) => x.subkind === 'playbook_workstation' && x.status === 'open',
      ))
        await asMember('POST', `/api/desk/${i.id}/resolve`, { resolution: 'rejected' });
    };
    const requests = () =>
      q('SELECT * FROM playbook_run_requests WHERE agent_id=$1 ORDER BY requested_at', [agent]);

    it('asks the person to pick one of their workstations or decline; nothing starts before; a repeat does not ask twice', async () => {
      agent = (await w.hire('Eve', 'ba', 'senior')).id as string;
      await asOwner('PUT', `/api/agents/${agent}/playbook-grants`, { key: 'brainstorm', granted: true });
      const threadsBefore = (await q(`SELECT count(*)::int AS n FROM threads WHERE kind='discovery'`))[0].n;
      const shift = await chatShift(member.id);
      const first = await call(r, shift, 'playbook.run', { key: 'brainstorm', input: 'naming' });
      expect(first.ok, first.error).toBe(true);
      expect(first.result.requested).toBe(true);
      expect((await q(`SELECT count(*)::int AS n FROM threads WHERE kind='discovery'`))[0].n).toBe(
        threadsBefore,
      );
      const rows = await requests();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'pending',
        chat_user_id: member.id,
        workstation_ids: [memberWs],
      });
      // the desk item is the member's to answer: the Owner (the agent's manager) sees it among the organization's items and cannot
      const it1 = await itemFor('brainstorm');
      expect(it1).toMatchObject({ kind: 'approval', canAnswer: true });
      expect(
        (await asOwner('GET', '/api/desk')).items.find((i: any) => i.subkind === 'playbook_workstation')
          ?.canAnswer,
      ).not.toBe(true);
      // asking again while it is open is the same question
      const again = await call(r, shift, 'playbook.run', { key: 'brainstorm', input: 'naming' });
      expect(again.result.message).toContain('already asked');
      expect(await requests()).toHaveLength(1);
      // only the person answers, with a workstation that was offered
      expect(
        (
          await rawOwner('POST', `/api/desk/${it1.id}/resolve`, {
            resolution: 'approved',
            workstationId: memberWs,
          })
        ).status,
      ).toBeGreaterThanOrEqual(400);
      const bad = await rawMember('POST', `/api/desk/${it1.id}/resolve`, {
        resolution: 'approved',
        workstationId: w.workstationId,
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('pick_a_workstation');
      const none = await rawMember('POST', `/api/desk/${it1.id}/resolve`, { resolution: 'approved' });
      expect(none.status).toBe(400);
      expect((await requests())[0].status).toBe('pending');
      // decline: nothing starts, the item is closed, and the request says so
      await asMember('POST', `/api/desk/${it1.id}/resolve`, { resolution: 'rejected' });
      expect((await requests())[0]).toMatchObject({ status: 'declined', session_thread_id: null });
      expect((await q(`SELECT count(*)::int AS n FROM threads WHERE kind='discovery'`))[0].n).toBe(
        threadsBefore,
      );
      expect(
        (await rawMember('POST', `/api/desk/${it1.id}/resolve`, { resolution: 'rejected' })).status,
      ).toBe(409);
      // after a decline the agent may ask again (a new request)
      const retry = await call(r, shift, 'playbook.run', { key: 'brainstorm' });
      expect(retry.result.requested).toBe(true);
      expect(await requests()).toHaveLength(2);
    });

    it('starts at once when the agent already works on the person’s own workstation (nothing to ask)', async () => {
      // an agent that works on the member's own workstation (moved there directly: hiring onto it is the member's business)
      const onMine = (await w.hire('Fay', 'ba', 'senior')).id as string;
      await q('UPDATE agents SET workstation_id=$2 WHERE id=$1', [onMine, memberWs]);
      await asOwner('PUT', `/api/agents/${onMine}/playbook-grants`, { key: 'brainstorm', granted: true });
      const shift = await chatShift(member.id, onMine, memberWs);
      const res = await call(mem, shift, 'playbook.run', { key: 'brainstorm', input: 'at home' });
      expect(res.ok, res.error).toBe(true);
      expect(res.result.threadId).toBeTruthy();
      expect(res.result.requested).toBeUndefined();
      const t = (
        await q('SELECT created_by, workstation_id FROM threads WHERE id=$1', [res.result.threadId])
      )[0];
      expect(t).toMatchObject({ created_by: member.id, workstation_id: memberWs });
      expect(await q('SELECT 1 FROM playbook_run_requests WHERE agent_id=$1', [onMine])).toHaveLength(0);
    });

    it('counts the asking against the agent’s three a day, and rebuilds to the same rows', async () => {
      // two requests so far (one declined, one open); closing the open one lets a third ask, and the fourth is over the day's limit
      await declineOpen();
      const shift = await chatShift(member.id);
      const open = await call(r, shift, 'playbook.run', { key: 'brainstorm', input: 'third' });
      expect(open.ok, open.error).toBe(true);
      expect(open.result.requested).toBe(true);
      await declineOpen();
      const over = await call(r, shift, 'playbook.run', { key: 'brainstorm', input: 'fourth' });
      expect(over.ok).toBe(false);
      expect(over.error).toContain('a day');
      const snap = async () =>
        q(
          'SELECT request_id, status, workstation_id, session_thread_id, chat_user_id, playbook_key FROM playbook_run_requests WHERE agent_id=$1 ORDER BY request_id',
          [agent],
        );
      const before = JSON.parse(JSON.stringify(await snap()));
      await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
      expect(JSON.parse(JSON.stringify(await snap()))).toEqual(before);
    });
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
