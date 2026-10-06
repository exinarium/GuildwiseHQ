import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Browser } from './helpers/browser.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { designer, roleInput, workflowInput } from './helpers/designer.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { approve, cardRow, handoff, pipeline } from './helpers/pipeline.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// Designing with the BA: the manager describes the need in a chat, the BA drafts through `aom org ...`, the server
// validates, the owner approves on the desk; and the owner's extensions reach the agents' shift briefs.
let w: World;
let r: FakeRunner;
let b: Browser;
let d: ReturnType<typeof designer>;
beforeAll(async () => {
  w = await createWorld();
  d = designer(w);
  r = await w.connectRunner();
  b = await Browser.open(w.baseUrl, w.owner.cookie);
  await b.hello();
});
afterAll(async () => {
  b?.close();
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

async function openChat(agentName: string, cookie = w.owner.cookie, browser = b) {
  const agent = (await q('SELECT id FROM agents WHERE name=$1', [agentName]))[0]!;
  const chat = (await ok<any>(w.t.req('POST', '/api/chats', { cookie, body: { agentId: agent.id } }), 201))
    .chat;
  const from = r.received.length;
  browser.send({
    type: 'chat.send',
    threadId: chat.threadId,
    body: 'We need a support pipeline',
    clientMsgId: randomUUID(),
  });
  return (await r.waitFor('chat.start', (f) => f.threadId === chat.threadId, 15_000, from)) as any;
}
async function rpc(chatId: string, method: string, params: Record<string, unknown> = {}) {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId: chatId, method, params });
  return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
}

