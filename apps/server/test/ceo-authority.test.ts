import { randomUUID } from 'node:crypto';
import { DEFAULT_CEO_POLICY, deskMode, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ceoDecisionItemEvents } from '../src/ceo/decisions.ts';
import { agentActor, projectScope, SYSTEM_ACTOR } from '../src/commands/common.ts';
import { nextRoute } from '../src/commands/escalation.ts';
import {
  CEO_STOP_LOSS_ARBITRATIONS,
  cardUsage,
  ceoStopLossArbitrations,
  stopLossBudget,
  stopLossEvents,
} from '../src/commands/stop-loss.ts';
import {
  CEO_AUTHORITY_MIGRATION,
  CEO_DECISION_DEDUPE_MIGRATION,
  migrateCeoAuthority,
  migrateCeoDecisionDedupe,
} from '../src/data-migrations/index.ts';
import { withAppendTx } from '../src/db/tx.ts';
import {
  BLOCKED_QUESTION_ESCALATE_MS,
  BLOCKED_QUESTION_MAX_MISSES,
  blockedQuestionPass,
} from '../src/dispatcher/questions.ts';
import { withCardModel } from '../src/runner-gateway/brief.ts';
import { act, appoint, graduate, startCeoShift, wakeNow } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { seed } from './helpers/seed.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let shiftId: string;
let ceoAgentId: string;

beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner({ capabilities: ['ceo:1'] });
  await w.hire('Bea', 'builder', 'junior', { model: 'sonnet' });
  await w.hire('Dennis', 'tester', 'senior', { model: 'sonnet' });
  await w.hire('Grace', 'ba', 'senior', { model: 'sonnet' });
  ceoAgentId = await appoint(w);
  await graduate(w);
  await wakeNow(w);
  shiftId = (await startCeoShift(w, r)).shiftId;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const ctx = () => w.t.app.ctx;
const owner = (method: string, url: string) => w.t.req(method, url, { cookie: w.owner.cookie });
const result = (resp: any) => {
  expect(resp.ok, JSON.stringify(resp)).toBe(true);
  return resp.result;
};
const agentId = async (name: string) =>
  (await q(`SELECT id FROM agents WHERE name=$1`, [name]))[0]!.id as string;
const setCeoEnabled = (enabled: boolean) =>
  q(`UPDATE ceo_settings SET enabled=$1 WHERE org_id=$2`, [enabled, w.owner.id]);
const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;

describe('the default CEO policy', () => {
  it('lets the CEO move cards, raise a card model and release loops on its own', () => {
    expect(DEFAULT_CEO_POLICY.classes['card.move']?.mode).toBe('decide');
    expect(DEFAULT_CEO_POLICY.classes['card.raise_model']?.mode).toBe('decide');
    for (const sub of ['loop_parked', 'repeat_question', 'repeat_loop', 'stop_loss', 'loop_backoff'])
      expect(deskMode(DEFAULT_CEO_POLICY, 'escalation', sub), sub).toBe('decide');
    expect(deskMode(DEFAULT_CEO_POLICY, 'question', 'stop_loss')).toBe('decide');
    expect(deskMode(DEFAULT_CEO_POLICY, 'question', 'repeat_loop')).toBe('decide');
    // other escalations stay with the owner
    expect(deskMode(DEFAULT_CEO_POLICY, 'escalation', 'something_else')).toBe('recommend');
  });
});

describe('card.move', () => {
  it('moves a card to another stage of its workflow, on its own, through moveCard', async () => {
    const card = await w.card({ title: 'Wrong stage' });
    const from = card.stage as string;
    const to = from === 'review' ? 'build' : 'review';
    const res = result(await act(r, shiftId, 'move', { card: card.ref, to }, { key: 'move-1' }));
    expect(res.status).toBe('executed');
    expect((await cardRow(card.id)).stage).toBe(to);
    expect(
      await q(`SELECT 1 FROM events WHERE type='CardMovedByManager' AND payload->>'cardId'=$1`, [card.id]),
    ).toHaveLength(1);
  });

  it('refuses an invalid stage and lists the valid target stages', async () => {
    const card = await w.card({ title: 'Nowhere to go' });
    for (const to of ['no_such_stage', 'done']) {
      const res = result(await act(r, shiftId, 'move', { card: card.ref, to }, { key: `bad-${to}` }));
      expect(res.status).toBe('refused');
      expect(res.message).toMatch(/Valid target stages/);
      expect(res.message).toContain('build');
    }
    expect((await cardRow(card.id)).stage).toBe(card.stage);
  });
});

