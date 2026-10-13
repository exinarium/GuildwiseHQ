import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember, connectMemberRunner, hireFor } from './helpers/members.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await hangUp();
  await w.t.close();
  await closeAdminPool();
});

const post = (url: string, body: unknown, status = 200, cookie = w.owner.cookie) =>
  ok<any>(w.t.req('POST', url, { cookie, body }), status);
const get = (url: string) => ok<any>(w.t.req('GET', url, { cookie: w.owner.cookie }));
let baseSeq = '0';
/** Events of a type appended since this test's setup. */
const eventsOfType = async (type: string) =>
  (await q('SELECT payload, actor_kind, actor_id FROM events WHERE type=$1 AND seq > $2 ORDER BY seq', [
    type,
    baseSeq,
  ])) as any[];

async function hangUp() {
  if (!r) return;
  r.close();
  await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'runner offline');
  // ... and has recorded the disconnect (a late WorkstationDisconnected would mark the next runner offline)
  await until(
    async () => !(await q('SELECT connected FROM workstations WHERE id=$1', [w.workstationId]))[0]?.connected,
    3000,
    'disconnect recorded',
  );
}

async function setup(hireBa = true) {
  await hangUp();
  await freshState();
  await q('TRUNCATE intakes, intake_cards CASCADE');
  baseSeq = String((await q('SELECT COALESCE(max(seq),0) AS s FROM events'))[0]!.s);
  r = await w.connectRunner();
  if (hireBa) await w.hire('Ben', 'ba', 'senior');
}

/** Opens an intake and returns it with the runner's `chat.start` for the first message. */
async function openIntake(note = 'ABC-123', extra: Record<string, unknown> = {}) {
  const from = r.received.length;
  const { intake } = await post('/api/intakes', { note, ...extra }, 201);
  const start = (await r.waitFor('chat.start', (f) => f.threadId === intake.threadId, 15_000, from)) as any;
  return { intake, start };
}

/** What the BA's `aom` verb does: an rpc from the intake chat. */
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
const finishChat = async (start: any, text = 'ok') => {
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: text,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  await until(async () => !w.t.app.ctx.services.chat.threadOfChat(start.chatId), 3000, 'chat done');
};

const draft = (over: Record<string, unknown> = {}) => ({
  title: 'Add the login page',
  cardType: 'feature',
  completionAction: 'pr',
  docsNeeded: false,
  repo: 'toy',
  externalRef: 'ABC-123',
  fields: {
    context: 'ABC-123: users cannot sign in.',
    requirements: 'A login form that posts to /api/auth/login.',
    acceptanceCriteria: ['The form validates the email', 'Errors are shown inline'],
    affectedAreas: 'apps/web/src/pages/Login.tsx',
    constraints: 'No new dependencies.',
    testPlan: 'Unit-test the validation.',
  },
  ...over,
});