describe('the BA designs with the manager', () => {
  let chatId: string;
  beforeAll(async () => {
    await w.hire('Ben', 'ba', 'senior');
    await w.hire('Bea', 'builder', 'junior');
    await w.hire('Rex', 'reviewer', 'senior');
    await ok(w.t.req('POST', '/api/departments', { cookie: w.owner.cookie, body: { name: 'support' } }), 201);
    chatId = (await openChat('Ben')).chatId;
  });

  it('drafts a role and a workflow, answers its own validation errors, and nothing is available before approval', async () => {
    const cat = await rpc(chatId, 'org.catalogue');
    expect(cat.ok).toBe(true);
    expect(cat.result.message).toMatch(/builder \(built in\)/);

    // The workflow names a role that is not drafted yet: the BA is told what is wrong.
    const wf = workflowInput('support') as any;
    const first = await rpc(chatId, 'org.workflow.draft', { definition: wf });
    expect(first.ok).toBe(true);
    expect(first.result.message).toMatch(/unknown_role/);
    const early = await rpc(chatId, 'org.submit', { key: 'support', kind: 'workflow' });
    expect(early.ok).toBe(false);
    expect(early.error).toMatch(/cannot submit/);

    for (const role of [
      roleInput('triager', [['support', 'triage']]),
      roleInput('responder', [['support', 'resolve']]),
    ]) {
      const res = await rpc(chatId, 'org.role.draft', { definition: role });
      expect(res.ok).toBe(true);
      expect(res.result.message).toMatch(/No issues/);
    }
    // Drafting again edits the open draft (the BA iterates) rather than failing.
    const again = await rpc(chatId, 'org.role.draft', {
      definition: roleInput('triager', [['support', 'triage']], { purpose: 'Sorts tickets.' }),
    });
    expect(again.ok).toBe(true);
    expect((await q(`SELECT count(*)::int AS n FROM role_definitions WHERE key='triager'`))[0]!.n).toBe(1);
    expect(
      (await q(`SELECT definition FROM role_definitions WHERE key='triager'`))[0]!.definition.purpose,
    ).toBe('Sorts tickets.');

    await rpc(chatId, 'org.workflow.draft', { definition: wf });
    expect((await rpc(chatId, 'org.validate', { key: 'support' })).result.valid).toBe(true);
    for (const [key, kind] of [
      ['triager', 'role'],
      ['responder', 'role'],
      ['support', 'workflow'],
    ] as const) {
      const s = await rpc(chatId, 'org.submit', { key, kind });
      expect(s.ok, `${key}: ${s.error}`).toBe(true);
    }
    // On the desk, drafted by the BA; not available yet.
    const items = (
      (await ok<any>(w.t.req('GET', '/api/desk', { cookie: w.owner.cookie }))).items as any[]
    ).filter((i) => i.subkind === 'definition');
    expect(items.map((i) => i.title).sort()).toEqual([
      'Approve role "Responder" (v1)',
      'Approve role "Triager" (v1)',
      'Approve workflow "Support triage" (v1)',
    ]);
    expect(items[0].askedBy ?? items[0].agentName).toBeTruthy();
    expect(
      (await ok<any>(w.t.req('GET', '/api/workflows', { cookie: w.owner.cookie }))).workflows.map(
        (x: any) => x.definition.key,
      ),
    ).not.toContain('support');
    const rows = await q(`SELECT drafted_by_kind FROM role_definitions WHERE key='triager'`);
    expect(rows[0]!.drafted_by_kind).toBe('agent');

    // The workflow cannot be approved before its roles; then everything becomes available.
    const wfItem = items.find((i) => i.title.startsWith('Approve workflow'));
    expect((await d.resolve(wfItem.id, 'approved')).status).toBe(422);
    for (const i of items.filter((i) => i.title.startsWith('Approve role')))
      expect((await d.resolve(i.id, 'approved')).status).toBe(200);
    expect((await d.resolve(wfItem.id, 'approved')).status).toBe(200);
    expect(
      (await ok<any>(w.t.req('GET', '/api/workflows', { cookie: w.owner.cookie }))).workflows.map(
        (x: any) => x.definition.key,
      ),
    ).toContain('support');
  });

  it('refuses a department that does not exist and a role that claims built-in stages', async () => {
    const res = await rpc(chatId, 'org.role.draft', {
      definition: roleInput('sneaky', [['code', 'review']], { department: 'nowhere' }),
    });
    expect(res.ok).toBe(true);
    expect(res.result.message).toMatch(/claims_builtin_workflow/);
    expect(res.result.message).toMatch(/unknown_department/);
    expect((await rpc(chatId, 'org.submit', { key: 'sneaky', kind: 'role' })).ok).toBe(false);
    expect(
      (await rpc(chatId, 'org.role.draft', { definition: roleInput('builder', [['x', '*']]) })).error,
    ).toMatch(/built-in/);
    const dep = await rpc(chatId, 'org.department', { name: 'marketing' });
    expect(dep.ok).toBe(true);
    expect(
      (await ok<any>(w.t.req('GET', '/api/departments', { cookie: w.owner.cookie }))).departments.map(
        (x: any) => x.name,
      ),
    ).toContain('marketing');
  });

  it('only the BA in a chat with the organization owner can design', async () => {
    // A builder's chat.
    const builderChat = await openChat('Bea');
    const denied = await rpc(builderChat.chatId, 'org.catalogue');
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/business analyst/);
    // An additional manager talking to the owner's BA (project-scoped agent) cannot change the owner's catalogue.
    const m = await addMember(w, 'chatty');
    const pam = await ok<any>(
      w.t.req('POST', '/api/agents', {
        cookie: w.owner.cookie,
        body: {
          name: 'Pam',
          roleKey: 'ba',
          seniority: 'senior',
          workstationId: w.workstationId,
          projectId: w.projectId,
          runtime: 'mock',
          model: 'mock',
        },
      }),
      201,
    );
    const mb = await Browser.open(w.baseUrl, m.cookie);
    await mb.hello();
    const chat = (
      await ok<any>(
        w.t.req('POST', '/api/chats', {
          cookie: m.cookie,
          body: { agentId: pam.id, projectId: w.projectId },
        }),
        201,
      )
    ).chat;
    const from = r.received.length;
    mb.send({
      type: 'chat.send',
      threadId: chat.threadId,
      body: 'design something',
      clientMsgId: randomUUID(),
    });
    const start = (await r.waitFor('chat.start', (f) => f.threadId === chat.threadId, 15_000, from)) as any;
    const res = await rpc(start.chatId, 'org.role.draft', { definition: roleInput('mine', [['x', '*']]) });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Owner and Admins/);
    mb.close();
  });
});

describe("the owner's extensions and standing orders reach the agents' shifts", () => {
  it('adds instructions, skills and standing orders to the brief; core rules stay exactly as shipped', async () => {
    const res = await d.req('PUT', '/api/roles/builder/extensions', {
      instructions: 'Prefer small commits.',
      skills: ['git-hygiene'],
      standingOrders: ['Never touch the legacy folder.'],
    });
    expect(res.status).toBe(200);
    const card = await w.card();
    const p = pipeline(w, r);
    const { start } = await p.run('Bea', handoff());
    expect(start.brief.card.ref).toBe(card.ref);
    expect(start.brief.role.extensions).toBe('Prefer small commits.');
    expect(start.brief.role.skills).toContain('git-hygiene');
    expect(start.brief.standingOrders.map((s: any) => s.body)).toContain('Never touch the legacy folder.');
    const shipped = (await ok<any>(w.t.req('GET', '/api/roles', { cookie: w.owner.cookie }))).roles.find(
      (x: any) => x.definition.key === 'builder',
    );
    expect(start.brief.role.coreRules).toEqual(shipped.definition.coreRules);
    expect(shipped.extensions).toMatchObject({ skills: ['git-hygiene'] });
    await p.run('Rex', approve());
    expect(await cardRow(card.id)).toMatchObject({ stage: 'test' });
    await until(async () => true);
  });
});