describe('card.reassign checks the stage', () => {
  it('refuses an agent whose role cannot work the stage and suggests card.move first', async () => {
    const card = await w.card({ title: 'Builder stage' });
    expect(card.stage).toBe('build');
    const res = result(
      await act(r, shiftId, 'reassign', { card: card.ref, agent: 'Dennis' }, { key: 're-1' }),
    );
    expect(res.status).toBe('refused');
    expect(res.message).toMatch(/cannot work the stage 'build'/);
    expect(res.message).toMatch(/card\.move/);
    expect(
      await q(`SELECT 1 FROM events WHERE type='CardReassigned' AND payload->>'cardId'=$1`, [card.id]),
    ).toHaveLength(0);
    // an agent of the stage's role is fine
    const fine = result(await act(r, shiftId, 'reassign', { card: card.ref, agent: 'Bea' }, { key: 're-2' }));
    expect(fine.status).toBe('executed');
  });
});

describe('card.raise_model', () => {
  it('sets a per-card override, used when a shift starts', async () => {
    const card = await w.card({ title: 'Needs a stronger model' });
    const bad = result(
      await act(r, shiftId, 'raise-model', { card: card.ref, model: 'gpt-9' }, { key: 'rm-0' }),
    );
    expect(bad.status).toBe('refused');
    const res = result(
      await act(
        r,
        shiftId,
        'raise-model',
        { card: card.ref, model: 'opus', effort: 'high', note: 'two rounds of real review findings' },
        { key: 'rm-1' },
      ),
    );
    expect(res.status).toBe('executed');
    expect((await cardRow(card.id)).model_override).toEqual({
      model: 'opus',
      effort: 'high',
      runtime: 'claude-code',
    });
    const spec: any = { runtime: 'claude-code', model: 'sonnet', effort: 'low' };
    expect(withCardModel(spec, { model: 'opus', effort: 'high', runtime: 'claude-code' })).toMatchObject({
      model: 'opus',
      effort: 'high',
    });
    // meant for another runtime, or no override: the agent's own choice stands
    expect(
      withCardModel({ ...spec, runtime: 'mock' }, { model: 'opus', runtime: 'claude-code' }),
    ).toMatchObject({
      model: 'sonnet',
    });
    expect(withCardModel(spec, null)).toBe(spec);
  });
});

/** Parks a card for its stop-loss through the real function and returns the new item. */
async function raiseStopLoss(cardId: string) {
  const row = await cardRow(cardId);
  await withAppendTx(ctx().pool, async (tx) => {
    const usage = await cardUsage(tx, cardId);
    const budget = await stopLossBudget(tx, row);
    await ctx().store.append(await stopLossEvents(ctx(), tx, row, 'shifts', usage, budget), { tx });
  });
  return (
    await q(
      `SELECT * FROM desk_items WHERE card_id=$1 AND subkind='stop_loss' ORDER BY created_at DESC LIMIT 1`,
      [cardId],
    )
  )[0]!;
}

const deskIds = async () =>
  (await ok<any>(owner('GET', '/api/desk?status=open'))).items.map((i: any) => i.id as string);

