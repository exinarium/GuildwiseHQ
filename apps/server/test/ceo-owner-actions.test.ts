import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { addMemory, relevantMemories } from '../src/ceo/memory.ts';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { act, appoint, ceo, keepOnline, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * What the CEO does inside an owner turn (docs/design/ceo-front-door.md sections 4, 6.2, 7 and 14.1): permission questions on
 * the desk, inline confirmations, corrections, the off-board job log and its repeats, and the server's backstop.
 */
let w: World;
let threadId: string;
let r: FakeRunner;
let b: Browser;
let orgId: string;

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const as = (cookie: string, method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie, body, headers: { 'x-aom-org': orgId } });
const FULL_POWER = ['ceo:1', 'ceo-full-power:1'];

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  await appoint(w);
  orgId = (await q(`SELECT id FROM organizations WHERE owner_user_id=$1 LIMIT 1`, [w.owner.id]))[0]!.id;
  threadId = (await ok<any>(owner('POST', '/api/ceo/chat'))).threadId;
  r = await w.connectRunner({ capabilities: FULL_POWER });
  await keepOnline(w);
  await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
    w.workstationId,
    FULL_POWER,
  ]);
  b = await Browser.open(w.baseUrl, w.owner.cookie);
  await b.hello();
});
afterAll(async () => {
  b.close();
  r.close();
  await w.t.close();
  await closeAdminPool();
});

let seq = 0;
let current: any;
/** Time passes for the server and the sessions (a session lives 30 days). */
const advance = async (ms: number) => {
  w.t.clock.advance(ms);
  await q(`UPDATE auth_sessions SET last_seen_at=$1, expires_at='2099-01-01'`, [w.t.clock.now()]);
};
/** An owner turn that stays open: the rpc calls of `aom ceo` run inside it. */
async function openTurn(text = `turn ${++seq}`) {
  b.send({ type: 'chat.send', threadId, body: text, clientMsgId: `m-${seq}-${Math.random()}` });
  current = (await r.waitFor('chat.start', (f: any) => f.message === text)) as any;
  return current;
}
// a failed test must not leave its turn open: the next message would be refused as busy
afterEach(async () => {
  if (!current) return;
  const open = (await q(`SELECT 1 FROM ceo_turns WHERE id=$1 AND status='running'`, [current.chatId])).length;
  if (open) await finish(current).catch(() => undefined);
  current = undefined;
});
const finish = async (start: any, extra: Record<string, unknown> = {}, text = 'done') => {
  r.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: text,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    runtimeSessionId: 'sess-x',
    ...extra,
  });
  await until(
    async () =>
      (await q(`SELECT 1 FROM ceo_turns WHERE id=$1 AND status='done'`, [start.chatId])).length === 1,
    5000,
    'turn done',
  );
};
/** Finishes a CEO wake the way the runner does: the terminal report, then `shift.ended`. */
async function endWake(shiftId: string) {
  const { reportId } = r.report(shiftId, {
    kind: 'outcome',
    outcomeId: 'ceo_done',
    note: 'done',
    data: { summary: 'handled' },
  });
  await r.waitFor('shift.report.result', (f: any) => f.reportId === reportId);
  r.ended(shiftId, 'reported');
  await r.barrier();
}
const rpc = (start: any, params: Record<string, unknown>) => ceo(r, start.chatId, params);
const deskStatus = async (id: string) =>
  (await q('SELECT status, blocking FROM desk_items WHERE id=$1', [id]))[0]!;