describe('starting an intake', () => {
  it('opens a chat with the BA: IntakeStarted, an intake thread, and the BA gets the ticket context', async () => {
    await setup();
    const { intake, start } = await openIntake('Please look at ABC-123 today');
    expect(intake).toMatchObject({
      externalSystem: 'jira',
      externalKey: 'ABC-123',
      status: 'open',
      baAgentName: 'Ben',
      workstationOnline: true,
      cards: [],
      mappedProjectKey: null,
    });
    const ev = (await eventsOfType('IntakeStarted'))[0].payload;
    expect(ev).toMatchObject({
      intakeId: intake.id,
      threadId: intake.threadId,
      externalSystem: 'jira',
      externalKey: 'ABC-123',
    });
    const thread = (await q('SELECT kind, agent_id, org_id FROM threads WHERE id=$1', [intake.threadId]))[0]!;
    expect(thread).toMatchObject({ kind: 'intake', org_id: w.owner.id });
    // the first message is the manager's; the BA is told about the ticket and the projects it may map to
    expect(start.message).toBe('Please look at ABC-123 today');
    expect(start.agent.name).toBe('Ben');
    expect(start.context.intake).toMatchObject({
      intakeId: intake.id,
      externalSystem: 'jira',
      externalKey: 'ABC-123',
      projects: [{ key: 'TOY', name: 'Toy', repos: ['toy'] }],
      cards: [],
    });
    const msgs = (await get(`/api/threads/${intake.threadId}/messages`)).messages;
    expect(msgs[0]).toMatchObject({ authorKind: 'user', body: 'Please look at ABC-123 today' });
    // intake chats are not in the chat list
    expect((await get('/api/chats')).chats).toHaveLength(0);
    expect((await get('/api/intakes')).intakes.map((i: any) => i.id)).toEqual([intake.id]);
    expect((await get(`/api/intakes/${intake.id}`)).intake.id).toBe(intake.id);
  });

  it('reads a GitHub issue reference and an explicit key, and works without a ticket', async () => {
    await setup();
    const a = await openIntake('https://github.com/acme/toy/issues/12 please');
    expect(a.intake).toMatchObject({ externalSystem: 'github', externalKey: 'acme/toy#12' });
    await finishChat(a.start);
    const b = await openIntake('We need dark mode', { externalSystem: 'jira', externalKey: 'WEB-9' });
    expect(b.intake).toMatchObject({ externalSystem: 'jira', externalKey: 'WEB-9' });
    await finishChat(b.start);
    const c = await openIntake('We need dark mode');
    expect(c.intake).toMatchObject({ externalSystem: null, externalKey: null });
  });

  it('needs a BA with an online workstation; nothing is queued silently', async () => {
    await setup(false);
    const none = await w.t.req('POST', '/api/intakes', { cookie: w.owner.cookie, body: { note: 'ABC-1' } });
    expect(none.status).toBe(409);
    expect(none.body.error.code).toBe('no_ba');
    await w.hire('Ben', 'ba', 'senior');
    await hangUp();
    const off = await w.t.req('POST', '/api/intakes', { cookie: w.owner.cookie, body: { note: 'ABC-1' } });
    expect(off.status).toBe(409);
    expect(off.body.error.code).toBe('ba_offline');
    expect(await q('SELECT 1 FROM intakes')).toHaveLength(0);
    expect((await w.t.req('POST', '/api/intakes', { body: { note: 'x' } })).status).toBe(401);
  });
});

