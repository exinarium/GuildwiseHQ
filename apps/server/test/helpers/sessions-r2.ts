import { randomUUID } from 'node:crypto';
import { q as rawQ } from './db.ts';
import type { FakeRunner } from './fake-runner.ts';
import { ok, until, type World } from './world.ts';

/** Shared plumbing of the R2 session suites (ownership, limits, board features, hand-off). */
export const q = async (sql: string, params: unknown[] = []): Promise<any[]> =>
  rawQ(sql, params) as Promise<any[]>;

/** The two fixed seats and three other opinion seats: the smallest cast of a new boardroom. */
export const CAST5 = [
  { kind: 'persona', refId: 'optimist' },
  { kind: 'persona', refId: 'devils-advocate' },
  { kind: 'persona', refId: 'user-advocate' },
  { kind: 'persona', refId: 'cost-hawk' },
  { kind: 'persona', refId: 'security' },
];

export function kit(w: World, getRunner: () => FakeRunner) {
  const seen = new Set<string>();
  // a member acts in the owner's organization (their own default is the personal one they signed up with)
  const as = (cookie: string) => (method: string, url: string, body?: unknown) =>
    w.t.req(method, url, {
      cookie,
      headers: { 'x-aom-org': w.owner.id },
      ...(body !== undefined ? { body } : {}),
    });
  const raw = as(w.owner.cookie);
  const owner = (method: string, url: string, body?: unknown, expected = 200) =>
    ok<any>(raw(method, url, body), expected);
  const createBoard = async (over: Record<string, unknown> = {}) =>
    (
      await owner(
        'POST',
        '/api/board',
        {
          topic: 'Should we launch a pilot?',
          brief: 'One friendly customer, eight weeks.',
          cast: CAST5,
          roundCap: 3,
          ...over,
        },
        201,
      )
    ).state;
  const board = async (id: string) => (await owner('GET', `/api/board/${id}`)).state;
  const createDiscovery = async (over: Record<string, unknown> = {}) =>
    (
      await owner(
        'POST',
        '/api/discovery',
        { title: 'Invoicing idea', idea: 'Invoices for freelancers', ...over },
        201,
      )
    ).state;
  const discovery = async (id: string) => (await owner('GET', `/api/discovery/${id}`)).state;
  const nextStart = async (threadId: string, pred: (f: any) => boolean = () => true): Promise<any> => {
    const f = await getRunner().waitFor(
      'chat.start',
      (x) => !seen.has(x.chatId) && x.threadId === threadId && pred(x),
      15_000,
    );
    seen.add(f.chatId);
    return f;
  };
  const role = (name: string) => (f: any) => f.message.includes(`"role":"${name}"`);
  const call = async (turnId: string, method: string, params: Record<string, unknown> = {}) => {
    const r = getRunner();
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
    getRunner().send('chat.done', {
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
  /** Turns that started since the last look and belong to this thread (nothing waited for). */
  const startedSince = (threadId: string) =>
    getRunner().received.filter(
      (f: any) => f.type === 'chat.start' && !seen.has(f.chatId) && f.threadId === threadId,
    );
  /** Waits for a quiet moment, then returns the unseen starts of a thread. */
  const quiet = async (threadId: string, ms = 400) => {
    await new Promise((res) => setTimeout(res, ms));
    return startedSince(threadId);
  };
  /** Every turn of this suite that is still open is paused and cancelled, so the next test starts clean. */
  const cleanup = async () => {
    const r = getRunner();
    let calm = 0;
    for (let pass = 0; pass < 20 && calm < 2; pass++) {
      const open = await q(
        `SELECT id, thread_id, status FROM session_turns WHERE status IN ('queued','running')`,
      );
      if (!open.length) {
        calm++;
        await new Promise((res) => setTimeout(res, 150));
        continue;
      }
      calm = 0;
      for (const th of new Set(open.map((t) => t.thread_id as string))) {
        await raw('POST', `/api/board/${th}/pause`);
        await raw('POST', `/api/discovery/${th}/pause`);
      }
      for (const t of open.filter((x) => x.status === 'queued'))
        await w.t.app.ctx.services.sessions.cancelAll(w.owner.id, t.thread_id).catch(() => undefined);
      for (const t of open.filter((x) => x.status === 'running'))
        r.send('chat.error', { chatId: t.id, threadId: t.thread_id, error: 'cancelled' });
      await new Promise((res) => setTimeout(res, 150));
    }
  };
  /** Advances the test clock minute by minute, with a sweep after each (the clock counts at most a minute per tick). */
  const tickMinutes = async (n: number, sweeps: Array<() => Promise<void>>) => {
    for (let i = 0; i < n; i++) {
      w.t.clock.advance(60_000);
      for (const s of sweeps) await s();
    }
  };
  return {
    seen,
    as,
    raw,
    owner,
    createBoard,
    board,
    createDiscovery,
    discovery,
    nextStart,
    role,
    call,
    finish,
    startedSince,
    quiet,
    cleanup,
    tickMinutes,
  };
}