describe('"authorize this execution" (docs section 14.1)', () => {
  it('raises a desk question; an Owner or Admin answers once, for the turn or deny; a member cannot', async () => {
    const start = await openTurn();
    const ask = await rpc(start, {
      op: 'permission',
      sub: 'ask',
      tool: 'Bash',
      input: 'rm -rf build',
      reason: 'clean the build',
    });
    expect(ask.ok).toBe(true);
    const { askId, deskItemId } = ask.result;
    const item = (await q('SELECT * FROM desk_items WHERE id=$1', [deskItemId]))[0]!;
    expect(item).toMatchObject({
      kind: 'approval',
      subkind: 'ceo_permission',
      blocking: true,
      status: 'open',
    });
    expect(item.title).toContain('Authorize this execution');
    expect(item.options.map((o: any) => o.id)).toEqual(['once', 'turn', 'deny']);
    expect((await rpc(start, { op: 'permission', sub: 'poll', askId })).result).toEqual({
      status: 'pending',
    });
    // the same question again is the same question
    const again = await rpc(start, { op: 'permission', sub: 'ask', tool: 'Bash', input: 'rm -rf build' });
    expect(again.result.askId).toBe(askId);
    // it shows in the chat state, and a member of the organization cannot answer
    expect(
      (await ok<any>(owner('GET', '/api/ceo/chat/state'))).permissions.map((p: any) => p.askId),
    ).toContain(askId);
    const member = await w.t.userSession(uniqueEmail('member'));
    await w.t.addOrgMember(orgId, member.id, 'member');
    expect(
      (await as(member.cookie, 'POST', `/api/ceo/permissions/${askId}`, { decision: 'once' })).status,
    ).toBe(403);
    // an Admin authorizes for the turn
    const admin = await w.t.userSession(uniqueEmail('admin'));
    await w.t.addOrgMember(orgId, admin.id, 'admin');
    await ok(as(admin.cookie, 'POST', `/api/ceo/permissions/${askId}`, { decision: 'turn' }));
    expect((await rpc(start, { op: 'permission', sub: 'poll', askId })).result).toEqual({ status: 'turn' });
    expect((await deskStatus(deskItemId)).status).not.toBe('open');
    const ev = (
      await q(`SELECT payload FROM events WHERE type='CeoPermissionAnswered' AND payload->>'askId'=$1`, [
        askId,
      ])
    )[0]!;
    expect(ev.payload).toMatchObject({ decision: 'turn', by: admin.id, tool: 'Bash' });
    // answered twice: conflict
    expect((await owner('POST', `/api/ceo/permissions/${askId}`, { decision: 'deny' })).status).toBe(409);

    // deny
    const second = await rpc(start, { op: 'permission', sub: 'ask', tool: 'Edit', input: '/etc/hosts' });
    await ok(owner('POST', `/api/ceo/permissions/${second.result.askId}`, { decision: 'deny' }));
    expect(
      (await rpc(start, { op: 'permission', sub: 'poll', askId: second.result.askId })).result.status,
    ).toBe('deny');

    // the generic desk button: approved is once
    const third = await rpc(start, {
      op: 'permission',
      sub: 'ask',
      tool: 'WebFetch',
      input: 'https://example.com',
    });
    await ok(owner('POST', `/api/desk/${third.result.deskItemId}/resolve`, { resolution: 'approved' }));
    expect(
      (await rpc(start, { op: 'permission', sub: 'poll', askId: third.result.askId })).result.status,
    ).toBe('once');

    // ten minutes without an answer is a deny, and the desk item closes itself
    const fourth = await rpc(start, {
      op: 'permission',
      sub: 'ask',
      tool: 'Bash',
      input: 'docker system prune',
    });
    await advance(10 * 60_000 + 1000);
    expect(
      (await rpc(start, { op: 'permission', sub: 'poll', askId: fourth.result.askId })).result.status,
    ).toBe('timeout');
    expect((await deskStatus(fourth.result.deskItemId)).status).not.toBe('open');

    // a question still open when the turn ends is closed with it
    const fifth = await rpc(start, { op: 'permission', sub: 'ask', tool: 'Bash', input: 'make deploy' });
    await finish(start);
    expect(
      (await q('SELECT status FROM ceo_permission_asks WHERE id=$1', [fifth.result.askId]))[0]!.status,
    ).toBe('timeout');
    expect((await deskStatus(fifth.result.deskItemId)).status).not.toBe('open');
  });
});

