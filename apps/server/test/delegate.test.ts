import { randomUUID } from 'node:crypto';
import { DELEGATE_LIMITS, SESSION_TURNS_CAPABILITY, SESSION_VERBS_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q as rawQ } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

/**
 * `aom delegate` on the server (Phase E): the rpc the runner sends before a delegate starts (`delegate.begin`: verb by
 * purpose, caller running, budget, model, per-caller cap) and after it ended (`delegate.cost`: booked under the caller as
 * `DelegateCompleted`, replay-safe), for a session turn and for a shift.
 */
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
const create = async (over: Record<string, unknown> = {}) =>
  (
    await owner(
      'POST',
      '/api/discovery',
      { title: 'Delegation', idea: 'Invoices for freelancers', ...over },
      201,
    )
  ).state;
const nextStart = async (pred: (f: any) => boolean = () => true): Promise<any> => {
  const f = await r.waitFor('chat.start', (x) => !seen.has(x.chatId) && pred(x), 15_000);
  seen.add(f.chatId);
  return f;
};
const call = async (id: string, method: string, params: Record<string, unknown> = {}) => {
  const rpcId = randomUUID();
  const from = r.received.length;
  r.send('rpc.request', { rpcId, shiftId: id, method, params });
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
const HAIKU = { runtime: 'claude-code', model: 'haiku' };
const begin = (callerId: string, over: Record<string, unknown> = {}) => {
  const delegateId = randomUUID();
  return call(callerId, 'delegate.begin', {
    delegateId,
    persona: 'devils-advocate',
    model: HAIKU,
    taskChars: 40,
    ...over,
  }).then((res) => ({ ...res, delegateId: (over.delegateId as string | undefined) ?? delegateId }));
};
const cost = (callerId: string, delegateId: string, usage: Record<string, unknown> = {}, over = {}) =>
  call(callerId, 'delegate.cost', {
    delegateId,
    persona: 'devils-advocate',
    outcome: 'ok',
    usage: { inputTokens: 1_000_000, outputTokens: 100_000, model: 'claude-haiku-4-5', ...usage },
    ...over,
  });
/** A running facilitator turn of a new session. */
const facilitator = async (over: Record<string, unknown> = {}) => {
  const s = await create(over);
  const start = await nextStart((f) => f.threadId === s.threadId);
  return { s, start, id: start.chatId as string };
};

describe('delegate.begin for a session turn', () => {
  it('lets the facilitator delegate and refuses purposes the table does not allow', async () => {
    const { id, start } = await facilitator();
    expect((await begin(id)).ok).toBe(true);
    // the purpose table decides: the same turn with another purpose is refused (CEO answer, board speaker, cast, minutes)
    for (const purpose of ['ceo_answer', 'board_speaker', 'board_cast', 'board_minutes']) {
      await q(
        `UPDATE session_turns SET meta = jsonb_set(COALESCE(meta,'{}'), '{purpose}', to_jsonb($2::text)) WHERE id=$1`,
        [id, purpose],
      );
      const res = await begin(id);
      expect(res.ok, purpose).toBe(false);
      expect(res.error, purpose).toContain('not available in this turn');
    }
    await q(
      `UPDATE session_turns SET meta = jsonb_set(COALESCE(meta,'{}'), '{purpose}', '"board_chair"') WHERE id=$1`,
      [id],
    );
    expect((await begin(id)).ok).toBe(true);
    await q(`UPDATE session_turns SET meta = meta - 'purpose' WHERE id=$1`, [id]);
    expect((await begin(id)).ok).toBe(false);
    await finish(start);
  });

  it('refuses a turn that is over, a stranger, another workstation and bad input', async () => {
    const { id, start } = await facilitator();
    expect((await begin(randomUUID())).error).toBe('unknown caller');
    expect((await begin(id, { model: { runtime: 'claude-code', model: 'gpt-9' } })).error).toContain(
      'unknown model',
    );
    expect((await begin(id, { taskChars: DELEGATE_LIMITS.maxTaskChars + 1 })).ok).toBe(false);
    expect((await begin(id, { persona: '' })).ok).toBe(false);
    // the turn belongs to this workstation only
    await q(`UPDATE session_turns SET workstation_id=$2 WHERE id=$1`, [id, randomUUID()]);
    expect((await begin(id)).error).toBe('unknown caller');
    await q(`UPDATE session_turns SET workstation_id=$2 WHERE id=$1`, [id, w.workstationId]);
    await finish(start);
    const over = await begin(id);
    expect(over.ok).toBe(false);
    expect(over.error).toBe('this turn is over');
  });

  it('stops at the per-turn cap', async () => {
    const { id, start } = await facilitator();
    for (let i = 0; i < DELEGATE_LIMITS.maxPerCaller; i++) {
      const b = await begin(id);
      expect(b.ok).toBe(true);
      expect((await cost(id, b.delegateId, { inputTokens: 10, outputTokens: 10 })).ok).toBe(true);
    }
    const over = await begin(id);
    expect(over.ok).toBe(false);
    expect(over.error).toContain(`at most ${DELEGATE_LIMITS.maxPerCaller} delegates`);
    await finish(start);
  });
});

describe('delegates that are still running', () => {
  it('count against the per-turn cap before any cost arrives', async () => {
    const { id, start } = await facilitator();
    const all = await Promise.all(Array.from({ length: DELEGATE_LIMITS.maxPerCaller + 4 }, () => begin(id)));
    expect(all.filter((b) => b.ok).length).toBe(DELEGATE_LIMITS.maxPerCaller);
    expect(all.find((b) => !b.ok)?.error).toContain(`at most ${DELEGATE_LIMITS.maxPerCaller} delegates`);
    // a finished delegate frees nothing (the cap is per turn), a retried begin of a running one is not counted twice
    const first = all.find((b) => b.ok) as (typeof all)[number];
    expect((await begin(id, { delegateId: first.delegateId })).ok).toBe(true);
    expect((await cost(id, first.delegateId, { inputTokens: 1, outputTokens: 1 })).ok).toBe(true);
    expect((await begin(id)).ok).toBe(false);
    await finish(start);
  });

  it('run one at a time in a session with a budget, so none is started on spend the others have not booked yet', async () => {
    const { id, start } = await facilitator({ budgetUsd: 100 });
    const a = await begin(id);
    expect(a.ok).toBe(true);
    const b = await begin(id);
    expect(b.ok).toBe(false);
    expect(b.error).toContain('session_budget_pending');
    await cost(id, a.delegateId, { inputTokens: 10, outputTokens: 10 });
    expect((await begin(id)).ok).toBe(true);
    await finish(start);
  });
});

describe('delegate.cost books the usage under the caller', () => {
  it('writes DelegateCompleted and a cost row of kind delegate that the session meter counts', async () => {
    const { s, start, id } = await facilitator({ projectId: w.projectId });
    const b = await begin(id);
    const c = await cost(id, b.delegateId, {}, { durationMs: 1200 });
    expect(c.ok).toBe(true);
    expect(c.result).toEqual({ recorded: true });
    const ev = (
      await q(`SELECT payload FROM events WHERE type='DelegateCompleted' AND payload->>'delegateId'=$1`, [
        b.delegateId,
      ])
    )[0];
    expect(ev.payload).toMatchObject({
      callerKind: 'session_turn',
      callerId: id,
      threadId: s.threadId,
      personaKey: 'devils-advocate',
      outcome: 'ok',
    });
    // haiku: $1 in + $5 out per million
    expect(ev.payload.costMicros).toBe(1_500_000);
    const row = (await q('SELECT * FROM shift_costs WHERE shift_id=$1', [b.delegateId]))[0];
    expect(row).toMatchObject({
      kind: 'delegate',
      parent_id: id,
      project_id: w.projectId,
      model: 'claude-haiku-4-5',
      cost_stamped: true,
      cost_unknown: false,
    });
    expect(Number(row.cost_usd_micros)).toBe(1_500_000);
    // the caller's own row is untouched and the session meter adds the delegate to its turns
    await finish(start, 'done', { inputTokens: 100, outputTokens: 20 });
    const turnRow = (await q('SELECT * FROM shift_costs WHERE shift_id=$1', [id]))[0];
    expect(turnRow.kind).toBe('session');
    const st = (await owner('GET', `/api/sessions/${s.threadId}`)).session;
    expect(st.cost.costMicros).toBe(Number(turnRow.cost_usd_micros) + 1_500_000);
    expect(st.cost.turns).toBe(1);
    // a project budget counts it too
    const spend = (
      await q(
        `SELECT sum(cost_usd_micros)::bigint AS m FROM shift_costs WHERE project_id=$1 AND kind='delegate'`,
        [w.projectId],
      )
    )[0];
    expect(Number(spend.m)).toBeGreaterThanOrEqual(1_500_000);
  });

  it('is idempotent and is still accepted after the caller finished (the tokens were spent)', async () => {
    const { start, id } = await facilitator();
    const b = await begin(id);
    await finish(start);
    const c = await cost(id, b.delegateId);
    expect(c.result).toEqual({ recorded: true });
    expect((await cost(id, b.delegateId)).result).toEqual({ recorded: false });
    expect(
      (
        await q(
          `SELECT count(*)::int AS n FROM events WHERE type='DelegateCompleted' AND payload->>'delegateId'=$1`,
          [b.delegateId],
        )
      )[0].n,
    ).toBe(1);
  });

  it('flags a model without a price as unknown instead of free', async () => {
    const { s, start, id } = await facilitator();
    const b = await begin(id);
    await cost(id, b.delegateId, { model: 'openai:gpt-experimental', inputTokens: 5000, outputTokens: 500 });
    const row = (
      await q('SELECT cost_usd_micros, cost_unknown FROM shift_costs WHERE shift_id=$1', [b.delegateId])
    )[0];
    expect(Number(row.cost_usd_micros)).toBe(0);
    expect(row.cost_unknown).toBe(true);
    await finish(start);
    const st = (await owner('GET', `/api/sessions/${s.threadId}`)).session;
    expect(st.cost.unpricedTurns).toBeGreaterThanOrEqual(1);
  });

  it('rejects a malformed report and books nothing', async () => {
    const { id } = await facilitator();
    const bad = await call(id, 'delegate.cost', {
      delegateId: 'nope',
      persona: 'x',
      usage: {},
      outcome: 'ok',
    });
    expect(bad.ok).toBe(false);
    const missing = await call(id, 'delegate.cost', {
      delegateId: randomUUID(),
      persona: 'x',
      outcome: 'ok',
    });
    expect(missing.ok).toBe(false);
  });
});

describe('the session budget', () => {
  it('refuses a delegate once the session has used its budget, and works again when it is raised', async () => {
    const { s, start, id } = await facilitator({ budgetUsd: 1 });
    const first = await begin(id);
    expect(first.ok).toBe(true);
    // $1.50 of haiku: over the $1 budget
    await cost(id, first.delegateId);
    const refused = await begin(id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('session_budget_exceeded');
    expect(refused.error).toContain('$1.00');
    await owner('PATCH', `/api/discovery/${s.threadId}`, { budgetUsd: 1000 });
    expect((await begin(id)).ok).toBe(true);
    await finish(start);
  });

  it('refuses while the project of the session is paused', async () => {
    const { start, id } = await facilitator({ projectId: w.projectId });
    await q(`UPDATE projects SET paused_at = now() WHERE id=$1`, [w.projectId]);
    try {
      const res = await begin(id);
      expect(res.ok).toBe(false);
      expect(res.error).toContain('paused');
    } finally {
      await q(`UPDATE projects SET paused_at = NULL WHERE id=$1`, [w.projectId]);
    }
    await finish(start);
  });
});

describe('a shift as the caller', () => {
  let shiftId: string;
  let agentId: string;
  let cardId: string;
  it('lets a builder shift delegate and books the cost on its agent, card and project', async () => {
    const agent = await w.hire('Bea', 'builder', 'junior');
    agentId = agent.id;
    const card = await w.card({ title: 'Delegating card' });
    cardId = card.id;
    const from = r.received.length;
    await w.t.app.ctx.services.dispatcher.run();
    const start = await r.waitFor('shift.start', (f: any) => f.agent.name === 'Bea', 8000, from);
    shiftId = start.shiftId;
    r.accepted(shiftId);
    r.started(shiftId, {
      path: '/work/x',
      branchName: start.worktree?.branchName ?? 'x',
      baseBranch: 'main',
      created: true,
      headSha: 'abc',
    });
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [shiftId, 'running']))[0],
      3000,
    );
    const b = await begin(shiftId);
    expect(b.ok).toBe(true);
    expect((await cost(shiftId, b.delegateId)).ok).toBe(true);
    const row = (await q('SELECT * FROM shift_costs WHERE shift_id=$1', [b.delegateId]))[0];
    expect(row).toMatchObject({
      kind: 'delegate',
      parent_id: shiftId,
      agent_id: agentId,
      card_id: cardId,
      project_id: w.projectId,
    });
    expect(
      (
        await q(`SELECT payload FROM events WHERE type='DelegateCompleted' AND payload->>'delegateId'=$1`, [
          b.delegateId,
        ])
      )[0].payload.callerKind,
    ).toBe('shift');
    // the session meter is not involved, and the shift's own cost row is separate
    expect(row.shift_id).not.toBe(shiftId);
  });

  it('refuses the CEO, the DevOps engineer, a shift that ended and a project that is paused', async () => {
    await q(`UPDATE agents SET role_key='ceo' WHERE id=$1`, [agentId]);
    expect((await begin(shiftId)).error).toContain('not available to this agent');
    await q(`UPDATE agents SET role_key='devops' WHERE id=$1`, [agentId]);
    expect((await begin(shiftId)).error).toContain('not available to this agent');
    await q(`UPDATE agents SET role_key='builder' WHERE id=$1`, [agentId]);
    await q(`UPDATE projects SET paused_at = now() WHERE id=$1`, [w.projectId]);
    try {
      expect((await begin(shiftId)).error).toContain('paused');
    } finally {
      await q(`UPDATE projects SET paused_at = NULL WHERE id=$1`, [w.projectId]);
    }
    expect((await begin(shiftId)).ok).toBe(true);
    await q(`UPDATE shifts SET status='ended' WHERE id=$1`, [shiftId]);
    expect((await begin(shiftId)).error).toBe('this shift is over');
  });
});

describe('replay', () => {
  it('rebuilds the delegate cost rows exactly (parent, price, flags) and stays out of other kinds', async () => {
    const snap = async () =>
      JSON.parse(
        JSON.stringify(
          await q(
            `SELECT shift_id, kind, parent_id, agent_id, project_id, card_id, model, tokens_input, tokens_output,
                    cost_usd_micros, cost_unknown, cost_stamped
               FROM shift_costs WHERE kind IN ('delegate','session') ORDER BY kind, shift_id`,
          ),
        ),
      );
    const before = await snap();
    expect(before.filter((x: any) => x.kind === 'delegate').length).toBeGreaterThanOrEqual(5);
    expect(PROJECTION_TABLES).toContain('shift_costs');
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store, w.t.clock.now());
    expect(await snap()).toEqual(before);
  });
});
