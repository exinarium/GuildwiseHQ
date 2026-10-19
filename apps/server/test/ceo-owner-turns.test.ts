import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { Browser } from './helpers/browser.ts';
import { appoint, ceo, keepOnline, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * The owner's chat with the CEO as a full session (docs/design/ceo-front-door.md section 5): provenance decided by the
 * server, the model switch, queueing while the workstation is offline, and the chat state the page reads.
 */
let w: World;
let threadId: string;
let r: FakeRunner | undefined;
let b: Browser;

const orgIdOf = async () =>
  (
    await q(`SELECT id FROM organizations WHERE owner_user_id=$1 ORDER BY created_at LIMIT 1`, [w.owner.id])
  )[0]!.id as string;
const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const FULL_POWER = ['ceo:1', 'ceo-full-power:1'];
const OPUS = { runtime: 'claude-code', model: 'opus', effort: 'high' };

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  await appoint(w);
  threadId = (await ok<any>(owner('POST', '/api/ceo/chat'))).threadId;
  b = await Browser.open(w.baseUrl, w.owner.cookie);
  await b.hello();
});
afterAll(async () => {
  b.close();
  r?.close();
  await w.t.close();
  await closeAdminPool();
});

const send = (body: string, extra: Record<string, unknown> = {}) =>
  b.send({ type: 'chat.send', threadId, body, clientMsgId: `m-${Math.random()}`, ...extra });
const done = (
  start: any,
  text: string,
  extra: Record<string, unknown> = {},
  usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
) =>
  r?.send('chat.done', {
    chatId: start.chatId,
    threadId: start.threadId,
    messageText: text,
    usage,
    ...extra,
  });
const turn = async (id: string) => (await q('SELECT * FROM ceo_turns WHERE id=$1', [id]))[0]!;
const connect = async (caps = FULL_POWER) => {
  r?.close();
  r = await w.connectRunner({ capabilities: caps });
  await keepOnline(w);
  await q(`UPDATE workstation_capabilities SET capabilities=$2::text[] WHERE workstation_id=$1`, [
    w.workstationId,
    caps,
  ]);
  return r;
};

describe('provenance: the server decides, the runner enforces', () => {
  it('only the Owner on the CEO thread gets an owner turn, with the full brief and the fixed working directory', async () => {
    await connect();
    await ok(owner('PUT', '/api/ceo/settings', { ownerTurn: { cwd: '/home/owner/work' } }));
    send('Hello, how are things?');
    const start = (await r?.waitFor('chat.start')) as any;
    expect(start).toMatchObject({
      threadId,
      message: 'Hello, how are things?',
      ceoMode: 'owner',
      cwd: '/home/owner/work',
    });
    // the static brief carries the routing rule and the verbs; the first turn carries the dynamic context
    expect(start.context.ceo.brief).toContain('Use the system first');
    expect(start.context.ceo.brief).toContain('aom runner restart');
    expect(start.briefDelta).toContain("The owner's rules");
    expect(start.resumeSessionId).toBeUndefined();
    const t = await turn(start.chatId);
    expect(t).toMatchObject({ mode: 'owner', status: 'running', queued: false, thread_id: threadId });
    expect(
      (
        await q(`SELECT payload->>'mode' AS mode FROM events WHERE type='ShiftStarted' AND stream_id=$1`, [
          `shift-${start.chatId}`,
        ])
      )[0]?.mode,
    ).toBe('owner');
    // a second message while it runs is busy
    send('Another one');
    await b.until(() => b.of('chat.error').some((m) => m.reason === 'busy'));
    done(start, 'All good.', { runtimeSessionId: 'sess-a' });
    await until(async () => (await turn(start.chatId)).status === 'done', 5000, 'turn done');
    expect((await turn(start.chatId)).finished_at).toBeTruthy();
  });

  it('an Admin cannot talk to the CEO, and a wake shift never gets an owner origin', async () => {
    const admin = await w.t.userSession(uniqueEmail('admin-ceo'));
    await w.t.addOrgMember(await orgIdOf(), admin.id, 'admin');
    const res = await w.t.req('POST', '/api/ceo/chat', {
      cookie: admin.cookie,
      headers: { 'x-aom-org': await orgIdOf() },
    });
    expect(res.status).toBe(403);
    // a restricted wake: its `aom ceo` origin comes from ceo_batches (no ceo_turns row), so owner-only verbs are refused
    await wakeNow(w);
    const wake = await startCeoShift(w, r as FakeRunner, (r as FakeRunner).received.length);
    const corr = await ceo(r as FakeRunner, wake.shiftId, {
      op: 'correction',
      text: 'you were wrong',
      rule: 'do not do that',
    });
    expect(corr.ok).toBe(false);
    expect(corr.error).toContain("owner's chat turn");
    const job = await ceo(r as FakeRunner, wake.shiftId, { op: 'job', sub: 'log', kind: 'x', title: 'y' });
    expect(job.ok).toBe(false);
    const perm = await ceo(r as FakeRunner, wake.shiftId, { op: 'permission', sub: 'ask', tool: 'Bash' });
    expect(perm.ok).toBe(false);
    r?.report(wake.shiftId, {
      kind: 'outcome',
      outcomeId: 'ceo_done',
      note: 'done',
      data: { summary: 'handled' },
    });
    r?.ended(wake.shiftId);
  });
});