describe('the BA drafts cards in the intake chat', () => {
  it('maps the ticket, drafts a card with every required field and a completion action, and specifies it', async () => {
    await setup();
    const { intake, start } = await openIntake();
    // cards need a project first
    const early = await rpc(start.chatId, 'card.create', draft());
    expect(early.ok).toBe(false);
    expect(early.error).toMatch(/map the ticket to a project first/);

    const map = await rpc(start.chatId, 'intake.map', { project: 'toy' });
    expect(map).toMatchObject({ ok: true, result: { project: 'TOY', repos: ['toy'] } });
    expect((await get(`/api/intakes/${intake.id}`)).intake).toMatchObject({
      status: 'mapped',
      mappedProjectKey: 'TOY',
    });

    const created = await rpc(start.chatId, 'card.create', draft());
    expect(created).toMatchObject({ ok: true, result: { ref: 'TOY-1', missing: [] } });
    const card = (await q(`SELECT * FROM cards WHERE ref='TOY-1'`))[0]!;
    expect(card).toMatchObject({
      origin: 'intake',
      status: 'draft',
      stage: 'spec',
      completion_action: 'pr',
      owner_user_id: w.owner.id,
      repo_id: w.repoId,
    });
    // the ticket key is stored on the card
    expect(card.fields).toMatchObject({ externalRef: 'ABC-123', testPlan: 'Unit-test the validation.' });
    const createdEv = (
      await q(
        `SELECT actor_kind, actor_id, payload FROM events WHERE type='CardCreated' ORDER BY seq DESC LIMIT 1`,
      )
    )[0]!;
    expect(createdEv.actor_kind).toBe('agent');
    expect(createdEv.payload.origin).toBe('intake');

    const spec = await rpc(start.chatId, 'card.specify', { ref: 'TOY-1' });
    expect(spec).toMatchObject({ ok: true, result: { ref: 'TOY-1', stage: 'build', status: 'queued' } });
    expect((await eventsOfType('CardSpecified')).map((e) => e.payload.cardId)).toContain(card.id);
    expect((await eventsOfType('TicketMapped')).some((e) => e.payload.cardId === card.id)).toBe(true);

    const view = (await get(`/api/intakes/${intake.id}`)).intake;
    expect(view.cards).toMatchObject([
      { ref: 'TOY-1', title: 'Add the login page', stage: 'build', status: 'queued', projectKey: 'TOY' },
    ]);
    const thread = (await get(`/api/threads/${intake.threadId}/messages`)).messages
      .map((m: any) => m.body)
      .join('\n');
    expect(thread).toMatch(/drafted TOY-1/);
    // the next message to the BA carries the cards created so far
    await finishChat(start);
    const from = r.received.length;
    await w.t.app.ctx.services.chat.send(w.owner.id, {
      threadId: intake.threadId,
      body: 'more?',
      clientMsgId: 'c2',
    });
    const again = (await r.waitFor('chat.start', (f) => f.threadId === intake.threadId, 15_000, from)) as any;
    expect(again.context.intake).toMatchObject({
      mappedProjectKey: 'TOY',
      cards: [{ ref: 'TOY-1', status: 'queued' }],
    });
  });

  it('validates cards: a bad draft is refused, an incomplete one stays a draft until the missing fields are filled in', async () => {
    await setup();
    const { start } = await openIntake();
    await rpc(start.chatId, 'intake.map', { project: 'TOY' });
    const noTitle = await rpc(start.chatId, 'card.create', { fields: {} });
    expect(noTitle.ok).toBe(false);
    expect(noTitle.error).toMatch(/title/);
    const badAction = await rpc(start.chatId, 'card.create', draft({ completionAction: 'ship' }));
    expect(badAction.ok).toBe(false);
    const badRepo = await rpc(start.chatId, 'card.create', draft({ repo: 'nope' }));
    expect(badRepo.error).toMatch(/unknown repo 'nope'/);
    const wrongProject = await rpc(start.chatId, 'card.create', draft({ project: 'OTHER' }));
    expect(wrongProject.error).toMatch(/mapped to TOY/);
    const badDep = await rpc(start.chatId, 'card.create', draft({ dependencies: ['TOY-99'] }));
    expect(badDep.error).toMatch(/unknown dependency/);
    expect(await q('SELECT 1 FROM cards')).toHaveLength(0);

    const partial = draft();
    (partial.fields as Record<string, unknown>).testPlan = undefined;
    const incomplete = await rpc(start.chatId, 'card.create', { ...partial, completionAction: undefined });
    expect(incomplete.ok).toBe(true);
    expect(incomplete.result.missing.sort()).toEqual(['testPlan']); // the completion action follows the project default
    // The BA left it out: nothing is stored on the card, so it inherits the project's setting.
    expect((await q('SELECT completion_action FROM cards'))[0]).toMatchObject({ completion_action: null });
    const refused = await rpc(start.chatId, 'card.specify', { ref: incomplete.result.ref });
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/missing: .*testPlan/);
    expect((await q('SELECT status FROM cards'))[0]).toMatchObject({ status: 'draft' });
    expect(await eventsOfType('CardSpecified')).toHaveLength(0);

    const fixed = await rpc(start.chatId, 'card.update', {
      ref: incomplete.result.ref,
      completionAction: 'push_branch',
      fields: { testPlan: 'Run it.' },
    });
    expect(fixed).toMatchObject({ ok: true, result: { missing: [] } });
    const ok2 = await rpc(start.chatId, 'card.specify', { ref: incomplete.result.ref });
    expect(ok2).toMatchObject({ ok: true, result: { stage: 'build' } });
    // a specified card can no longer be changed by the BA through the intake
    const late = await rpc(start.chatId, 'card.update', { ref: incomplete.result.ref, title: 'new' });
    expect(late.error).toMatch(/only drafts/);
  });

  it('builds a dependency graph and refuses a cycle', async () => {
    await setup();
    const { start } = await openIntake();
    await rpc(start.chatId, 'intake.map', { project: 'TOY' });
    const a = (await rpc(start.chatId, 'card.create', draft({ title: 'A' }))).result;
    const b = (await rpc(start.chatId, 'card.create', draft({ title: 'B', dependencies: [a.ref] }))).result;
    expect(
      (await q('SELECT depends_on_card_id FROM card_dependencies WHERE card_id=$1', [b.id]))[0]!
        .depends_on_card_id,
    ).toBe(a.id);
    // A on B would close the loop
    await rpc(start.chatId, 'card.update', { ref: a.ref, dependencies: [b.ref] });
    const cyc = await rpc(start.chatId, 'card.specify', { ref: a.ref });
    expect(cyc.ok).toBe(false);
    expect(cyc.error).toMatch(/depends on itself/);
    await rpc(start.chatId, 'card.update', { ref: a.ref, dependencies: [] });
    expect((await rpc(start.chatId, 'card.specify', { ref: a.ref })).ok).toBe(true);
    expect((await rpc(start.chatId, 'card.specify', { ref: b.ref })).ok).toBe(true);
  });

  it('cannot touch cards of other intakes, or run from a chat that is not an intake', async () => {
    await setup();
    const one = await openIntake('ABC-1');
    await rpc(one.start.chatId, 'intake.map', { project: 'TOY' });
    const mine = (await rpc(one.start.chatId, 'card.create', draft())).result;
    await finishChat(one.start);
    const two = await openIntake('ABC-2');
    await rpc(two.start.chatId, 'intake.map', { project: 'TOY' });
    const steal = await rpc(two.start.chatId, 'card.update', { ref: mine.ref, title: 'mine now' });
    expect(steal.ok).toBe(false);
    expect(steal.error).toMatch(/not a card of this intake/);
    // a plain chat with another agent cannot use the verbs
    await finishChat(two.start);
    const agent = await w.hire('Una', 'builder', 'senior');
    const chat = (await post('/api/chats', { agentId: agent.id }, 201)).chat;
    const from = r.received.length;
    w.t.app.ctx.services.chat.send(w.owner.id, { threadId: chat.threadId, body: 'hi', clientMsgId: 'c' });
    const cs = (await r.waitFor('chat.start', (f) => f.threadId === chat.threadId, 15_000, from)) as any;
    const denied = await rpc(cs.chatId, 'intake.map', { project: 'TOY' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/only the BA can do this/);
  });
});