describe('inline confirmations (docs section 6.2)', () => {
  it('a recommend verdict in an owner turn is a card answered by the Owner session, not by text', async () => {
    const card = await w.card({ title: 'Old experiment' });
    const start = await openTurn();
    const res = await rpc(start, {
      op: 'act',
      action: 'cancel-card',
      params: { card: card.ref },
      reason: 'the owner asked to drop it',
      confidence: 0.95,
      evidence: [],
    });
    expect(res.result.status).toBe('recommended');
    expect(res.result.message).toContain('Approve / No card');
    const item = (await q('SELECT * FROM desk_items WHERE id=$1', [res.result.deskItemId]))[0]!;
    expect(item.data.inlineTurnId).toBe(start.chatId);
    const state = await ok<any>(owner('GET', '/api/ceo/chat/state'));
    expect(state.confirmations).toHaveLength(1);
    expect(state.confirmations[0]).toMatchObject({
      actionId: res.result.actionId,
      deskItemId: item.id,
      turnId: start.chatId,
    });
    // another user cannot confirm; the Owner's session approves and the action runs
    const admin = await w.t.userSession(uniqueEmail('admin'));
    await w.t.addOrgMember(orgId, admin.id, 'admin');
    expect(
      (
        await as(admin.cookie, 'POST', `/api/ceo/turns/${start.chatId}/confirm`, {
          actionId: res.result.actionId,
          approve: true,
        })
      ).status,
    ).toBe(403);
    await ok(
      owner('POST', `/api/ceo/turns/${start.chatId}/confirm`, {
        actionId: res.result.actionId,
        approve: true,
      }),
    );
    await until(
      async () => (await q('SELECT status FROM cards WHERE id=$1', [card.id]))[0]!.status === 'cancelled',
      5000,
      'card cancelled by the confirmed action',
    );
    expect(
      (
        await owner('POST', `/api/ceo/turns/${start.chatId}/confirm`, {
          actionId: res.result.actionId,
          approve: true,
        })
      ).status,
    ).toBe(404);
    // "No": the item closes, the card stays
    const card2 = await w.card({ title: 'Keep me' });
    const res2 = await rpc(start, {
      op: 'act',
      action: 'cancel-card',
      params: { card: card2.ref },
      reason: 'maybe drop it',
      confidence: 0.9,
      evidence: [],
    });
    await ok(
      owner('POST', `/api/ceo/turns/${start.chatId}/confirm`, {
        actionId: res2.result.actionId,
        approve: false,
      }),
    );
    expect((await q('SELECT status FROM cards WHERE id=$1', [card2.id]))[0]!.status).not.toBe('cancelled');
    expect((await ok<any>(owner('GET', '/api/ceo/chat/state'))).confirmations).toHaveLength(0);
    const sys = await q(
      `SELECT body FROM thread_messages WHERE thread_id=$1 AND author_kind='system' ORDER BY created_at`,
      [threadId],
    );
    expect(sys.map((x) => x.body).join('|')).toContain('You approved');
    expect(sys.map((x) => x.body).join('|')).toContain('You declined');
    await finish(start);
  });

  it('the same verdict in a wake is a plain recommendation (no inline card)', async () => {
    const card = await w.card({ title: 'Another one' });
    await wakeNow(w);
    const wake = await startCeoShift(w, r, r.received.length);
    const res = await act(r, wake.shiftId, 'cancel-card', { card: card.ref });
    expect(res.result.status).toBe('recommended');
    expect(res.result.message).toContain('Recommended to the owner');
    const item = (await q('SELECT data FROM desk_items WHERE id=$1', [res.result.deskItemId]))[0]!;
    expect(item.data.inlineTurnId).toBeUndefined();
    await endWake(wake.shiftId);
  });
});