describe('stop-loss goes to the CEO', () => {
  it('holds the item for the CEO (not the architect or the owner) and the CEO resolves it with its decision on the item', async () => {
    const card = await w.card({ title: 'Keeps bouncing' });
    const item = await raiseStopLoss(card.id);
    expect(item).toMatchObject({ routed_to: 'manager', triage: 'pending', blocking: true });
    expect(await deskIds()).not.toContain(item.id);
    const thread = await q(
      `SELECT body FROM thread_messages WHERE body LIKE '%stop-loss%' ORDER BY created_at DESC`,
    );
    expect(thread.some((m) => /Asked: the CEO/.test(m.body))).toBe(true);

    // the CEO decides without cited evidence
    const res = result(await act(r, shiftId, 'answer', { item: item.id, option: 'o1' }, { key: 'sl-1' }));
    expect(res.status).toBe('executed');
    const after = (await q(`SELECT * FROM desk_items WHERE id=$1`, [item.id]))[0]!;
    expect(after.status).toBe('answered');
    expect(after.data.ceoDecision).toMatchObject({ class: 'desk.answer_question', source: 'act' });
    // either the item or the decision: no second card, and the decision waits for review on the item itself
    expect(
      await q(`SELECT 1 FROM desk_items WHERE subkind='ceo_decision' AND card_id=$1`, [card.id]),
    ).toHaveLength(0);
    const list = (await ok<any>(owner('GET', '/api/desk?status=open'))).items.find(
      (i: any) => i.id === item.id,
    );
    expect(list).toMatchObject({ status: 'answered' });
    expect(list.ceoDecision).toMatchObject({ reviewed: false });
    expect(await ceoStopLossArbitrations(ctx().pool, card.id)).toBe(1);
  });

  it('goes to the owner on the 4th arbitration of the same card', async () => {
    const card = await w.card({ title: 'Cap me' });
    for (let i = 0; i < CEO_STOP_LOSS_ARBITRATIONS; i++) {
      const item = await raiseStopLoss(card.id);
      expect(item.triage, `arbitration ${i + 1} is the CEO's`).toBe('pending');
      result(await act(r, shiftId, 'answer', { item: item.id, option: 'o1' }, { key: `cap-${i}` }));
    }
    expect(await ceoStopLossArbitrations(ctx().pool, card.id)).toBe(CEO_STOP_LOSS_ARBITRATIONS);
    const fourth = await raiseStopLoss(card.id);
    expect(fourth).toMatchObject({ routed_to: 'manager', triage: 'none', status: 'open' });
    expect(await deskIds()).toContain(fourth.id);
  });

  it('counts the CEO moving the card (which dismisses the stop-loss) as an arbitration: the 4th goes to the owner', async () => {
    const card = await w.card({ title: 'Moved again and again' });
    let to = 'review';
    for (let i = 0; i < CEO_STOP_LOSS_ARBITRATIONS; i++) {
      const item = await raiseStopLoss(card.id);
      expect(item.triage, `stop-loss ${i + 1} is the CEO's`).toBe('pending');
      const res = result(await act(r, shiftId, 'move', { card: card.ref, to }, { key: `capmove-${i}` }));
      expect(res.status).toBe('executed');
      const after = (await q(`SELECT status FROM desk_items WHERE id=$1`, [item.id]))[0]!;
      expect(after.status).toBe('dismissed');
      to = to === 'review' ? 'build' : 'review';
    }
    // the move is attributed to the CEO agent, not to the owner
    const moved = await q(
      `SELECT actor_kind, actor_id FROM events WHERE type='CardMovedByManager' AND payload->>'cardId'=$1`,
      [card.id],
    );
    expect(moved).toHaveLength(CEO_STOP_LOSS_ARBITRATIONS);
    for (const m of moved) expect(m).toMatchObject({ actor_kind: 'agent', actor_id: ceoAgentId });
    expect(await ceoStopLossArbitrations(ctx().pool, card.id)).toBe(CEO_STOP_LOSS_ARBITRATIONS);
    const fourth = await raiseStopLoss(card.id);
    expect(fourth).toMatchObject({ routed_to: 'manager', triage: 'none', status: 'open' });
    expect(await deskIds()).toContain(fourth.id);
  });

  it('goes straight to the owner when the CEO cannot run a shift now, never the architect', async () => {
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    try {
      const card = await w.card({ title: 'CEO offline' });
      const item = await raiseStopLoss(card.id);
      expect(item).toMatchObject({ routed_to: 'manager', triage: 'none', status: 'open' });
      expect(item.routed_agent_id ?? null).toBeNull();
      expect(await deskIds()).toContain(item.id);
    } finally {
      await q(`UPDATE workstations SET connected=true, last_seen_at=$2 WHERE id=$1`, [
        w.workstationId,
        w.t.clock.now(),
      ]);
    }
  });

  it('goes straight to the owner when the card project is paused (nobody would look at a held item)', async () => {
    const card = await w.card({ title: 'Paused project' });
    await q(`UPDATE projects SET paused_at=now() WHERE id=$1`, [w.projectId]);
    try {
      const item = await raiseStopLoss(card.id);
      expect(item).toMatchObject({ routed_to: 'manager', triage: 'none', status: 'open' });
    } finally {
      await q(`UPDATE projects SET paused_at=NULL WHERE id=$1`, [w.projectId]);
    }
  });

  it('counts a dismissal as a resolution, so the same usage does not raise it again', async () => {
    const card = await w.card({ title: 'Dismissed' });
    const before = await stopLossBudget(ctx().pool, await cardRow(card.id));
    await q(
      `INSERT INTO desk_items (id, org_id, project_id, card_id, kind, subkind, status, title, created_at, updated_at)
       SELECT $1, org_id, project_id, id, 'question', 'stop_loss', 'dismissed', 'dismissed', now(), now() FROM cards WHERE id=$2`,
      [randomUUID(), card.id],
    );
    const afterBudget = await stopLossBudget(ctx().pool, await cardRow(card.id));
    expect(afterBudget.shifts).toBeGreaterThan(before.shifts);
    expect(afterBudget.buildPasses).toBeGreaterThan(before.buildPasses);
  });

  it('keeps the old routing (the architect, then the desk) when no CEO is active', async () => {
    await setCeoEnabled(false);
    try {
      const card = await w.card({ title: 'No CEO here' });
      const item = await raiseStopLoss(card.id);
      // no architect hired: straight to the desk, visible
      expect(item).toMatchObject({ routed_to: 'manager', triage: 'none' });
      expect(await deskIds()).toContain(item.id);
    } finally {
      await setCeoEnabled(true);
    }
  });
});

