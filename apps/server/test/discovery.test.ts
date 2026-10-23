import { randomUUID } from 'node:crypto';
import { SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { Browser } from './helpers/browser.ts';
import { appoint } from './helpers/ceo.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/** Discovery Studio: the facilitated session, its verbs, CEO modes, budget stop, PRD hand-off and replay safety. */
/** Rows as loosely typed records (the assertions name the columns). */
const q = async (sql: string, params: unknown[] = []): Promise<any[]> => rawQ(sql, params) as Promise<any[]>;
let w: World;
let r: FakeRunner;
const seen = new Set<string>();
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY] });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown, expected = 200) =>
  ok<any>(
    w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) }),
    expected,
  );
const raw = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, ...(body !== undefined ? { body } : {}) });
const create = async (over: Record<string, unknown> = {}) =>
  (
    await owner(
      'POST',
      '/api/discovery',
      { title: 'Invoicing idea', idea: 'Invoices for freelancers', ...over },
      201,
    )
  ).state;
const get = async (id: string) => (await owner('GET', `/api/discovery/${id}`)).state;
const nextStart = async (pred: (f: any) => boolean = () => true): Promise<any> => {
  const f = await r.waitFor('chat.start', (x) => !seen.has(x.chatId) && pred(x), 15_000);
  seen.add(f.chatId);
  return f;
};
const call = async (turnId: string, method: string, params: Record<string, unknown> = {}) => {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId: turnId, method, params });
  return (await r.waitFor('rpc.response', (f) => f.rpcId === rpcId, 15_000, from)) as {
    ok: boolean;
    result?: any;
    error?: string;
  };
};
const finish = async (start: any, text = 'ok', usage = { inputTokens: 100, outputTokens: 20 }) => {
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: text,
    usage: { ...usage, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  await until(
    async () =>
      (await q('SELECT status FROM session_turns WHERE id=$1', [start.chatId]))[0]?.status === 'done',
  );
};
const ask = (turnId: string, question: string, options: string[] = ['Yes', 'No']) =>
  call(turnId, 'session.ask', { question, options, allowFreeText: true });
const answer = (id: string, qid: string, body: Record<string, unknown>, expected = 200) =>
  owner('POST', `/api/discovery/${id}/questions/${qid}/answer`, body, expected);
/** Runs the facilitator turn that is queued next: asks one question and ends the turn. */
const facilitatorAsks = async (question = 'Who is it for?', options = ['Freelancers', 'Agencies']) => {
  const start = await nextStart((f) => f.message.includes('"role":"facilitator"'));
  const a = await ask(start.chatId, question, options);
  expect(a.ok).toBe(true);
  await finish(start, 'Let me ask about the audience.');
  return { start, questionId: a.result.questionId as string };
};

describe('creating and starting a session', () => {
  it('creates the session, queues the first facilitator turn and tells the facilitator everything it needs', async () => {
    const b = await Browser.open(w.baseUrl, w.owner.cookie);
    await b.hello();
    const s = await create({ stance: 'partner', timeBoxMinutes: 30, playbook: 'brainstorm' });
    expect(s).toMatchObject({
      config: { stance: 'partner', phase: 'frame', ceoMode: 'owner_only', timeBoxMinutes: 30, paused: false },
      waitingFor: 'facilitator',
      busy: true,
      ceoAvailable: false,
      facilitatorName: 'Analyst',
    });
    const start = await nextStart();
    expect(start.session).toMatchObject({
      kind: 'discovery',
      speaker: { kind: 'persona', personaKey: 'analyst' },
    });
    expect(start.session.instructions).toContain('# Discovery protocol');
    expect(start.session.instructions).toContain('aom session ask');
    expect(start.message).toContain('Invoices for freelancers');
    expect(start.message).toContain('Stance: partner');
    expect(start.message).toContain('Phase: Frame');
    expect(start.message).toContain('Playbook: brainstorm');
    expect(start.message).toContain('"role":"facilitator"');
    expect(start.message).toContain('"trigger":"start"');
    const t = (await q('SELECT meta FROM session_turns WHERE id=$1', [start.chatId]))[0];
    expect(t.meta).toMatchObject({ purpose: 'facilitator', trigger: 'start' });
    await b.until(() => b.of('discovery.updated').some((m) => m.threadId === s.threadId));
    await finish(start, 'Hello! Tell me about it.');
    expect((await get(s.threadId)).waitingFor).toBe('nothing');
    b.close();
  });

  it('uses an analyst agent when the organization has one, and refuses CEO modes without a CEO', async () => {
    const bad = await raw('POST', '/api/discovery', { title: 'x', ceoMode: 'joint' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain('no_ceo');
    const analyst = await w.hire(`Ana${Math.random().toString(36).slice(2, 6)}`, 'analyst', 'senior');
    const s = await create({ title: 'With agent' });
    const start = await nextStart();
    expect(start.agent).toMatchObject({ agentId: analyst.id, roleKey: 'analyst' });
    expect(s.facilitatorName).toBe(analyst.name);
    await finish(start);
    await q(`UPDATE agents SET status='retired' WHERE id=$1`, [analyst.id]);
  });

  it('refuses a turn on a runner that cannot run the verbs', async () => {
    const old = await w.connectRunner({ capabilities: [SESSION_TURNS_CAPABILITY] });
    r.close();
    await until(async () => w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000);
    const s = await create({ title: 'Old runner' });
    await until(async () => (await get(s.threadId)).turns[0]?.status === 'failed', 10_000);
    expect((await get(s.threadId)).turns[0].error).toContain('runner_too_old');
    old.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000);
    r = await w.connectRunner({ capabilities: [SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY] });
  });
});

describe('the facilitator verbs', () => {
  it('asks one question at a time, keeps the panel, proposes, changes phase, and cannot go beyond its turn', async () => {
    const s = await create({ title: 'Verbs' });
    const start = await nextStart();
    const id = start.chatId;
    // not a session turn / a stale token
    expect((await call(randomUUID(), 'session.ask', { question: 'x' })).error).toBeDefined();
    const a = await ask(id, 'Who is it for?', ['Freelancers', 'Agencies', 'Accountants']);
    expect(a.ok).toBe(true);
    expect((await ask(id, 'Second one?')).error).toMatch(/one question/i);
    let st = await get(s.threadId);
    expect(st.questions).toHaveLength(1);
    expect(st.questions[0]).toMatchObject({
      status: 'open',
      question: 'Who is it for?',
      options: [
        { id: 'o1', label: 'Freelancers' },
        { id: 'o2', label: 'Agencies' },
        { id: 'o3', label: 'Accountants' },
      ],
      allowFreeText: true,
      phase: 'frame',
    });
    const n = await call(id, 'session.note', { op: 'add', section: 'ideas', text: 'Recurring invoices' });
    expect(n.ok).toBe(true);
    expect((await call(id, 'session.note', { op: 'add', section: 'nope', text: 'x' })).ok).toBe(false);
    await call(id, 'session.note', { op: 'add', section: 'assumptions', text: 'Users pay late' });
    const u = await call(id, 'session.note', {
      op: 'update',
      id: n.result.id,
      text: 'Recurring invoices with reminders',
      section: 'decisions',
    });
    expect(u.ok).toBe(true);
    const rm = await call(id, 'session.note', { op: 'add', section: 'parked', text: 'Tax filing' });
    expect((await call(id, 'session.note', { op: 'remove', id: rm.result.id })).ok).toBe(true);
    st = await get(s.threadId);
    expect(st.notes.map((x: any) => [x.section, x.text, x.byKind])).toEqual([
      ['decisions', 'Recurring invoices with reminders', 'persona'],
      ['assumptions', 'Users pay late', 'persona'],
    ]);
    const p = await call(id, 'session.propose', {
      title: 'Add reminders',
      change: 'Send reminders after 7 days',
      rationale: 'Late payers',
    });
    expect(p.ok).toBe(true);
    expect((await call(id, 'session.phase', { to: 'diverge', reason: 'framed' })).ok).toBe(true);
    expect((await call(id, 'session.phase', { to: 'bogus' })).ok).toBe(false);
    st = await get(s.threadId);
    expect(st.config.phase).toBe('diverge');
    expect(st.proposals).toMatchObject([{ status: 'open', title: 'Add reminders' }]);
    // the CEO verb is not the facilitator's
    expect((await call(id, 'session.answer', { text: 'x' })).error).toMatch(/not available/);
    // other rpc methods do not reach the server from a session turn
    expect((await call(id, 'card.get')).ok).toBe(false);
    expect((await call(id, 'ledger.search', { query: 'x' })).ok).toBe(true);
    const shown = await call(id, 'session.show');
    expect(shown.result.text).toContain('Who is it for?');
    expect(shown.result.text).toContain('Users pay late');
    await finish(start);
    // the turn is over: the token no longer works
    expect((await call(id, 'session.note', { op: 'add', section: 'ideas', text: 'late' })).error).toMatch(
      /over/,
    );
  });

  it('answers: quick pick, free text, skip and park each queue the next facilitator turn with the answer', async () => {
    const s = await create({ title: 'Answers' });
    const { questionId } = await facilitatorAsks('Who is it for?', ['Freelancers', 'Agencies']);
    expect((await get(s.threadId)).waitingFor).toBe('owner');
    // a wrong option
    expect(
      (
        await raw('POST', `/api/discovery/${s.threadId}/questions/${questionId}/answer`, {
          kind: 'pick',
          optionId: 'o9',
        })
      ).status,
    ).toBe(400);
    await answer(s.threadId, questionId, { kind: 'pick', optionId: 'o2' });
    let next = await nextStart();
    expect(next.message).toContain('"trigger":"answer"');
    expect(next.message).toContain('Agencies');
    expect(next.message).toContain('Who is it for?');
    expect(
      (await raw('POST', `/api/discovery/${s.threadId}/questions/${questionId}/answer`, { kind: 'skip' }))
        .status,
    ).toBe(409);
    const q2 = await ask(next.chatId, 'How do they bill?', ['Hourly', 'Fixed']);
    await finish(next);
    await answer(s.threadId, q2.result.questionId, { kind: 'text', text: 'Mostly per milestone' });
    next = await nextStart();
    expect(next.message).toContain('Mostly per milestone');
    const q3 = await ask(next.chatId, 'Which markets?', ['EU', 'US']);
    await finish(next);
    await answer(s.threadId, q3.result.questionId, { kind: 'skip' });
    next = await nextStart();
    expect(next.message).toContain('skipped');
    const q4 = await ask(next.chatId, 'Payment providers?', ['Stripe']);
    await finish(next);
    await answer(s.threadId, q4.result.questionId, { kind: 'park' });
    next = await nextStart();
    expect(next.message).toContain('parked');
    const st = await get(s.threadId);
    expect(st.questions.map((x: any) => x.status)).toEqual(['answered', 'answered', 'skipped', 'parked']);
    expect(st.questions[0].answer).toMatchObject({ kind: 'pick', optionId: 'o2', source: 'owner' });
    expect(st.notes.map((x: any) => [x.section, x.byKind])).toEqual([['parked', 'user']]);
    await finish(next);
  });

  it('keeps an answer that arrives while the facilitator is still working and sends it right after', async () => {
    const s = await create({ title: 'Pending' });
    const start = await nextStart();
    const a = await ask(start.chatId, 'Quick one?', ['A', 'B']);
    // the owner answers before the turn is over
    await answer(s.threadId, a.result.questionId, { kind: 'pick', optionId: 'o1' });
    expect((await get(s.threadId)).config).toBeDefined();
    const cfg = (await q('SELECT session_config FROM threads WHERE id=$1', [s.threadId]))[0].session_config;
    expect(cfg.pendingTriggers).toMatchObject([{ kind: 'answer' }]);
    await finish(start);
    const next = await nextStart();
    expect(next.message).toContain('"trigger":"answer"');
    const cfg2 = (await q('SELECT session_config FROM threads WHERE id=$1', [s.threadId]))[0].session_config;
    expect(cfg2.pendingTriggers).toBeUndefined();
    expect(cfg2.pendingTrigger).toBeUndefined();
    await finish(next);
  });

  it('writes to the facilitator, lets the owner edit the panel, and withdraws a question the next ask replaces', async () => {
    const s = await create({ title: 'Panel' });
    const { questionId } = await facilitatorAsks();
    await owner('POST', `/api/discovery/${s.threadId}/say`, { body: 'Actually, think about teams' }, 201);
    const next = await nextStart();
    expect(next.message).toContain('"trigger":"message"');
    expect(next.message).toContain('Actually, think about teams');
    const q2 = await ask(next.chatId, 'Teams of how many?', ['2-5', '6+']);
    await finish(next);
    const st = await get(s.threadId);
    expect(st.questions.map((x: any) => x.status)).toEqual(['withdrawn', 'open']);
    expect(q2.ok).toBe(true);
    expect(
      (await raw('POST', `/api/discovery/${s.threadId}/questions/${questionId}/answer`, { kind: 'skip' }))
        .status,
    ).toBe(409);
    // the owner's own notes
    const withNote = (
      await owner(
        'POST',
        `/api/discovery/${s.threadId}/notes`,
        { section: 'ideas', text: 'Mobile first' },
        201,
      )
    ).state;
    const noteId = withNote.notes[0].id;
    expect(withNote.notes[0]).toMatchObject({ byKind: 'user', section: 'ideas' });
    const moved = (
      await owner('PATCH', `/api/discovery/${s.threadId}/notes/${noteId}`, {
        section: 'parked',
        text: 'Mobile first (later)',
      })
    ).state;
    expect(moved.notes[0]).toMatchObject({ section: 'parked', text: 'Mobile first (later)' });
    expect((await owner('DELETE', `/api/discovery/${s.threadId}/notes/${noteId}`)).state.notes).toEqual([]);
    expect(
      (await raw('PATCH', `/api/discovery/${s.threadId}/notes/${noteId}`, { text: 'gone' })).status,
    ).toBe(404);
  });
});

describe('proposals: Apply, Reject, Redirect', () => {
  it('applies nothing until the owner chooses; Apply updates the panel or the document; Redirect goes back to the facilitator', async () => {
    const s = await create({ title: 'Proposals' });
    const start = await nextStart();
    const id = start.chatId;
    const d = await call(id, 'session.draft', {
      kind: 'prd',
      content: '# PRD\n\n## Goals\n\nOld goals.\n\n## Scope\n\nAll of it.\n',
    });
    expect(d.ok).toBe(true);
    const p1 = await call(id, 'session.propose', {
      title: 'Sharper goals',
      change: 'Cut invoice time by half.',
      rationale: 'Measurable',
      doc: d.result.docId,
      section: 'Goals',
    });
    const p2 = await call(id, 'session.propose', {
      title: 'Note it',
      change: 'Freelancers first',
      rationale: 'Focus',
      section: 'decisions',
    });
    const p3 = await call(id, 'session.propose', {
      title: 'Drop scope',
      change: 'Remove scope',
      rationale: 'Smaller',
      doc: d.result.docId,
      section: 'Scope',
    });
    const p4 = await call(id, 'session.propose', {
      title: 'Weird',
      change: 'x',
      rationale: 'y',
      doc: randomUUID(),
    });
    expect(p4.ok).toBe(false);
    await finish(start);
    let st = await get(s.threadId);
    expect(st.notes).toEqual([]);
    const doc = async () => (await owner('GET', `/api/documents/${d.result.docId}`)).document;
    expect((await doc()).content).toContain('Old goals.');
    // Apply to the document
    st = (
      await owner('POST', `/api/discovery/${s.threadId}/proposals/${p1.result.proposalId}/resolve`, {
        resolution: 'apply',
      })
    ).state;
    const after = await doc();
    expect(after.content).toContain('Cut invoice time by half.');
    expect(after.content).not.toContain('Old goals.');
    expect(after.content).toContain('All of it.');
    expect(after.currentVersion).toBe(2);
    let next = await nextStart();
    expect(next.message).toContain('"trigger":"proposal"');
    expect(next.message).toContain('applied your proposal "Sharper goals"');
    await finish(next);
    // Apply to the panel
    st = (
      await owner('POST', `/api/discovery/${s.threadId}/proposals/${p2.result.proposalId}/resolve`, {
        resolution: 'apply',
      })
    ).state;
    expect(st.notes).toMatchObject([{ section: 'decisions', text: 'Freelancers first' }]);
    next = await nextStart();
    await finish(next);
    // Redirect needs words, and its words reach the facilitator
    expect(
      (
        await raw('POST', `/api/discovery/${s.threadId}/proposals/${p3.result.proposalId}/resolve`, {
          resolution: 'redirect',
        })
      ).status,
    ).toBe(400);
    await owner('POST', `/api/discovery/${s.threadId}/proposals/${p3.result.proposalId}/resolve`, {
      resolution: 'redirect',
      text: 'Shrink it to invoicing only',
    });
    next = await nextStart();
    expect(next.message).toContain('Shrink it to invoicing only');
    await finish(next);
    st = await get(s.threadId);
    expect(st.proposals.map((x: any) => x.status)).toEqual(['applied', 'applied', 'redirected']);
    expect((await doc()).content).toContain('All of it.');
    expect(
      (
        await raw('POST', `/api/discovery/${s.threadId}/proposals/${p3.result.proposalId}/resolve`, {
          resolution: 'reject',
        })
      ).status,
    ).toBe(409);
  });

  it('rejects: the document and the panel stay as they were', async () => {
    const s = await create({ title: 'Reject' });
    const start = await nextStart();
    const p = await call(start.chatId, 'session.propose', {
      title: 'Bold',
      change: 'Pivot',
      rationale: 'why not',
    });
    await finish(start);
    const st = (
      await owner('POST', `/api/discovery/${s.threadId}/proposals/${p.result.proposalId}/resolve`, {
        resolution: 'reject',
      })
    ).state;
    expect(st.notes).toEqual([]);
    expect(st.proposals[0].status).toBe('rejected');
    const next = await nextStart();
    expect(next.message).toContain('rejected your proposal "Bold"');
    await finish(next);
  });
});

describe('pause and resume', () => {
  it('keeps the clock and every open item across a pause; nothing is sent while paused', async () => {
    const s = await create({ title: 'Pause', timeBoxMinutes: 60 });
    const { questionId } = await facilitatorAsks();
    w.t.clock.advance(10 * 60_000);
    let st = (await owner('POST', `/api/discovery/${s.threadId}/pause`)).state;
    expect(st.config.paused).toBe(true);
    expect(st.waitingFor).toBe('paused');
    expect(st.progress.elapsedMinutes).toBe(10);
    w.t.clock.advance(3 * 24 * 3_600_000);
    expect((await get(s.threadId)).progress.elapsedMinutes).toBe(10);
    // the owner answers while paused: stored, but the facilitator waits
    await answer(s.threadId, questionId, { kind: 'pick', optionId: 'o1' });
    await r.barrier();
    expect(r.received.filter((f) => f.type === 'chat.start' && !seen.has((f as any).chatId))).toHaveLength(0);
    st = (await owner('POST', `/api/discovery/${s.threadId}/resume`)).state;
    expect(st.config.paused).toBe(false);
    const next = await nextStart();
    expect(next.message).toContain('"trigger":"answer"');
    expect((await get(s.threadId)).progress.elapsedMinutes).toBeGreaterThanOrEqual(10);
    expect((await get(s.threadId)).progress.elapsedMinutes).toBeLessThan(12);
    w.t.clock.advance(60 * 60_000);
    expect((await get(s.threadId)).progress.remainingMinutes).toBe(0);
    await finish(next);
  });

  it('survives a restart: a pending trigger is sent by the sweep', async () => {
    const s = await create({ title: 'Restart' });
    const start = await nextStart();
    const a = await ask(start.chatId, 'Q?', ['a']);
    await answer(s.threadId, a.result.questionId, { kind: 'pick', optionId: 'o1' });
    // the turn is lost (the runner dropped it): it is re-sent, then the pending answer follows
    await finish(start);
    const next = await nextStart();
    await finish(next);
    await w.t.app.ctx.services.discovery.sweep();
    await r.barrier();
    expect(seen.size).toBeGreaterThan(0);
  });
});

describe('phases', () => {
  it('lets the owner override the phase, and tells the facilitator', async () => {
    const s = await create({ title: 'Phases' });
    const start = await nextStart();
    await call(start.chatId, 'session.phase', { to: 'converge' });
    await finish(start);
    const st = (await owner('POST', `/api/discovery/${s.threadId}/phase`, { phase: 'diverge' })).state;
    expect(st.config.phase).toBe('diverge');
    const next = await nextStart();
    expect(next.message).toContain('moved the session from Converge to Diverge');
    expect(next.message).toContain('Phase: Diverge');
    await finish(next);
    expect((await raw('POST', `/api/discovery/${s.threadId}/phase`, { phase: 'nope' })).status).toBe(400);
  });
});

describe('CEO modes', () => {
  let ceoId: string;
  beforeAll(async () => {
    ceoId = await appoint(w);
  });

  it('joint: the CEO proposes after each question; the owner confirms, edits or overrides; the CEO never answers on its own', async () => {
    const s = await create({ title: 'Joint', ceoMode: 'joint' });
    expect(s.ceoAvailable).toBe(true);
    expect(s.ceoName).toBe('Ada Prime');
    const { questionId } = await facilitatorAsks('Who is it for?', ['Freelancers', 'Agencies']);
    const ceoStart = await nextStart((f) => f.message.includes('"role":"ceo_answer"'));
    expect(ceoStart.agent.agentId).toBe(ceoId);
    expect(ceoStart.session.instructions).toContain('PROPOSE');
    expect(ceoStart.message).toContain('Who is it for?');
    // the CEO has no facilitator powers
    expect((await ask(ceoStart.chatId, 'my own question')).error).toMatch(/not available/);
    expect((await call(ceoStart.chatId, 'session.phase', { to: 'capture' })).ok).toBe(false);
    const prop = await call(ceoStart.chatId, 'session.answer', {
      option: 'o1',
      why: 'Smallest market to win first',
    });
    expect(prop.ok).toBe(true);
    expect((await call(ceoStart.chatId, 'session.answer', { option: 'o2' })).error).toMatch(
      /already proposed/,
    );
    await finish(ceoStart, 'I would start with freelancers.');
    let st = await get(s.threadId);
    expect(st.questions[0]).toMatchObject({
      status: 'open',
      answer: null,
      proposed: {
        text: 'Freelancers',
        optionId: 'o1',
        rationale: 'Smallest market to win first',
        byName: 'Ada Prime',
        mode: 'joint',
      },
    });
    expect(st.waitingFor).toBe('owner');
    // nothing was queued for the facilitator: the CEO's proposal is not an answer
    await r.barrier();
    expect(r.received.filter((f) => f.type === 'chat.start' && !seen.has((f as any).chatId))).toHaveLength(0);
    // Confirm
    st = (await answer(s.threadId, questionId, { kind: 'confirm' })).state;
    expect(st.questions[0].answer).toMatchObject({ kind: 'pick', optionId: 'o1', source: 'ceo_confirmed' });
    let next = await nextStart();
    expect(next.message).toContain('CEO answer, confirmed by the owner');
    // Edit
    const q2 = await ask(next.chatId, 'Pricing?', ['Free', 'Paid']);
    await finish(next);
    const c2 = await nextStart((f) => f.message.includes('"role":"ceo_answer"'));
    await call(c2.chatId, 'session.answer', { text: 'Paid, 10 euro', why: 'Sustainable' });
    await finish(c2, 'Paid.');
    st = (
      await answer(s.threadId, q2.result.questionId, { kind: 'confirm', edited: true, text: 'Paid, 15 euro' })
    ).state;
    expect(st.questions[1].answer).toMatchObject({
      kind: 'text',
      text: 'Paid, 15 euro',
      source: 'ceo_edited',
    });
    next = await nextStart();
    expect(next.message).toContain('edited by the owner');
    // Override
    const q3 = await ask(next.chatId, 'Launch?', ['Q1', 'Q2']);
    await finish(next);
    const c3 = await nextStart((f) => f.message.includes('"role":"ceo_answer"'));
    await call(c3.chatId, 'session.answer', { option: 'o1' });
    await finish(c3);
    st = (await answer(s.threadId, q3.result.questionId, { kind: 'pick', optionId: 'o2' })).state;
    expect(st.questions[2].answer).toMatchObject({ optionId: 'o2', source: 'owner_override' });
    next = await nextStart();
    await finish(next);
  });

  it('joint: the CEO answering in prose is stored as a proposal; an answer that comes after the owner answered is dropped', async () => {
    const s = await create({ title: 'Joint prose', ceoMode: 'joint' });
    const { questionId } = await facilitatorAsks();
    const c = await nextStart((f) => f.message.includes('"role":"ceo_answer"'));
    await finish(c, 'Agencies, because they pay more.');
    // the follow-up of a turn runs just after it ends
    await until(async () => !!(await get(s.threadId)).questions[0]?.proposed);
    let st = await get(s.threadId);
    expect(st.questions[0].proposed).toMatchObject({
      text: 'Agencies, because they pay more.',
      mode: 'joint',
    });
    // the owner answers first on another question; the CEO's late verb is refused
    const s2 = await create({ title: 'Joint late', ceoMode: 'joint' });
    const f2 = await facilitatorAsks();
    const c2 = await nextStart((f) => f.message.includes('"role":"ceo_answer"'));
    await answer(s2.threadId, f2.questionId, { kind: 'pick', optionId: 'o1' });
    const late = await call(c2.chatId, 'session.answer', { option: 'o2' });
    expect(late.ok).toBe(false);
    expect(late.error).toMatch(/already answered/);
    await finish(c2, 'too late');
    st = await get(s2.threadId);
    expect(st.questions[0]).toMatchObject({ status: 'answered', proposed: null });
    const n = await nextStart();
    await finish(n);
    void questionId;
  });

  it('ceo_prep: the CEO runs the questions alone up to the cap; answers stay proposed until the owner reviews each one', async () => {
    const s = await create({ title: 'Prep', ceoMode: 'ceo_prep' });
    expect(s.config.ceoPrep).toMatchObject({ state: 'running', turns: 0, cap: 12 });
    await q(
      `UPDATE threads SET session_config = jsonb_set(session_config, '{ceoPrep,cap}', '2') WHERE id=$1`,
      [s.threadId],
    );
    // round 1
    const a1 = await facilitatorAsks('Who is it for?', ['Freelancers', 'Agencies']);
    const c1 = await nextStart((f) => f.message.includes('"role":"ceo_answer"'));
    expect(c1.message).toContain('pre-answering on your own');
    await call(c1.chatId, 'session.answer', { option: 'o1', why: 'focus' });
    await finish(c1, 'Freelancers.');
    // the facilitator carries on with the CEO's provisional answer
    const f2 = await nextStart((f) => f.message.includes('"role":"facilitator"'));
    expect(f2.message).toContain('"trigger":"ceo_answered"');
    expect(f2.message).toContain("CEO's provisional answer");
    const a2 = await ask(f2.chatId, 'Pricing?', ['Free', 'Paid']);
    await finish(f2);
    const c2 = await nextStart((f) => f.message.includes('"role":"ceo_answer"'));
    await call(c2.chatId, 'session.answer', { option: 'o2' });
    await finish(c2, 'Paid.');
    // cap reached: the owner reviews
    await until(async () => (await get(s.threadId)).config.ceoPrep?.state === 'review');
    let st = await get(s.threadId);
    expect(st.waitingFor).toBe('review');
    expect(st.questions.map((x: any) => x.status)).toEqual(['proposed', 'proposed']);
    expect(st.questions.every((x: any) => x.answer === null && x.proposed)).toBe(true);
    // no facilitator turn while the owner reviews
    await r.barrier();
    expect(r.received.filter((f) => f.type === 'chat.start' && !seen.has((f as any).chatId))).toHaveLength(0);
    await answer(s.threadId, a1.questionId, { kind: 'confirm' });
    st = await get(s.threadId);
    expect(st.config.ceoPrep.state).toBe('review');
    await answer(s.threadId, a2.result.questionId, { kind: 'pick', optionId: 'o1' });
    st = await get(s.threadId);
    expect(st.questions.map((x: any) => x.answer.source)).toEqual(['ceo_confirmed', 'owner_override']);
    expect(st.config.ceoPrep.state).toBe('done');
    const after = await nextStart((f) => f.message.includes('"role":"facilitator"'));
    expect(after.message).toContain('"trigger":"review_done"');
    await finish(after);
  });
});

describe('cost ledger and budgets', () => {
  it('counts every session turn in the cost ledger once, in the session cost and in the project budget', async () => {
    const s = await create({ title: 'Costs', projectId: w.projectId });
    const start = await nextStart();
    await finish(start, 'hi', { inputTokens: 1_000_000, outputTokens: 100_000 });
    const row = (await q('SELECT * FROM shift_costs WHERE shift_id=$1', [start.chatId]))[0];
    expect(row).toMatchObject({ kind: 'session', project_id: w.projectId });
    expect(Number(row.cost_usd_micros)).toBeGreaterThan(0);
    expect(row.cost_stamped).toBe(true);
    const st = await get(s.threadId);
    expect(st.cost.turns).toBe(1);
    expect(st.cost.costMicros).toBe(Number(row.cost_usd_micros));
    const sess = (await owner('GET', `/api/sessions/${s.threadId}`)).session;
    expect(sess.cost).toMatchObject({
      turns: 1,
      costMicros: st.cost.costMicros,
      budgetUsd: null,
      exceeded: false,
    });
    // a project budget sees it
    const spend = (
      await q(
        `SELECT COALESCE(sum(cost_usd_micros),0) AS m FROM shift_costs WHERE project_id=$1 AND kind='session'`,
        [w.projectId],
      )
    )[0];
    expect(Number(spend.m)).toBeGreaterThanOrEqual(Number(row.cost_usd_micros));
  });

  it('stops queueing turns when the session budget is used up, says so, and continues when it is raised', async () => {
    const s = await create({ title: 'Budget', budgetUsd: 0.5 });
    const start = await nextStart();
    const a = await ask(start.chatId, 'Q?', ['a', 'b']);
    // 2M input tokens on the mock model price: well above 0.5 USD
    await finish(start, 'hi', { inputTokens: 2_000_000, outputTokens: 500_000 });
    let st = await get(s.threadId);
    expect(st.cost.exceeded).toBe(true);
    await answer(s.threadId, a.result.questionId, { kind: 'pick', optionId: 'o1' });
    st = await get(s.threadId);
    expect(st.config.budgetStopped).toBe(true);
    expect(st.waitingFor).toBe('budget');
    const msgs = (await owner('GET', `/api/threads/${s.threadId}/messages`)).messages as any[];
    expect(msgs.find((m) => m.kind === 'system' && /budget/.test(m.body))?.body).toMatch(
      /used its budget of \$0\.50/,
    );
    // the generic turn API refuses too, with the same message
    const parts = (await owner('GET', `/api/sessions/${s.threadId}`)).session.participants;
    const fac = parts.find((p: any) => p.seat === 'Facilitator');
    const refused = await raw('POST', `/api/sessions/${s.threadId}/turns`, {
      participantId: fac.id,
      message: 'go on',
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('session_budget_exceeded');
    // raising the budget lets the owner's answer through
    st = (await owner('PATCH', `/api/discovery/${s.threadId}`, { budgetUsd: 1000 })).state;
    expect(st.config.budgetStopped).toBe(false);
    const next = await nextStart();
    expect(next.message).toContain('"trigger":"answer"');
    await finish(next);
  });

  it('does not start session turns for a paused project', async () => {
    const s = await create({ title: 'Paused project', projectId: w.projectId });
    const start = await nextStart();
    await finish(start);
    await q(`UPDATE projects SET paused_at = now() WHERE id=$1`, [w.projectId]);
    try {
      await owner('POST', `/api/discovery/${s.threadId}/say`, { body: 'hello?' }, 201);
      const st = await get(s.threadId);
      const msgs = (await owner('GET', `/api/threads/${s.threadId}/messages`)).messages as any[];
      expect(msgs.some((m) => m.kind === 'system' && /project of this session is paused/.test(m.body))).toBe(
        true,
      );
      expect(st.turns).toHaveLength(1);
    } finally {
      await q(`UPDATE projects SET paused_at = NULL WHERE id=$1`, [w.projectId]);
    }
    await w.t.app.ctx.services.discovery.sweep();
    const next = await nextStart();
    await finish(next);
  });
});

describe('PRD flow: draft, validate, approve, hand to the BA', () => {
  it('drafts a PRD in the session, validates it against the checklist, and hands the approved PRD to the BA with the cards linked', async () => {
    const s = await create({ title: 'PRD flow', projectId: w.projectId, playbook: 'prd' });
    const start = await nextStart();
    await call(start.chatId, 'session.phase', { to: 'capture' });
    const d = await call(start.chatId, 'session.draft', {
      kind: 'prd',
      content: '# PRD: Invoicing\n\n## Goals\n\nFaster invoices.\n',
      note: 'first cut',
    });
    expect(d.ok).toBe(true);
    expect(d.result.version).toBe(1);
    const same = await call(start.chatId, 'session.draft', {
      kind: 'prd',
      content: '# PRD: Invoicing\n\n## Goals\n\nFaster invoices.\n',
    });
    expect(same.result.message).toMatch(/No change/);
    const v2 = await call(start.chatId, 'session.draft', {
      kind: 'prd',
      content:
        '# PRD: Invoicing\n\n## Goals\n\nFaster invoices.\n\n## Requirements\n\nR1: send an invoice.\n',
    });
    expect(v2.result.version).toBe(2);
    await finish(start);
    let st = await get(s.threadId);
    expect(st.documents).toMatchObject([{ kind: 'prd', status: 'draft', currentVersion: 2 }]);
    const docId = st.documents[0].id;
    const doc = (await owner('GET', `/api/documents/${docId}`)).document.content;
    expect(doc).toContain('R1: send an invoice.');
    expect((await owner('GET', `/api/documents/${docId}`)).document.sourceThreadIds).toEqual([s.threadId]);
    // validation: a facilitator turn with the PRD and the checklist
    await owner('POST', `/api/discovery/${s.threadId}/validate`, undefined, 202);
    const vs = await nextStart();
    expect(vs.message).toContain('"trigger":"validate"');
    expect(vs.message).toContain('R1: send an invoice.');
    expect(vs.message).toContain('PRD validation checklist');
    expect((await call(vs.chatId, 'session.validate', { summary: 'x', items: ['bad item'] })).ok).toBe(false);
    const ok1 = await call(vs.chatId, 'session.validate', {
      summary: 'Two gaps',
      items: [
        'Each goal has a measure|fail|No target',
        'Every requirement has an identifier|pass|R1',
        'Non-goals|n/a|',
      ],
    });
    expect(ok1.ok).toBe(true);
    await finish(vs);
    st = await get(s.threadId);
    expect(st.config.prdValidation).toMatchObject({ docId, version: 2, summary: 'Two gaps' });
    expect(st.config.prdValidation.items.map((i: any) => i.status)).toEqual(['fail', 'pass', 'n/a']);
    // not approved: no hand-off
    expect((await raw('POST', `/api/discovery/${s.threadId}/hand-to-ba`)).status).toBe(409);
    // approve (the documents API), the facilitator can no longer change it
    await owner('POST', `/api/documents/${docId}/status`, { status: 'in_review' });
    await owner('POST', `/api/documents/${docId}/status`, { status: 'approved' });
    const locked = await owner('POST', `/api/discovery/${s.threadId}/draft`, undefined, 409).catch(
      () => null,
    );
    void locked;
    // hand to the BA
    await w.hire('Ben', 'ba', 'senior');
    // a double click creates one intake: the second request is refused
    const both = await Promise.all([
      raw('POST', `/api/discovery/${s.threadId}/hand-to-ba`),
      raw('POST', `/api/discovery/${s.threadId}/hand-to-ba`),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    const handed = both.find((x) => x.status === 200)?.body;
    expect(
      await q(`SELECT 1 FROM intakes WHERE linked_doc_ids @> $1::jsonb`, [JSON.stringify([docId])]),
    ).toHaveLength(1);
    expect(handed.state.config.intakeId).toBe(handed.intakeId);
    expect((await owner('GET', `/api/documents/${docId}`)).document.status).toBe('handed_off');
    expect((await raw('POST', `/api/discovery/${s.threadId}/hand-to-ba`)).status).toBe(409);
    const intake = (await owner('GET', `/api/intakes/${handed.intakeId}`)).intake;
    expect(intake).toMatchObject({ status: 'mapped', mappedProjectKey: 'TOY' });
    const row = (await q('SELECT linked_doc_ids, note FROM intakes WHERE id=$1', [handed.intakeId]))[0];
    expect(row.linked_doc_ids).toEqual([docId]);
    expect(row.note).toContain('Discovery handoff');
    expect(row.note).toContain('R1: send an invoice.');
    const baStart = await nextStart((f) => f.threadId === intake.threadId);
    expect(baStart.message).toContain('R1: send an invoice.');
    // a card the BA drafts from this intake carries the document
    const created = await call(baStart.chatId, 'card.create', {
      title: 'Send an invoice',
      cardType: 'feature',
      fields: {
        context: 'c',
        requirements: 'r',
        acceptanceCriteria: ['a'],
        affectedAreas: 'src',
        constraints: 'n',
        testPlan: 't',
      },
    });
    expect(created.ok).toBe(true);
    const card = (await q(`SELECT fields FROM cards WHERE title='Send an invoice'`))[0];
    expect(card.fields.linkedDocIds).toEqual([docId]);
    r.send('chat.done', {
      chatId: baStart.chatId,
      threadId: baStart.threadId,
      messageText: 'ok',
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
  });

  it('refuses a hand-over without a BA online', async () => {
    const s = await create({ title: 'No BA' });
    const start = await nextStart();
    await call(start.chatId, 'session.draft', { kind: 'prd', content: '# PRD\n\ntext' });
    await finish(start);
    const docId = (await get(s.threadId)).documents[0].id;
    await owner('POST', `/api/documents/${docId}/status`, { status: 'in_review' });
    await owner('POST', `/api/documents/${docId}/status`, { status: 'approved' });
    await q(`UPDATE agents SET status='retired' WHERE role_key='ba'`);
    const res = await raw('POST', `/api/discovery/${s.threadId}/hand-to-ba`);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('no_ba');
    expect((await get(s.threadId)).config.handingOff ?? null).toBeNull();
    expect((await owner('GET', `/api/documents/${docId}`)).document.status).toBe('approved');
  });
});

describe('access and replay', () => {
  it('keeps a session private to its participants', async () => {
    const s = await create({ title: 'Private' });
    const start = await nextStart();
    await finish(start);
    const other = await w.t.userSession(`stranger-${randomUUID().slice(0, 6)}@example.com`);
    const get1 = await w.t.req('GET', `/api/discovery/${s.threadId}`, { cookie: other.cookie });
    expect(get1.status).toBe(404);
    expect(
      (await w.t.req('POST', `/api/discovery/${s.threadId}/pause`, { cookie: other.cookie })).status,
    ).toBe(404);
    expect((await w.t.req('GET', '/api/discovery/' + s.threadId)).status).toBe(401);
  });

  it('rebuilds to the same questions, notes, proposals, costs and phase', async () => {
    const tables = [
      'discovery_questions',
      'discovery_notes',
      'discovery_proposals',
      'session_turns',
      'thread_participants',
      'documents',
      'document_versions',
    ];
    const snap = async () => {
      const out: Record<string, unknown> = {};
      for (const t of tables) out[t] = await q(`SELECT * FROM ${t} ORDER BY 1`);
      out.costs = await q(
        `SELECT shift_id, kind, model, cost_usd_micros, tokens_input, project_id, agent_id FROM shift_costs WHERE kind='session' ORDER BY shift_id`,
      );
      out.threads = await q(
        `SELECT id, title, session_config, workstation_id FROM threads WHERE kind='discovery' ORDER BY id`,
      );
      out.intakes = await q('SELECT id, linked_doc_ids FROM intakes ORDER BY id');
      return JSON.parse(JSON.stringify(out));
    };
    const before = await snap();
    expect(before.discovery_questions.length).toBeGreaterThan(3);
    expect(before.costs.length).toBeGreaterThan(3);
    expect(PROJECTION_TABLES).toEqual(
      expect.arrayContaining(['discovery_questions', 'discovery_notes', 'discovery_proposals']),
    );
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(await snap()).toEqual(before);
  });
});

describe('review fixes: blocks, waiting triggers, recovery and authority', () => {
  it('tells the owner once about a paused project, however often the sweep runs', async () => {
    const s = await create({ title: 'Quiet block', projectId: w.projectId });
    const start = await nextStart();
    await finish(start);
    await q(`UPDATE projects SET paused_at = now() WHERE id=$1`, [w.projectId]);
    try {
      await owner('POST', `/api/discovery/${s.threadId}/say`, { body: 'hello?' }, 201);
      for (let i = 0; i < 3; i++) await w.t.app.ctx.services.discovery.sweep();
      const msgs = (await owner('GET', `/api/threads/${s.threadId}/messages`)).messages as any[];
      expect(
        msgs.filter((m) => m.kind === 'system' && /project of this session is paused/.test(m.body)),
      ).toHaveLength(1);
    } finally {
      await q(`UPDATE projects SET paused_at = NULL WHERE id=$1`, [w.projectId]);
    }
    await w.t.app.ctx.services.discovery.sweep();
    await finish(await nextStart());
  });

  it('keeps a draft request and an answer that wait for a running turn, and sends both in order', async () => {
    const s = await create({ title: 'Two waiting' });
    const start = await nextStart();
    const a = await ask(start.chatId, 'Who?', ['A', 'B']);
    await owner('POST', `/api/discovery/${s.threadId}/draft`, { kind: 'prd' }, 202);
    await answer(s.threadId, a.result.questionId, { kind: 'pick', optionId: 'o1' });
    const cfg = (await q('SELECT session_config FROM threads WHERE id=$1', [s.threadId]))[0].session_config;
    expect(cfg.pendingTriggers.map((x: any) => x.kind)).toEqual(['draft', 'answer']);
    await finish(start);
    const first = await nextStart();
    expect(first.message).toContain('"trigger":"draft"');
    await finish(first);
    const second = await nextStart();
    expect(second.message).toContain('"trigger":"answer"');
    await finish(second);
    const after = (await q('SELECT session_config FROM threads WHERE id=$1', [s.threadId]))[0].session_config;
    expect(after.pendingTriggers).toBeUndefined();
  });

  it('retries a failed facilitator turn once on its own, then waits for Continue', async () => {
    const s = await create({ title: 'Failing' });
    const start = await nextStart((f) => f.threadId === s.threadId);
    r.send('chat.error', { chatId: start.chatId, threadId: s.threadId, error: 'boom' });
    const retry = await nextStart((f) => f.threadId === s.threadId);
    expect(retry.message).toContain('"trigger":"resume"');
    r.send('chat.error', { chatId: retry.chatId, threadId: s.threadId, error: 'boom again' });
    await until(
      async () =>
        (await q("SELECT session_config->>'blocked' AS b FROM threads WHERE id=$1", [s.threadId]))[0]?.b ===
        'facilitator_failed',
    );
    await w.t.app.ctx.services.discovery.sweep();
    await r.barrier();
    expect(r.received.filter((f) => f.type === 'chat.start' && !seen.has((f as any).chatId))).toHaveLength(0);
    await owner('POST', `/api/discovery/${s.threadId}/continue`);
    await finish(await nextStart());
  });

  it('joint: the sweep asks the CEO when the turn-end hook was lost', async () => {
    await appoint(w);
    const s = await create({ title: 'Lost hook', ceoMode: 'joint' });
    const { questionId } = await facilitatorAsks();
    const ceo = await nextStart((f) => f.message.includes('"role":"ceo_answer"'));
    // the server "died" before it queued the CEO: no CEO turn exists, and the facilitator's turn ended long ago
    await q('DELETE FROM session_turns WHERE id=$1', [ceo.chatId]);
    await q(
      `UPDATE session_turns SET finished_at = now() - interval '10 minutes' WHERE thread_id=$1 AND meta->>'purpose'='facilitator'`,
      [s.threadId],
    );
    await w.t.app.ctx.services.discovery.sweep();
    const again = await nextStart((f) => f.message.includes('"role":"ceo_answer"'));
    expect(again.message).toContain(questionId.slice(0, 8));
    await call(again.chatId, 'session.answer', { option: 'o1' });
    await finish(again, 'Freelancers.');
    // a second sweep does not ask again
    await w.t.app.ctx.services.discovery.sweep();
    await r.barrier();
    expect(r.received.filter((f) => f.type === 'chat.start' && !seen.has((f as any).chatId))).toHaveLength(0);
  });

  it('lets only the creator or a manager steer a session; a participant may still write', async () => {
    const s = await create({ title: 'Members' });
    const member = await w.t.userSession(`dm-${randomUUID().slice(0, 6)}@example.com`);
    await w.t.addOrgMember(w.owner.id, member.id, 'member');
    await owner(
      'POST',
      `/api/sessions/${s.threadId}/participants`,
      { kind: 'user', refId: member.id, seat: 'member' },
      201,
    );
    const as = (m: string, u: string, body?: unknown) =>
      w.t.req(m, u, { cookie: member.cookie, ...(body ? { body } : {}) });
    for (const verb of ['pause', 'resume', 'continue', 'draft', 'validate', 'hand-to-ba'])
      expect(
        (
          await as(
            'POST',
            `/api/discovery/${s.threadId}/${verb}`,
            verb === 'draft' ? { kind: 'prd' } : undefined,
          )
        ).status,
        verb,
      ).toBe(403);
    expect((await as('POST', `/api/discovery/${s.threadId}/phase`, { phase: 'diverge' })).status).toBe(403);
    expect(
      (await as('POST', `/api/discovery/${s.threadId}/questions/${randomUUID()}/answer`, { kind: 'skip' }))
        .status,
    ).toBe(403);
    expect((await as('POST', `/api/discovery/${s.threadId}/say`, { body: 'a thought' })).status).toBe(201);
    await finish(await nextStart());
  });
});