describe('corrections (docs section 7)', () => {
  it('the CEO records a correction in the owner turn: memory active at once, first in the brief, undo on request', async () => {
    const card = await w.card({ title: 'Prioritise me' });
    const start = await openTurn();
    const made = await rpc(start, {
      op: 'act',
      action: 'priority',
      params: { card: card.ref, to: 1 },
      reason: 'the owner asked for it',
      confidence: 0.9,
      evidence: [],
    });
    expect(made.result.status).toBe('executed');
    const actionId = made.result.actionId;
    const res = await rpc(start, {
      op: 'correction',
      action: actionId,
      text: 'I would rather you left priorities to me',
      rule: 'Never change card priorities without asking the owner first.',
      remedy: 'undo',
    });
    expect(res.ok).toBe(true);
    expect(res.result.message).toContain('Noted: Never change card priorities');
    const c = (await q('SELECT * FROM ceo_corrections WHERE action_id=$1', [actionId]))[0]!;
    expect(c).toMatchObject({
      remedy: 'undo',
      class: 'card.reprioritise',
      chat_message_id: expect.any(String),
    });
    const mem = (await q('SELECT * FROM ceo_memories WHERE id=$1', [c.memory_id]))[0]!;
    expect(mem).toMatchObject({
      kind: 'correction',
      status: 'active',
      source: 'owner_correction',
      class: 'card.reprioritise',
    });
    expect(Number(mem.confidence)).toBe(1);
    // the action was undone
    expect((await q('SELECT status FROM ceo_actions WHERE id=$1', [actionId]))[0]!.status).toBe('undone');
    expect((await q('SELECT priority FROM cards WHERE id=$1', [card.id]))[0]!.priority).toBe(card.priority);
    // it shows in the chat card list and in the Activity row
    const state = await ok<any>(owner('GET', '/api/ceo/chat/state'));
    expect(state.corrections[0]).toMatchObject({
      rule: expect.stringContaining('Never change card priorities'),
      canRedo: true,
    });
    const acts = await ok<any>(owner('GET', '/api/ceo/actions'));
    expect(acts.actions.find((a: any) => a.id === actionId).correction).toMatchObject({ id: c.id });
    // the owner edits the rule in the card
    await ok(owner('PATCH', `/api/ceo/corrections/${c.id}`, { rule: 'Ask before changing any priority.' }));
    expect((await q('SELECT rule FROM ceo_corrections WHERE id=$1', [c.id]))[0]!.rule).toBe(
      'Ask before changing any priority.',
    );
    const mems = await relevantMemories(w.t.app.ctx, orgId, '');
    expect(mems[0]).toMatchObject({ kind: 'correction', text: 'Ask before changing any priority.' });
    await finish(start);
  });

  it('corrections rank first, and a correction or a rule supersedes an inferred pattern of the same class', async () => {
    const ctx = w.t.app.ctx;
    await addMemory(ctx, {
      orgId,
      kind: 'rule',
      source: 'owner_statement',
      confidence: 0.95,
      status: 'active',
      text: 'A plain rule.',
      byUserId: w.owner.id,
    });
    await addMemory(ctx, {
      orgId,
      kind: 'preference',
      source: 'owner_statement',
      confidence: 0.99,
      status: 'active',
      text: 'A preference.',
      byUserId: w.owner.id,
    });
    await addMemory(ctx, {
      orgId,
      kind: 'decision_pattern',
      source: 'owner_training',
      confidence: 0.99,
      status: 'active',
      text: 'The owner usually releases quickly (card release).',
      cls: 'card.release',
    });
    await addMemory(ctx, {
      orgId,
      kind: 'decision_pattern',
      source: 'owner_training',
      confidence: 0.9,
      status: 'active',
      text: 'The owner usually hires quickly (agent hiring).',
      cls: 'agent.hire',
    });
    await addMemory(ctx, {
      orgId,
      kind: 'correction',
      scope: 'class:card.release',
      source: 'owner_correction',
      confidence: 1,
      status: 'active',
      text: 'Never release without the owner (card release).',
      cls: 'card.release',
      byUserId: w.owner.id,
    });
    const mems = await relevantMemories(ctx, orgId, 'card release hiring agent');
    const kinds = mems.map((m) => m.kind);
    expect(kinds.indexOf('correction')).toBeLessThan(kinds.indexOf('rule'));
    expect(kinds.indexOf('rule')).toBeLessThan(kinds.indexOf('preference'));
    expect(mems.find((m) => m.text.startsWith('The owner usually releases'))).toBeUndefined();
    expect(mems.find((m) => m.text.startsWith('The owner usually hires'))).toBeDefined();
  });

  it('the Activity path: an Admin records a rule only; the Owner may undo and redo', async () => {
    const card = await w.card({ title: 'Redo me' });
    await wakeNow(w);
    const wake = await startCeoShift(w, r, r.received.length);
    const made = await act(r, wake.shiftId, 'priority', { card: card.ref, to: 2 });
    expect(made.result.status).toBe('executed');
    const actionId = made.result.actionId;
    await endWake(wake.shiftId);
    const admin = await w.t.userSession(uniqueEmail('admin'));
    await w.t.addOrgMember(orgId, admin.id, 'admin');
    // an Admin: rule-only
    expect(
      (
        await as(admin.cookie, 'POST', '/api/ceo/corrections', {
          actionId,
          text: 'Undo that please',
          rule: 'x y z',
          remedy: 'undo',
        })
      ).status,
    ).toBe(403);
    const ruleOnly = await ok<any>(
      as(admin.cookie, 'POST', '/api/ceo/corrections', {
        actionId,
        text: 'Leave priorities alone',
        rule: 'Leave priorities alone, please.',
      }),
    );
    expect(ruleOnly.memoryId).toBeTruthy();
    // the Owner: undo, and redo as another priority
    const undone = await ok<any>(
      owner('POST', '/api/ceo/corrections', { actionId, text: 'Undo it', remedy: 'undo', makeRule: false }),
    );
    expect(undone.remedyResult).toContain('priority');
    expect(undone.memoryId).toBeNull();
    expect((await q('SELECT status FROM ceo_actions WHERE id=$1', [actionId]))[0]!.status).toBe('undone');
    const redo = await ok<any>(
      owner('POST', '/api/ceo/corrections', {
        actionId,
        text: 'Make it priority 3 instead',
        remedy: 'redo',
        redo: { action: 'priority', params: { card: card.ref, to: 3 } },
      }),
    );
    expect(redo.remedyResult).toContain('Redone');
    expect((await q('SELECT priority FROM cards WHERE id=$1', [card.id]))[0]!.priority).toBe(3);
    // the redo is an audited action of the CEO that points back at the correction
    const redone = (
      await q(`SELECT * FROM ceo_actions WHERE idem_key=$1`, [`redo:${redo.correctionId}`])
    )[0]!;
    expect(redone).toMatchObject({ mode: 'decided', accepted_from: redo.correctionId });
  });
});