describe('questions go to the CEO, not the BA', () => {
  const input = (over: Record<string, unknown> = {}) => ({
    orgId: w.owner.id,
    projectId: w.projectId,
    cardId: null,
    askerAgentId: null,
    askerRole: 'builder',
    from: 'raise' as const,
    tried: [] as string[],
    ...over,
  });

  it('routes straight to the CEO and skips the BA when a CEO is active', async () => {
    const route = await nextRoute(ctx(), ctx().pool, input());
    expect(route).toMatchObject({ routedTo: 'agent', level: 'ceo', routedAgentId: ceoAgentId });
    const req = await nextRoute(ctx(), ctx().pool, input({ topic: 'requirements' }));
    expect(req).toMatchObject({ level: 'ceo' });
    const viaBa = await nextRoute(ctx(), ctx().pool, input({ via: 'ba' }));
    expect(viaBa).toMatchObject({ level: 'ceo' });
    // a question that went on from a peer reaches the CEO, not the BA
    const fromPeer = await nextRoute(ctx(), ctx().pool, input({ from: 'peer' }));
    expect(fromPeer).toMatchObject({ level: 'ceo' });
  });

  it('goes to the owner at once when the CEO cannot run a shift now, never the BA and not after a wait', async () => {
    await q(`UPDATE workstations SET connected=false WHERE id=$1`, [w.workstationId]);
    try {
      const desk = { routedTo: 'manager', level: 'desk' };
      expect(await nextRoute(ctx(), ctx().pool, input())).toMatchObject(desk);
      expect(await nextRoute(ctx(), ctx().pool, input({ topic: 'requirements' }))).toMatchObject(desk);
      expect(await nextRoute(ctx(), ctx().pool, input({ via: 'ba' }))).toMatchObject(desk);
      expect(await nextRoute(ctx(), ctx().pool, input({ from: 'ceo', tried: [ceoAgentId] }))).toMatchObject(
        desk,
      );
    } finally {
      await q(`UPDATE workstations SET connected=true, last_seen_at=$2 WHERE id=$1`, [
        w.workstationId,
        w.t.clock.now(),
      ]);
    }
    // reachable again: the CEO
    expect(await nextRoute(ctx(), ctx().pool, input())).toMatchObject({ level: 'ceo' });
  });

  it('uses the BA only when there is no active CEO', async () => {
    await setCeoEnabled(false);
    try {
      const route = await nextRoute(ctx(), ctx().pool, input());
      expect(route).toMatchObject({ level: 'ba' });
    } finally {
      await setCeoEnabled(true);
    }
  });
});