describe('unmapped tickets', () => {
  it('become a desk question; the answer maps the intake and the BA is told to continue', async () => {
    await setup();
    const { intake, start } = await openIntake('ABC-777');
    const asked = await rpc(start.chatId, 'intake.unmapped', {
      note: 'ABC is not the key of any project, and no repo mentions it',
    });
    expect(asked.ok).toBe(true);
    const deskItemId = asked.result.deskItemId as string;
    const evs = await eventsOfType('TicketMapped');
    expect(evs[0].payload).toMatchObject({ intakeId: intake.id, unmapped: true, deskItemId });
    expect((await get(`/api/intakes/${intake.id}`)).intake).toMatchObject({
      status: 'unmapped',
      mappingDeskItemId: deskItemId,
    });

    const item = (await get('/api/desk')).items.find((i: any) => i.id === deskItemId);
    expect(item).toMatchObject({
      kind: 'question',
      subkind: 'unmapped_ticket',
      title: 'Which project does ABC-777 belong to?',
      blocking: false,
      routedTo: 'manager',
      intakeId: intake.id,
      askedBy: { agentName: 'Ben', role: 'ba' },
    });
    expect(item.options).toHaveLength(1);
    expect(item.options[0]).toMatchObject({ label: 'TOY: Toy' });
    // no card can be drafted before the manager answered
    expect((await rpc(start.chatId, 'card.create', draft())).ok).toBe(false);
    expect((await rpc(start.chatId, 'intake.map', { project: 'TOY' })).error).toMatch(/wait for the answer/);
    expect((await rpc(start.chatId, 'intake.unmapped', { note: 'again' })).error).toMatch(/already asked/);

    // an answer needs a project
    const noOption = await w.t.req('POST', `/api/desk/${deskItemId}/answer`, {
      cookie: w.owner.cookie,
      body: { answer: 'toy' },
    });
    expect(noOption.status).toBe(400);
    // the manager answers while the BA is still finishing the turn in which it asked
    const from = r.received.length;
    await post(`/api/desk/${deskItemId}/answer`, {
      answer: 'TOY: Toy',
      optionId: item.options[0].id,
      ledger: { scope: 'decision', title: 'ABC tickets belong to TOY' },
    });
    const mapped = (await eventsOfType('TicketMapped')).at(-1)!.payload;
    expect(mapped).toMatchObject({ intakeId: intake.id, unmapped: false, projectId: w.projectId });
    expect((await get(`/api/intakes/${intake.id}`)).intake).toMatchObject({
      status: 'mapped',
      mappedProjectKey: 'TOY',
    });
    // the BA is told, in the same chat, to continue: once its turn is over
    // (the continuation waits for the turn to end: while the conversation is busy nothing can be sent)
    expect(w.t.app.ctx.services.chat.isBusy(intake.threadId)).toBe(true);
    expect(r.received.slice(from).some((f) => f.type === 'chat.start')).toBe(false);
    await finishChat(start);
    const next = (await r.waitFor('chat.start', (f) => f.threadId === intake.threadId, 15_000, from)) as any;
    expect(next.message).toMatch(/mapped ABC-777 to project TOY/);
    expect(next.context.intake.mappedProjectKey).toBe('TOY');
    // and the decision is in the ledger for the next ticket
    expect((await q(`SELECT title FROM ledger_entries`)).map((e) => e.title)).toContain(
      'ABC tickets belong to TOY',
    );
    // now cards can be drafted
    expect((await rpc(next.chatId, 'card.create', draft())).ok).toBe(true);
  });
});