describe('the off-system job log and its repeats (docs sections 4.2, 4.3 and 14.5)', () => {
  const log = (start: any, kind: string, extra: Record<string, unknown> = {}) =>
    rpc(start, { op: 'job', sub: 'log', kind, title: `${kind} job`, summary: 'did it', ...extra });
  const repeats = async () => (await ok<any>(owner('GET', '/api/ceo/repeats'))).repeats as any[];

  /** One job on its own turn (a turn must not stay open across days: its shift would be days long). */
  const jobOn = async (kind: string, extra: Record<string, unknown> = {}) => {
    const start = await openTurn();
    const res = await log(start, kind, extra);
    await finish(start);
    return res;
  };

  it('4 jobs of one kind in 7 days is a repeat (a skill, here); 3 are not; the owner can dismiss it for 90 days', async () => {
    for (let i = 0; i < 3; i++) expect((await jobOn('invoice-export')).ok).toBe(true);
    expect(await repeats()).toHaveLength(0);
    const fourth = await jobOn('invoice-export');
    expect(fourth.result.message).toContain('repeat');
    const list = await repeats();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: 'invoice-export', suggestion: 'skill', count7: 4 });
    expect(list[0].jobs).toHaveLength(4);
    const start = await openTurn();
    expect((await rpc(start, { op: 'job', sub: 'repeats' })).result.text).toContain('invoice-export');
    await finish(start);
    // dismissed: the key is quiet for 90 days
    await ok(owner('POST', `/api/ceo/repeats/${list[0].id}/resolve`, { decision: 'dismissed' }));
    expect(await repeats()).toHaveLength(0);
    for (let i = 0; i < 5; i++) await jobOn('invoice-export');
    expect(await repeats()).toHaveLength(0);
    await advance(91 * 86_400_000);
    for (let i = 0; i < 4; i++) await jobOn('invoice-export');
    expect(await repeats()).toHaveLength(1);
  });

  it('10 jobs in 30 days is a repeat too, a project job suggests a feature, the same command suggests an automation', async () => {
    for (let i = 0; i < 9; i++) {
      await jobOn('weekly-sweep');
      await advance(3 * 86_400_000);
    }
    expect((await repeats()).find((x) => x.key === 'weekly-sweep')).toBeUndefined();
    await jobOn('weekly-sweep');
    expect((await repeats()).find((x) => x.key === 'weekly-sweep')).toMatchObject({
      count30: 10,
      suggestion: 'skill',
    });
    for (let i = 0; i < 4; i++) await jobOn('toy-release-notes', { project: 'TOY' });
    expect((await repeats()).find((x) => x.key === 'toy-release-notes')).toMatchObject({
      suggestion: 'feature',
      projectKey: 'TOY',
    });
    for (let i = 0; i < 4; i++) await jobOn('db-dump', { command: 'pg_dump -Fc toy' });
    expect((await repeats()).find((x) => x.key === 'db-dump')).toMatchObject({ suggestion: 'automation' });
    expect((await jobOn('x', { project: 'NOPE' })).result.status).toBe('refused');
  });

  it('`job start` remembers the kind for the log', async () => {
    const start = await openTurn();
    expect(
      (await rpc(start, { op: 'job', sub: 'start', kind: 'Direct Edit', why: 'the owner said so' })).result
        .message,
    ).toContain('direct-edit');
    await rpc(start, { op: 'job', sub: 'log', summary: 'edited a file' });
    const j = (await q(`SELECT kind, title FROM ceo_offboard_jobs WHERE turn_id=$1`, [start.chatId]))[0]!;
    expect(j).toMatchObject({ kind: 'direct-edit', title: 'the owner said so' });
    await finish(start);
  });

  it('the server backstop logs an unlabelled job when tools were used, no board object was made and nothing was logged', async () => {
    const used = await openTurn('Please export the March invoices\nand zip them');
    await finish(used, { toolCounts: { bash: 4, edit: 0, mcp: 0, other: 0 } });
    const auto = (await q(`SELECT * FROM ceo_offboard_jobs WHERE turn_id=$1`, [used.chatId]))[0]!;
    expect(auto).toMatchObject({ kind: 'unlabelled', auto: true, title: 'Please export the March invoices' });
    // only an answer: nothing logged
    const answer = await openTurn('How many cards are open?');
    await finish(answer, { toolCounts: { bash: 0, edit: 0, mcp: 0, other: 2 } });
    expect(await q(`SELECT 1 FROM ceo_offboard_jobs WHERE turn_id=$1`, [answer.chatId])).toHaveLength(0);
    // a board object (an intake) means the work went through the system
    const board = await openTurn('Put this on the board');
    await rpc(board, {
      op: 'act',
      action: 'intake',
      params: { project: 'TOY', text: 'Add a dark mode to the settings page please', cardType: 'feature' },
      reason: 'the owner asked',
      confidence: 0.9,
      evidence: [],
    });
    await finish(board, { toolCounts: { bash: 2, edit: 0, mcp: 0, other: 0 } });
    expect(await q(`SELECT 1 FROM ceo_offboard_jobs WHERE turn_id=$1`, [board.chatId])).toHaveLength(0);
    // an explicit log wins over the backstop
    const logged = await openTurn('Run the thing');
    await log(logged, 'run-thing');
    await finish(logged, { toolCounts: { bash: 2, edit: 0, mcp: 0, other: 0 } });
    expect(await q(`SELECT 1 FROM ceo_offboard_jobs WHERE turn_id=$1`, [logged.chatId])).toHaveLength(1);
  });
});