describe('blocking items routed to an agent are escalated', () => {
  async function agentQuestion(opts: { to: string; project?: string } = { to: 'Bea' }) {
    const card = await w.card({ title: `Blocked ${randomUUID().slice(0, 4)}` });
    const id = randomUUID();
    await seed(w, [
      {
        streamId: streamId.desk(id),
        event: {
          type: 'QuestionRaised',
          payload: {
            deskItemId: id,
            cardId: card.id,
            projectId: w.projectId,
            askedBy: { kind: 'system' },
            question: `Which option for ${id}?`,
            options: [{ id: 'o1', label: 'A' }],
            blocking: true,
            routedTo: 'agent',
            routedAgentId: await agentId(opts.to),
            chainLevel: 'peer',
            pinned: false,
            affectedCardIds: [card.id],
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(w.owner.id, w.projectId),
      },
    ]);
    return { id, card };
  }
  const itemRow = async (id: string) => (await q(`SELECT * FROM desk_items WHERE id=$1`, [id]))[0]!;

  it('leaves a fresh question alone, and sends one that waited 20 minutes to the CEO', async () => {
    const { id } = await agentQuestion();
    expect(await blockedQuestionPass(ctx())).toBe(0);
    w.t.clock.advance(BLOCKED_QUESTION_ESCALATE_MS + 60_000);
    await q(`UPDATE workstations SET last_seen_at=$2 WHERE id=$1`, [w.workstationId, w.t.clock.now()]);
    await blockedQuestionPass(ctx());
    const row = await itemRow(id);
    expect(row).toMatchObject({ routed_to: 'agent', routed_agent_id: ceoAgentId });
    expect(
      (
        await q(
          `SELECT payload->>'note' AS note FROM events WHERE type='QuestionEscalated' AND stream_id=$1`,
          [streamId.desk(id)],
        )
      ).some((e) => /no answer within 20 minutes/.test(e.note)),
    ).toBe(true);
    // the CEO is its next stop only once: a second pass leaves it with the CEO until that one also waited
    expect(await blockedQuestionPass(ctx())).toBe(0);
  });

  it('sends a question whose shifts were rejected or unanswered 3 times on, and an owner-bound one to the desk when no CEO', async () => {
    await setCeoEnabled(false);
    try {
      const { id } = await agentQuestion();
      const bea = await agentId('Bea');
      for (let i = 0; i < BLOCKED_QUESTION_MAX_MISSES; i++)
        await q(
          `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, status, outcome, runtime, model, started_at, ended_at, desk_item_id)
           SELECT $1, org_id, $2, workstation_id, NULL, 'question', 'ended', 'rejected', runtime, model, now(), now(), $3 FROM agents WHERE id=$2`,
          [randomUUID(), bea, id],
        );
      await blockedQuestionPass(ctx());
      // Grace (the BA) is the next step of the old chain without a CEO
      expect((await itemRow(id)).routed_agent_id).toBe(await agentId('Grace'));
    } finally {
      await setCeoEnabled(true);
    }
  });

  it('escalates at once when the project is paused, to the owner (nothing of a paused project is dispatched)', async () => {
    const { id } = await agentQuestion();
    await q(`UPDATE projects SET paused_at=now() WHERE id=$1`, [w.projectId]);
    try {
      expect(await blockedQuestionPass(ctx())).toBeGreaterThanOrEqual(1);
      expect(await itemRow(id)).toMatchObject({ routed_to: 'manager' });
      const note = (
        await q(
          `SELECT payload->>'note' AS note FROM events WHERE type='QuestionEscalated' AND stream_id=$1`,
          [streamId.desk(id)],
        )
      )[0]!.note;
      expect(note).toMatch(/project is paused/);
    } finally {
      await q(`UPDATE projects SET paused_at=NULL WHERE id=$1`, [w.projectId]);
    }
  });
});

describe('either the question or the decision on the desk', () => {
  const base = {
    orgId: '',
    ceoAgentId: '',
    ceoName: 'Ada Prime',
    cls: 'desk.answer_question',
    source: 'chain' as const,
    question: 'Which one?',
    decision: 'A',
    reason: 'because',
  };

  it('records a decision about a question on that question; only a decision with no item of its own is a ceo_decision card', () => {
    const onQuestion = ceoDecisionItemEvents({ ...base, questionItemId: randomUUID() });
    expect(onQuestion.map((e) => e.event.type)).toEqual(['CeoDecisionRecorded']);
    const own = ceoDecisionItemEvents({ ...base, cls: 'card.cancel' });
    expect(own.map((e) => e.event.type)).toEqual(['DeskItemCreated']);
  });

  it('merges a legacy duplicate ceo_decision card that is open next to an already resolved question (migration)', async () => {
    const card = await w.card({ title: 'Legacy duplicate' });
    const qid = randomUUID();
    const dupId = randomUUID();
    const scope = projectScope(w.owner.id, w.projectId);
    const ceoActor = agentActor(ceoAgentId);
    await seed(w, [
      {
        streamId: streamId.desk(qid),
        event: {
          type: 'QuestionRaised',
          payload: {
            deskItemId: qid,
            cardId: card.id,
            projectId: w.projectId,
            askedBy: { kind: 'system' },
            question: 'Legacy question?',
            options: [{ id: 'o1', label: 'A' }],
            blocking: true,
            routedTo: 'manager',
            pinned: false,
            affectedCardIds: [card.id],
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
      {
        streamId: streamId.desk(qid),
        event: {
          type: 'QuestionAnswered',
          payload: {
            deskItemId: qid,
            answer: 'A',
            answeredBy: { kind: 'agent', agentId: ceoAgentId, role: 'ceo' },
            unblockedCardIds: [],
          },
        },
        actor: ceoActor,
        scope,
      },
      {
        streamId: streamId.desk(dupId),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: dupId,
            kind: 'alert',
            subkind: 'ceo_decision',
            title: 'CEO decision: Legacy question?',
            body: 'A',
            options: [],
            blocking: false,
            pinned: false,
            affectedCardIds: [],
            askedBy: { kind: 'agent', agentId: ceoAgentId, role: 'ceo' },
            cardId: card.id,
            projectId: w.projectId,
            data: {
              ceoDecision: {
                question: 'Legacy question?',
                decision: 'A',
                reason: 'because',
                confidence: 0.9,
                ceoName: 'Ada Prime',
                ceoAgentId,
                class: 'desk.answer_question',
                source: 'chain',
                actionId: null,
                questionItemId: qid,
              },
            },
          },
        },
        actor: ceoActor,
        scope,
      },
    ]);
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [dupId]))[0]!.status).toBe('open');
    await q(`DELETE FROM data_migrations WHERE name=$1`, [CEO_DECISION_DEDUPE_MIGRATION]);
    const env = {
      pool: ctx().pool,
      store: ctx().store,
      clock: ctx().clock,
      log: () => undefined,
    } as never;
    const report = await migrateCeoDecisionDedupe(env);
    expect(report).toMatchObject({ merged: 1 });
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [dupId]))[0]!.status).toBe('dismissed');
    const question = (await q(`SELECT data FROM desk_items WHERE id=$1`, [qid]))[0]!;
    expect(question.data.ceoDecision).toMatchObject({ decision: 'A', ceoName: 'Ada Prime' });
    // once only
    expect(await migrateCeoDecisionDedupe(env)).toBeNull();
    // and the owner can still acknowledge the decision, now on the question
    const ack = await w.t.req('POST', `/api/desk/${qid}/ceo-decision/acknowledge`, {
      cookie: w.owner.cookie,
    });
    expect(ack.status).toBe(200);
    expect((await q(`SELECT data FROM desk_items WHERE id=$1`, [qid]))[0]!.data.acknowledgedAt).toBeTruthy();
  });
});