/** A chat started from the desk (not an intake): the first message, with the runner's `chat.start`. */
async function openDeskChat(
  agentId: string,
  extra: Record<string, unknown> = {},
  runner = r,
  cookie = w.owner.cookie,
  userId = w.owner.id,
) {
  const chat = (await post('/api/chats', { agentId, ...extra }, 201, cookie)).chat;
  const from = runner.received.length;
  w.t.app.ctx.services.chat.send(userId, {
    threadId: chat.threadId,
    body: 'Spec this',
    clientMsgId: randomUUID(),
  });
  const start = (await runner.waitFor(
    'chat.start',
    (f) => f.threadId === chat.threadId,
    15_000,
    from,
  )) as any;
  return { chat, start };
}

describe('card creation from a BA chat started on the desk', () => {
  it('turns the chat into an intake with no ticket, then creates, updates and specifies a linked card', async () => {
    await setup(false);
    const ba = await w.hire('Grace', 'ba', 'senior');
    const { chat, start } = await openDeskChat(ba.id);
    expect(start.context.intake).toBeUndefined();
    const unmapped = await rpc(start.chatId, 'card.create', draft());
    expect(unmapped.ok).toBe(false);
    expect(unmapped.error).toMatch(/map the ticket to a project first/);
    expect((await rpc(start.chatId, 'intake.map', { project: 'TOY' })).ok).toBe(true);
    const made = await rpc(start.chatId, 'card.create', draft({ externalRef: undefined }));
    expect(made.ok).toBe(true);
    expect((await rpc(start.chatId, 'card.update', { ref: made.result.ref, title: 'Renamed' })).ok).toBe(
      true,
    );
    const spec = await rpc(start.chatId, 'card.specify', { ref: made.result.ref });
    expect(spec.ok).toBe(true);

    const started = await eventsOfType('IntakeStarted');
    expect(started).toHaveLength(1);
    expect(started[0].payload).toMatchObject({
      threadId: chat.threadId,
      source: 'chat',
      startedBy: w.owner.id,
    });
    expect(started[0].payload.externalKey).toBeUndefined();
    expect(started[0].actor_id).toBe(w.owner.id);
    // still one chat thread (no second thread, kind unchanged), linked to the card through the intake
    const threads = await q('SELECT kind FROM threads WHERE id=$1', [chat.threadId]);
    expect(threads).toEqual([{ kind: 'chat' }]);
    const linked = await q(
      `SELECT c.ref, c.title, c.status, c.origin FROM intakes i JOIN intake_cards ic ON ic.intake_id=i.id JOIN cards c ON c.id=ic.card_id WHERE i.thread_id=$1`,
      [chat.threadId],
    );
    expect(linked).toMatchObject([{ ref: made.result.ref, title: 'Renamed', origin: 'intake' }]);
    expect(linked[0]!.status).not.toBe('draft');
    await finishChat(start);
    // the next message tells the BA about the intake it has (marked as from the chat)
    const from = r.received.length;
    w.t.app.ctx.services.chat.send(w.owner.id, {
      threadId: chat.threadId,
      body: 'more',
      clientMsgId: randomUUID(),
    });
    const next = (await r.waitFor('chat.start', (f) => f.threadId === chat.threadId, 15_000, from)) as any;
    expect(next.context.intake).toMatchObject({ fromChat: true, mappedProjectKey: 'TOY' });
    expect(next.context.intake.cards.map((c: any) => c.ref)).toEqual([made.result.ref]);
  });

  it('pre-maps the project in the chat context', async () => {
    await setup(false);
    const ba = await w.hire('Grace', 'ba', 'senior');
    const { start } = await openDeskChat(ba.id, { projectId: w.projectId });
    const made = await rpc(start.chatId, 'card.create', draft({ externalRef: undefined }));
    expect(made.ok).toBe(true);
    expect(made.result.ref).toMatch(/^TOY-/);
    const wrong = await rpc(start.chatId, 'intake.map', { project: 'NOPE' });
    expect(wrong.ok).toBe(false);
  });

  it('refuses other agents, which keep the existing refusal and get no intake', async () => {
    await setup(false);
    const other = await w.hire('Una', 'builder', 'senior');
    const { chat, start } = await openDeskChat(other.id);
    const denied = await rpc(start.chatId, 'card.create', draft());
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/only the BA can do this/);
    expect(await q('SELECT 1 FROM intakes WHERE thread_id=$1', [chat.threadId])).toHaveLength(0);
  });

  it('follows the chatting user: a manager cannot map or create in a project they are not a member of', async () => {
    await setup(false);
    const m = await addMember(w, 'bamgr');
    await ok(
      w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'PRIV', name: 'Private' } }),
      201,
    );
    const mr = await connectMemberRunner(w, m);
    const ba = await hireFor(w, m, 'Gina', 'ba', 'senior');
    const { start } = await openDeskChat(ba.id, {}, mr, m.cookie, m.id);
    const denied = await rpc2(mr, start.chatId, 'intake.map', { project: 'PRIV' });
    expect(denied.ok).toBe(false);
    expect(denied.error).toMatch(/unknown project/);
    expect((await rpc2(mr, start.chatId, 'card.create', draft())).ok).toBe(false);
    expect((await rpc2(mr, start.chatId, 'intake.map', { project: 'TOY' })).ok).toBe(true);
    const made = await rpc2(mr, start.chatId, 'card.create', draft({ externalRef: undefined }));
    expect(made.ok).toBe(true);
    const intake = (await q('SELECT started_by FROM intakes ORDER BY created_at DESC LIMIT 1'))[0];
    expect(intake!.started_by).toBe(m.id);
    mr.close();
  });
});

async function rpc2(
  runner: FakeRunner,
  chatId: string,
  method: string,
  params: Record<string, unknown> = {},
) {
  const rpcId = randomUUID();
  const from = runner.received.length;
  runner.send('rpc.request', { rpcId, shiftId: chatId, method, params });
  return (await runner.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
}