describe('the model switch', () => {
  it('resolves message, then thread, then default; a runtime change starts a new session with a handover', async () => {
    await connect();
    // turn 1: the default (the agent runtime is `mock`, the chat model of the CEO settings)
    send('first');
    const s1 = (await r?.waitFor('chat.start', (f: any) => f.message === 'first')) as any;
    expect(s1.agent).toMatchObject({ runtime: 'mock', model: 'sonnet', effort: 'medium' });
    done(s1, 'one', { runtimeSessionId: 'sess-mock' });
    await b.until(() => b.of('chat.done').length >= 2);
    // turn 2: one message on Opus (another runtime: a fresh session and a handover, never a resume)
    send('think hard', { model: OPUS, modelScope: 'message' });
    const s2 = (await r?.waitFor('chat.start', (f: any) => f.message === 'think hard')) as any;
    expect(s2.agent).toMatchObject({ runtime: 'claude-code', model: 'opus', effort: 'high' });
    expect(s2.resumeSessionId).toBeUndefined();
    expect(s2.briefDelta).toContain('Handover');
    expect((await turn(s2.chatId)).model).toEqual(OPUS);
    done(s2, 'two', { runtimeSessionId: 'sess-claude' });
    await b.until(() => b.of('chat.done').length >= 3);
    const reply = (
      await q(`SELECT data FROM thread_messages WHERE thread_id=$1 AND body='two'`, [threadId])
    )[0]!.data;
    expect(reply).toMatchObject({
      runtime: 'claude-code',
      model: 'Opus (high)',
      runtimeSessionId: 'sess-claude',
    });
    // turn 3: the next message is back on the default and resumes the mock session
    send('back to normal');
    const s3 = (await r?.waitFor('chat.start', (f: any) => f.message === 'back to normal')) as any;
    expect(s3.agent).toMatchObject({ runtime: 'mock', model: 'sonnet' });
    expect(s3.resumeSessionId).toBe('sess-mock');
    done(s3, 'three', { runtimeSessionId: 'sess-mock' });
    await b.until(() => b.of('chat.done').length >= 4);
    // turn 4: "this conversation": the thread override sticks for the next messages, and the same runtime keeps its session
    send('from now on Opus', { model: OPUS, modelScope: 'thread' });
    const s4 = (await r?.waitFor('chat.start', (f: any) => f.message === 'from now on Opus')) as any;
    expect(s4.agent).toMatchObject({ runtime: 'claude-code', model: 'opus' });
    expect(s4.resumeSessionId).toBe('sess-claude');
    done(s4, 'four', { runtimeSessionId: 'sess-claude' });
    await b.until(() => b.of('chat.done').length >= 5);
    expect(
      (await q('SELECT model_override FROM threads WHERE id=$1', [threadId]))[0]!.model_override,
    ).toEqual(OPUS);
    send('still opus');
    const s5 = (await r?.waitFor('chat.start', (f: any) => f.message === 'still opus')) as any;
    expect(s5.agent).toMatchObject({ model: 'opus' });
    // a different Claude model keeps the session of the same runtime
    done(s5, 'five', { runtimeSessionId: 'sess-claude' });
    await b.until(() => b.of('chat.done').length >= 6);
    send('quick one', { model: { runtime: 'claude-code', model: 'haiku' }, modelScope: 'message' });
    const s6 = (await r?.waitFor('chat.start', (f: any) => f.message === 'quick one')) as any;
    expect(s6.agent).toMatchObject({ model: 'haiku' });
    expect(s6.agent.effort).toBeUndefined();
    expect(s6.resumeSessionId).toBe('sess-claude');
    done(s6, 'six', { runtimeSessionId: 'sess-claude' });
    await b.until(() => b.of('chat.done').length >= 7);
    // the thread override can be cleared again
    await ok(owner('PUT', '/api/ceo/chat/model', { choice: null }));
    expect(
      (await q('SELECT model_override FROM threads WHERE id=$1', [threadId]))[0]!.model_override,
    ).toBeNull();
  });

  it('refuses a model the registry does not offer', async () => {
    await connect();
    const before = b.of('chat.error').length;
    send('nope', { model: { runtime: 'claude-code', model: 'gpt-9' }, modelScope: 'message' });
    await b.until(() => b.of('chat.error').length > before);
    expect(b.of('chat.error').at(-1)).toMatchObject({ reason: 'unknown_model' });
    expect(
      (await owner('PUT', '/api/ceo/chat/model', { choice: { runtime: 'claude-code', model: 'gpt-9' } }))
        .status,
    ).toBe(409);
  });

  it('a long session rotates (24 hours) and an owner turn keeps its cost on the CEO shift', async () => {
    await connect();
    send('before rotation');
    const a = (await r?.waitFor('chat.start', (f: any) => f.message === 'before rotation')) as any;
    done(
      a,
      'ok',
      { runtimeSessionId: 'sess-long' },
      { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    );
    await b.until(() => b.of('chat.done').length >= 8);
    send('next day');
    const same = (await r?.waitFor('chat.start', (f: any) => f.message === 'next day')) as any;
    expect(same.resumeSessionId).toBe('sess-long');
    done(same, 'ok', { runtimeSessionId: 'sess-long' });
    await b.until(() => b.of('chat.done').length >= 9);
    w.t.clock.advance(25 * 3_600_000);
    send('a day later');
    const later = (await r?.waitFor('chat.start', (f: any) => f.message === 'a day later')) as any;
    expect(later.resumeSessionId).toBeUndefined();
    expect(later.briefDelta).toContain('Handover');
    done(later, 'ok', { runtimeSessionId: 'sess-new' });
    await b.until(() => b.of('chat.done').length >= 10);
    const shift = (await q('SELECT * FROM shifts WHERE id=$1', [a.chatId]))[0]!;
    expect(shift).toMatchObject({ kind: 'chat', status: 'ended' });
  });
});

describe('queueing while the workstation is offline', () => {
  it('saves the message, queues the turn, and sends queued messages in order when the runner is back', async () => {
    r?.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'offline');
    const queuedBefore = b.of('chat.queued').length;
    send('while you were away 1');
    send('while you were away 2');
    await b.until(() => b.of('chat.queued').length >= queuedBefore + 2);
    const turns = await q(
      `SELECT t.status, t.queued, m.body FROM ceo_turns t JOIN thread_messages m ON m.id=t.message_id
        WHERE t.thread_id=$1 AND t.status='queued' ORDER BY t.queued_at`,
      [threadId],
    );
    expect(turns.map((x) => [x.status, x.queued, x.body])).toEqual([
      ['queued', true, 'while you were away 1'],
      ['queued', true, 'while you were away 2'],
    ]);
    const msg = (await q(`SELECT data FROM thread_messages WHERE body='while you were away 1'`))[0]!;
    expect(msg.data.queued).toBe(true);
    const state = await ok<any>(owner('GET', '/api/ceo/chat/state'));
    expect(state.queued.map((x: any) => x.body)).toEqual(['while you were away 1', 'while you were away 2']);
    expect(state.fullPower.state).toBe('unknown');

    await connect();
    const first = (await r?.waitFor('chat.start', (f: any) => f.message === 'while you were away 1')) as any;
    expect(first.queuedAt).toBeTruthy();
    // one at a time: the second goes out only after the first reply
    await r?.barrier();
    expect(
      r?.received.filter((f: any) => f.type === 'chat.start' && f.message === 'while you were away 2'),
    ).toHaveLength(0);
    done(first, 'back online', { runtimeSessionId: 'sess-q' });
    const second = (await r?.waitFor('chat.start', (f: any) => f.message === 'while you were away 2')) as any;
    done(second, 'and the second', { runtimeSessionId: 'sess-q' });
    await until(
      async () =>
        (await q(`SELECT 1 FROM ceo_turns WHERE thread_id=$1 AND status='queued'`, [threadId])).length === 0,
      5000,
      'queue empty',
    );
    const waited = (await q(`SELECT data FROM thread_messages WHERE body='back online'`))[0]!.data;
    expect(waited.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it('a message older than 72 hours asks first: it is not sent until the owner says so, and can be dropped', async () => {
    r?.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'offline');
    send('a very old one');
    send('another old one');
    await b.until(() => b.of('chat.queued').length >= 4);
    await q(
      `UPDATE ceo_turns SET queued_at = queued_at - interval '4 days' WHERE thread_id=$1 AND status='queued'`,
      [threadId],
    );
    await connect();
    await r?.barrier();
    expect(r?.received.filter((f: any) => f.type === 'chat.start')).toHaveLength(0);
    const state = await ok<any>(owner('GET', '/api/ceo/chat/state'));
    expect(state.queued.every((x: any) => x.stale)).toBe(true);
    const [keep, drop] = state.queued;
    await ok(owner('POST', `/api/ceo/queue/${drop.turnId}`, { decision: 'drop' }));
    expect((await turn(drop.turnId)).status).toBe('dropped');
    await ok(owner('POST', `/api/ceo/queue/${keep.turnId}`, { decision: 'send' }));
    const start = (await r?.waitFor('chat.start')) as any;
    expect(start.message).toBe(keep.body);
    done(start, 'fine, still wanted', { runtimeSessionId: 'sess-s' });
    await until(async () => (await turn(keep.turnId)).status === 'done', 5000, 'sent turn done');
  });
});

describe('a turn survives the connection', () => {
  it('a dropped connection does not fail an owner turn; the reply arrives after the reconnect; a turn the runner lost fails', async () => {
    await connect();
    send('long one');
    const start = (await r?.waitFor('chat.start', (f: any) => f.message === 'long one')) as any;
    r?.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'offline');
    expect((await turn(start.chatId)).status).toBe('running');
    // the runner reconnects still running it (activeChats) and delivers the reply
    r = await w.connectRunner({ hello: false });
    r.send('hello', {
      runnerVersion: '0.0.0-test',
      protocol: 1,
      platform: 'linux',
      hostname: 'fake-host',
      runtimes: [{ id: 'mock', version: '1', available: true, capabilities: [] }],
      repos: [],
      vaults: [],
      activeShifts: [],
      activeChats: [start.chatId],
      outboxPending: 0,
      capabilities: FULL_POWER,
    });
    await r.waitFor('welcome');
    await r.barrier();
    expect((await turn(start.chatId)).status).toBe('running');
    done(start, 'survived', { runtimeSessionId: 'sess-surv' });
    await until(async () => (await turn(start.chatId)).status === 'done', 5000, 'delivered');

    // a turn the runner no longer holds after a reconnect is over
    await keepOnline(w);
    send('this one is lost');
    const lost = (await r.waitFor('chat.start', (f: any) => f.message === 'this one is lost')) as any;
    r.close();
    await until(async () => !w.t.app.ctx.services.runners.isOnline(w.workstationId), 3000, 'offline again');
    await q(`UPDATE ceo_turns SET started_at = started_at - interval '1 minute' WHERE id=$1`, [lost.chatId]);
    r = await w.connectRunner({ capabilities: FULL_POWER });
    await r.barrier();
    await until(async () => (await turn(lost.chatId)).status === 'failed', 5000, 'lost turn failed');
    expect((await turn(lost.chatId)).error).toContain('restarted');
  });
});

describe('the chat state the page reads', () => {
  it('reports full power, the model and the corrections list', async () => {
    await connect();
    const s = await ok<any>(owner('GET', '/api/ceo/chat/state'));
    expect(s).toMatchObject({
      threadId,
      fullPower: { state: 'on' },
      model: { default: { model: 'sonnet' }, thread: null },
      cwd: '/home/owner/work',
      busy: false,
      queued: [],
      permissions: [],
      confirmations: [],
      corrections: [],
    });
    await connect(['ceo:1']);
    expect(
      (await ok<any>(owner('GET', '/api/ceo/chat/status'.replace('chat/status', 'status')))).fullPower.state,
    ).toBe('off');
  });
});