describe('the CEO releases a repeat_loop escalation', () => {
  it('resolves it without cited evidence', async () => {
    expect(deskMode(DEFAULT_CEO_POLICY, 'escalation', 'repeat_loop')).toBe('decide');
    const card = await w.card({ title: 'Asks the same thing' });
    const id = randomUUID();
    await seed(w, [
      {
        streamId: streamId.desk(id),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: id,
            kind: 'escalation',
            subkind: 'repeat_loop',
            title: `${card.ref} keeps asking the same question (3 times)`,
            body: 'Say what is missing, then resolve this item.',
            options: [],
            blocking: true,
            pinned: true,
            cardId: card.id,
            projectId: w.projectId,
            affectedCardIds: [card.id],
            askedBy: { kind: 'system' },
            subjectKey: `repeat_loop:${card.id}`,
          },
        },
        actor: SYSTEM_ACTOR,
        scope: projectScope(w.owner.id, w.projectId),
      },
    ]);
    const res = result(
      await act(r, shiftId, 'answer', { item: id, text: 'Use the staging database.' }, { key: 'rl-1' }),
    );
    expect(res.status).toBe('executed');
    expect((await q(`SELECT status FROM desk_items WHERE id=$1`, [id]))[0]!.status).toBe('answered');
  });
});