describe('directories and the runner restart', () => {
  it('`dir add` persists on the thread and goes out with the next turn; a restart is announced after reconnect', async () => {
    const start = await openTurn();
    const added = await rpc(start, { op: 'dir', sub: 'add', path: '/home/owner/src/foo' });
    expect(added.result.status).toBe('executed');
    expect((await q('SELECT dirs FROM threads WHERE id=$1', [threadId]))[0]!.dirs).toEqual([
      '/home/owner/src/foo',
    ]);
    expect((await rpc(start, { op: 'restart', reason: 'new toolchain' })).result.status).toBe('executed');
    expect(
      await q(`SELECT 1 FROM events WHERE type='RunnerRestartRequested' AND payload->>'by'=$1`, [
        `turn:${start.chatId}`,
      ]),
    ).toHaveLength(1);
    await finish(start);
    const next = await openTurn();
    expect(next.addDirs).toEqual(['/home/owner/src/foo']);
    await finish(next);
    // the runner restarts: it reconnects and the CEO thread gets the line
    r.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'offline');
    r = await w.connectRunner({ capabilities: FULL_POWER });
    await r.barrier();
    await until(
      async () =>
        (await q(`SELECT 1 FROM thread_messages WHERE thread_id=$1 AND data->>'restart'='true'`, [threadId]))
          .length === 1,
      5000,
      'restart line',
    );
    const line = (
      await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND data->>'restart'='true'`, [threadId])
    )[0]!;
    expect(line.body).toContain('restarted (runner 0.0.0-test)');
  });
});