describe('CEO actions stay inside the CEO organization', () => {
  it('refuses to move or raise a card of another organization', async () => {
    const other = await w.t.createOrg(w.owner.id, 'Elsewhere');
    const card = await w.card({ title: 'Foreign card' });
    await q(`UPDATE cards SET org_id=$2 WHERE id=$1`, [card.id, other]);
    const mv = result(await act(r, shiftId, 'move', { card: card.ref, to: 'review' }, { key: 'org-mv' }));
    expect(mv.status).toBe('refused');
    const rm = result(
      await act(r, shiftId, 'raise-model', { card: card.ref, model: 'opus' }, { key: 'org-rm' }),
    );
    expect(rm.status).toBe('refused');
    expect((await cardRow(card.id)).stage).toBe(card.stage);
    expect((await cardRow(card.id)).model_override).toBeNull();
  });
});

describe('CardMovedByManager replay', () => {
  it('an event without clearsBlockers keeps the older rule: an open question stays, blocked_since is not cleared', async () => {
    const card = await w.card({ title: 'Old-shape move' });
    const id = randomUUID();
    const scope = projectScope(w.owner.id, w.projectId);
    await seed(w, [
      {
        streamId: streamId.desk(id),
        event: {
          type: 'QuestionRaised',
          payload: {
            deskItemId: id,
            cardId: card.id,
            projectId: w.projectId,
            askedBy: { kind: 'system' },
            question: 'Old open question?',
            options: [{ id: 'o1', label: 'A' }],
            blocking: true,
            routedTo: 'manager',
            pinned: false,
            affectedCardIds: [card.id],
          },
        },
        actor: SYSTEM_ACTOR,
        scope,
      },
    ]);
    const before = await cardRow(card.id);
    expect(before.blocked_since).not.toBeNull();
    const move = (payload: Record<string, unknown>) =>
      seed(w, [
        {
          streamId: streamId.card(card.id),
          event: {
            type: 'CardMovedByManager',
            payload: {
              cardId: card.id,
              fromStage: card.stage,
              toStage: 'review',
              status: 'queued',
              reason: 'old',
              ...payload,
            },
          },
          actor: SYSTEM_ACTOR,
          scope,
        },
      ]);
    await move({});
    const blockers = () =>
      q(`SELECT 1 FROM card_blockers WHERE card_id=$1 AND desk_item_id=$2`, [card.id, id]);
    expect(await blockers()).toHaveLength(1);
    expect((await cardRow(card.id)).blocked_since).not.toBeNull();
    // the new shape clears everything
    await move({ clearsBlockers: true, fromStage: 'review', toStage: 'build' });
    expect(await blockers()).toHaveLength(0);
    expect((await cardRow(card.id)).blocked_since).toBeNull();
  });
});

describe('the policy migration', () => {
  it('adds the loop keys to a stored policy once, and leaves a key the owner set alone', async () => {
    const cur = (
      await q(`SELECT policy, policy_version FROM ceo_settings WHERE org_id=$1`, [w.owner.id])
    )[0]!;
    const stored = { ...cur.policy, desk: { ...cur.policy.desk, 'escalation:stop_loss': 'never' } };
    for (const k of [
      'escalation:loop_parked',
      'escalation:repeat_question',
      'escalation:loop_backoff',
      'question:stop_loss',
      'question:repeat_question',
      'alert:loop_backoff',
      'alert:loop_parked',
    ])
      delete stored.desk[k];
    await q(`UPDATE ceo_settings SET policy=$2 WHERE org_id=$1`, [w.owner.id, JSON.stringify(stored)]);
    await q(`DELETE FROM data_migrations WHERE name=$1`, [CEO_AUTHORITY_MIGRATION]);
    const env = { pool: ctx().pool, store: ctx().store, clock: ctx().clock, log: () => undefined } as never;
    const report = await migrateCeoAuthority(env);
    expect(report?.changed).toContain(w.owner.id);
    const pol = (await ok<any>(owner('GET', '/api/ceo/policy'))).policy;
    expect(pol.desk['escalation:loop_parked']).toBe('decide');
    expect(pol.desk['question:stop_loss']).toBe('decide');
    expect(pol.desk['escalation:stop_loss']).toBe('never');
    expect(await migrateCeoAuthority(env)).toBeNull();
  });

  it('does not add the loop keys of a family whose wildcard the owner set explicitly', async () => {
    const cur = (await q(`SELECT policy FROM ceo_settings WHERE org_id=$1`, [w.owner.id]))[0]!;
    const stored = { ...cur.policy, desk: { ...cur.policy.desk, 'escalation:*': 'never' } };
    for (const k of Object.keys(stored.desk))
      if (/^(escalation|question|alert):(loop_|repeat_|stop_loss)/.test(k)) delete stored.desk[k];
    await q(`UPDATE ceo_settings SET policy=$2 WHERE org_id=$1`, [w.owner.id, JSON.stringify(stored)]);
    await q(`DELETE FROM data_migrations WHERE name=$1`, [CEO_AUTHORITY_MIGRATION]);
    const logs: string[] = [];
    const env = {
      pool: ctx().pool,
      store: ctx().store,
      clock: ctx().clock,
      log: (m: string) => logs.push(m),
    } as never;
    await migrateCeoAuthority(env);
    const pol = (await ok<any>(owner('GET', '/api/ceo/policy'))).policy;
    expect(pol.desk['escalation:repeat_loop']).toBeUndefined();
    expect(pol.desk['escalation:stop_loss']).toBeUndefined();
    expect(pol.desk['question:repeat_loop']).toBe('decide');
    expect(pol.desk['alert:loop_parked']).toBe('decide');
    expect(logs.some((l) => l.includes(w.owner.id) && l.includes('escalation'))).toBe(true);
    expect(await migrateCeoAuthority(env)).toBeNull();
    // restore the default for later tests
    await q(`UPDATE ceo_settings SET policy=$2 WHERE org_id=$1`, [w.owner.id, JSON.stringify(cur.policy)]);
  });
});
