import { randomUUID } from 'node:crypto';
import { renderInstructions, renderShiftPrompt, streamId } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { seed } from './helpers/seed.ts';
import { freshState, shiftHelpers } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let h: ReturnType<typeof shiftHelpers>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  h = shiftHelpers(w);
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const desk = (cookie = w.owner.cookie, qs = '') => ok<any>(w.t.req('GET', `/api/desk${qs}`, { cookie }));
const answer = (id: string, body: Record<string, unknown>, cookie = w.owner.cookie, status = 200) =>
  ok<any>(w.t.req('POST', `/api/desk/${id}/answer`, { cookie, body }), status);
const eventsOf = async (stream: string) =>
  (await q('SELECT seq, type, payload FROM events WHERE stream_id=$1 ORDER BY seq', [stream])) as Array<{
    seq: string;
    type: string;
    payload: any;
  }>;
const ask = (r: any, shiftId: string, over: Record<string, unknown> = {}) =>
  h.report(r, shiftId, {
    kind: 'question',
    text: 'Should source files use tabs or spaces?',
    options: ['tabs', 'spaces'],
    recommend: 0,
    doing: 'writing the formatter',
    blocking: true,
    ...over,
  });

describe('raising a question', () => {
  it('parks the card in Blocked, frees the builder, and shows everything on the desk', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Bea', 'builder', 'junior');
    const a = await w.card({ title: 'Needs a decision' });
    const b = await w.card({ title: 'Next card' });
    const start = await h.dispatchTo(r, 'Bea');
    expect(start.brief.card.ref).toBe(a.ref);
    await h.startShift(r, start);

    const res = await ask(r, start.shiftId);
    expect(res).toMatchObject({ accepted: true });
    expect(res.message).toMatch(/Blocked/);
    r.ended(start.shiftId, 'reported');

    const card = await cardRow(a.id);
    expect(card).toMatchObject({ status: 'blocked', claim_id: null, claimed_by_agent_id: null });
    expect(card.blocked_since).not.toBeNull();
    expect(await q('SELECT 1 FROM card_blockers WHERE card_id=$1', [a.id])).toHaveLength(1);
    const types = (
      await q(
        `SELECT type, payload FROM events WHERE type IN ('QuestionRaised','ClaimReleased') AND payload->>'cardId'=$1 ORDER BY seq`,
        [a.id],
      )
    ).map((e) => `${e.type}:${e.payload.reason ?? ''}`);
    expect(types).toEqual(['QuestionRaised:', 'ClaimReleased:question']);
    await until(
      async () =>
        (await q('SELECT report_outcome FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0]
          ?.report_outcome === 'question',
      3000,
      'shift ended with the question outcome',
    );

    // The builder takes its next card instead of waiting.
    const next = await h.dispatchTo(r, 'Bea', r.received.length - 1);
    expect(next.brief.card.ref).toBe(b.ref);

    const { items, counts } = await desk();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'question',
      status: 'open',
      title: 'Should source files use tabs or spaces?',
      doing: 'writing the formatter',
      options: [
        { id: 'o1', label: 'tabs' },
        { id: 'o2', label: 'spaces' },
      ],
      recommendation: 'o1',
      blocking: true,
      pinned: true,
      urgent: true,
      affectedCount: 1,
      routedTo: 'manager',
      askedBy: { kind: 'agent', agentName: 'Bea', role: 'builder' },
      card: { ref: a.ref, projectKey: 'TOY', status: 'blocked' },
      canAnswer: true,
    });
    expect(counts).toEqual({ open: 1, blocking: 1, urgent: 1 });
    const board = await ok<any>(
      w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: w.owner.cookie }),
    );
    expect(board.columns.find((c: any) => c.name === 'Blocked').cards.map((c: any) => c.ref)).toEqual([
      a.ref,
    ]);
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${a.id}`, { cookie: w.owner.cookie }));
    expect(detail.blockers).toEqual([
      { deskItemId: items[0].id, title: 'Should source files use tabs or spaces?' },
    ]);
    expect(detail.thread.some((m: any) => m.kind === 'question' && m.authorName === 'Bea')).toBe(true);
    r.close();
  });

  it('counts the cards that depend on the blocked card', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Cam', 'builder', 'junior');
    const base = await w.card({ title: 'Base' });
    await w.card({ title: 'Dependent', dependencies: [base.id] });
    const start = await h.dispatchTo(r, 'Cam');
    await h.startShift(r, start);
    await ask(r, start.shiftId);
    expect((await desk()).items[0].affectedCount).toBe(2);
    r.close();
  });

  it('does not block on a non-blocking question and keeps the claim', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Dan', 'builder', 'junior');
    const card = await w.card({ title: 'Carry on' });
    const start = await h.dispatchTo(r, 'Dan');
    await h.startShift(r, start);
    const res = await ask(r, start.shiftId, { blocking: false });
    expect(res.accepted).toBe(true);
    expect(await cardRow(card.id)).toMatchObject({
      status: 'claimed',
      claimed_by_agent_id: expect.any(String),
    });
    const item = (await desk()).items[0];
    expect(item).toMatchObject({ blocking: false, pinned: false, urgent: false, affectedCount: 1 });
    expect(await q('SELECT 1 FROM card_blockers')).toHaveLength(0);
    // The shift can still hand off.
    expect(
      (await h.report(r, start.shiftId, { kind: 'outcome', outcomeId: 'handoff', note: 'done', data: {} }))
        .accepted,
    ).toBe(true);
    r.close();
  });

  it('checks the ledger first: matches are returned, stored on the desk item, and non-blocking needs --force', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Eli', 'builder', 'junior');
    await ok(
      w.t.req('POST', '/api/ledger', {
        cookie: w.owner.cookie,
        body: {
          scope: 'decision',
          projectId: w.projectId,
          title: 'Indentation',
          body: 'Source files use tabs for indentation, never spaces.',
        },
      }),
      201,
    );
    await w.card({ title: 'Dedup' });
    const start = await h.dispatchTo(r, 'Eli');
    await h.startShift(r, start);

    const soft = await ask(r, start.shiftId, { blocking: false });
    expect(soft.accepted).toBe(false);
    expect(soft.error).toContain('--force');
    expect(soft.matches?.map((m: any) => m.title)).toEqual(['Indentation']);
    expect(await q('SELECT 1 FROM desk_items')).toHaveLength(0);

    const forced = await ask(r, start.shiftId, { blocking: false, force: true });
    expect(forced.accepted).toBe(true);
    const item = (await desk()).items[0];
    expect(item.dedupEntries.map((e: any) => e.title)).toEqual(['Indentation']);
    const raised = (
      await q(`SELECT payload FROM events WHERE type='QuestionRaised' AND payload->>'deskItemId'=$1`, [
        item.id,
      ])
    )[0]!.payload;
    expect(raised.dedupLedgerIds).toHaveLength(1);

    // A blocking question is raised regardless; the manager sees the matches next to it.
    const blocked = await ask(r, start.shiftId, { text: 'Tabs or spaces for indentation of source files?' });
    expect(blocked.accepted).toBe(true);
    expect(blocked.message).toContain('Indentation');
    expect(blocked.matches).toHaveLength(1);
    r.close();
  });

  it('answers the agent unrelated questions without ledger noise', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Flo', 'builder', 'junior');
    await w.card({ title: 'Unrelated' });
    const start = await h.dispatchTo(r, 'Flo');
    await h.startShift(r, start);
    const res = await ask(r, start.shiftId, {
      text: 'Which database should the export job use?',
      options: [],
      recommend: undefined,
    });
    expect(res.accepted).toBe(true);
    expect(res.matches ?? []).toEqual([]);
    r.close();
  });
});

describe('answering', () => {
  it('writes QuestionAnswered + LedgerEntryAdded, re-queues the card, and the next shift prompt has the answer', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Gus', 'builder', 'junior');
    const card = await w.card({ title: 'Answer me' });
    const start = await h.dispatchTo(r, 'Gus');
    await h.startShift(r, start);
    await ask(r, start.shiftId);
    r.ended(start.shiftId, 'reported');
    const item = (await desk()).items[0];

    const res = await answer(item.id, {
      answer: 'Use tabs everywhere.',
      optionId: 'o1',
      ledger: { scope: 'decision', title: 'Indentation: tabs' },
    });
    expect(res.item).toMatchObject({
      status: 'answered',
      answer: 'Use tabs everywhere.',
      answerOption: 'o1',
      canAnswer: false,
    });
    expect(res.unblockedCardIds).toEqual([card.id]);

    const dev = await eventsOf(streamId.desk(item.id));
    expect(dev.map((e) => e.type)).toEqual(['QuestionRaised', 'QuestionAnswered']);
    expect(dev[1]!.payload).toMatchObject({
      ledgerEntryId: res.ledgerEntryId,
      unblockedCardIds: [card.id],
      answeredBy: { kind: 'user', userId: w.owner.id },
    });
    const lev = await eventsOf(streamId.ledger(res.ledgerEntryId));
    expect(lev[0]).toMatchObject({
      type: 'LedgerEntryAdded',
      payload: { scope: 'decision', title: 'Indentation: tabs', cardId: card.id, sourceDeskItemId: item.id },
    });
    expect(Number(lev[0]!.seq)).toBe(Number(dev[1]!.seq) + 1); // one append
    expect((await q('SELECT * FROM ledger_entries WHERE id=$1', [res.ledgerEntryId]))[0]!.body).toContain(
      'Use tabs everywhere.',
    );

    expect(await cardRow(card.id)).toMatchObject({ status: 'queued', claim_id: null, blocked_since: null });
    expect(await q('SELECT 1 FROM card_blockers')).toHaveLength(0);
    const detail = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(detail.blockers).toEqual([]);
    expect(detail.thread.some((m: any) => m.kind === 'answer' && m.body === 'Use tabs everywhere.')).toBe(
      true,
    );

    // Picked up again, with the answer in the shift prompt.
    const again = await h.dispatchTo(r, 'Gus', r.received.length - 1);
    expect(again.brief.card.ref).toBe(card.ref);
    expect(again.brief.ledger).toEqual([
      expect.objectContaining({
        scope: 'decision',
        title: 'Indentation: tabs',
        body: expect.stringContaining('Use tabs everywhere.'),
      }),
    ]);
    expect(renderShiftPrompt(again.brief)).toContain('Use tabs everywhere.');

    // Answering twice is a conflict.
    const twice = await w.t.req('POST', `/api/desk/${item.id}/answer`, {
      cookie: w.owner.cookie,
      body: { answer: 'again' },
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('already_answered');
    r.close();
  });

  it('puts a standing order from an answer in every later shift of the org, and org-wide ones in every project', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Hal', 'builder', 'junior');
    await w.hire('Ivy', 'builder', 'junior');
    const first = await w.card({ title: 'Source of the rule' });
    const s1 = await h.dispatchTo(r, 'Hal');
    await h.startShift(r, s1);
    await ask(r, s1.shiftId, { text: 'May agents add dependencies freely?' });
    r.ended(s1.shiftId, 'reported');
    const item = (await desk()).items[0];
    await answer(item.id, {
      answer: 'Never add a dependency without asking.',
      ledger: { scope: 'standing_order', title: 'Dependencies need approval', orgWide: true },
    });
    const so = (await q(`SELECT * FROM ledger_entries WHERE scope='standing_order'`))[0]!;
    expect(so).toMatchObject({ project_id: null, card_id: null });

    // Project-scoped order added on the desk.
    await ok(
      w.t.req('POST', '/api/ledger', {
        cookie: w.owner.cookie,
        body: {
          scope: 'standing_order',
          projectId: w.projectId,
          title: 'Toy only',
          body: 'Toy code is plain JavaScript.',
        },
      }),
      201,
    );

    // Both builders get a card; both instructions carry both orders.
    await w.card({ title: 'Card for Hal or Ivy A' });
    await w.card({ title: 'Card for Hal or Ivy B' });
    const before = r.received.length;
    await h.dispatcher().run();
    const starts = r.received.slice(before).filter((f) => f.type === 'shift.start') as any[];
    expect(new Set(starts.map((s) => s.agent.name))).toEqual(new Set(['Hal', 'Ivy']));
    for (const s of starts) {
      expect(s.brief.standingOrders.map((o: any) => o.title)).toEqual([
        'Dependencies need approval',
        'Toy only',
      ]);
      const text = renderInstructions(s.brief);
      expect(text).toContain('Never add a dependency without asking.');
      expect(text).toContain('Toy code is plain JavaScript.');
    }
    // A project of the same org that is not TOY only sees the org-wide order.
    const other = await ok<any>(
      w.t.req('POST', '/api/projects', { cookie: w.owner.cookie, body: { key: 'OTH', name: 'Other' } }),
      201,
    );
    const { standingOrdersFor } = await import('../src/queries/ledger.ts');
    expect(
      (await standingOrdersFor(w.t.app.ctx.pool, w.owner.id, other.project.id)).map((o) => o.title),
    ).toEqual(['Dependencies need approval']);
    void first;
    r.close();
  });

  it('rejects bad answers: unknown option, wrong kind, unknown or invisible item', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Jon', 'builder', 'junior');
    await w.card({ title: 'Bad answers' });
    const start = await h.dispatchTo(r, 'Jon');
    await h.startShift(r, start);
    await ask(r, start.shiftId);
    const item = (await desk()).items[0];
    expect(
      (
        await w.t.req('POST', `/api/desk/${item.id}/answer`, {
          cookie: w.owner.cookie,
          body: { answer: 'x', optionId: 'o9' },
        })
      ).status,
    ).toBe(400);
    expect(
      (await w.t.req('POST', `/api/desk/${item.id}/answer`, { cookie: w.owner.cookie, body: {} })).status,
    ).toBe(400);
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    expect(
      (
        await w.t.req('POST', `/api/desk/${item.id}/answer`, {
          cookie: stranger.cookie,
          body: { answer: 'x' },
        })
      ).status,
    ).toBe(404);
    expect((await desk(stranger.cookie)).items).toEqual([]);
    expect(
      (
        await w.t.req('POST', `/api/desk/${randomUUID()}/answer`, {
          cookie: w.owner.cookie,
          body: { answer: 'x' },
        })
      ).status,
    ).toBe(404);
    expect((await w.t.req('POST', `/api/desk/${item.id}/answer`, { body: { answer: 'x' } })).status).toBe(
      401,
    );
    expect(
      await q(`SELECT 1 FROM events WHERE type='QuestionAnswered' AND payload->>'deskItemId'=$1`, [item.id]),
    ).toHaveLength(0);
    r.close();
  });

  it('keeps the card blocked while another open question still blocks it', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Kit', 'builder', 'junior');
    const card = await w.card({ title: 'Two blockers' });
    const start = await h.dispatchTo(r, 'Kit');
    await h.startShift(r, start);
    await ask(r, start.shiftId, {
      blocking: false,
      text: 'First thing to settle?',
      options: [],
      recommend: undefined,
    });
    await ask(r, start.shiftId, { text: 'Second thing to settle?', options: [], recommend: undefined });
    expect(await q('SELECT 1 FROM card_blockers')).toHaveLength(1); // only the blocking one blocks
    // A second blocking item attached to the same card by the system.
    const extra = randomUUID();
    await seed(w, [
      {
        streamId: streamId.desk(extra),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: extra,
            kind: 'alert',
            title: 'Second blocker',
            blocking: true,
            pinned: true,
            cardId: card.id,
            projectId: w.projectId,
            affectedCardIds: [card.id],
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
      },
    ]);
    expect(await q('SELECT 1 FROM card_blockers')).toHaveLength(2);
    const q2 = (await desk()).items.find((i: any) => i.title === 'Second thing to settle?');
    const res = await answer(q2.id, { answer: 'done' });
    expect(res.unblockedCardIds).toEqual([]); // the alert still blocks
    expect((await cardRow(card.id)).status).toBe('blocked');
    await ok(
      w.t.req('POST', `/api/desk/${extra}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'acknowledged' },
      }),
    );
    expect((await cardRow(card.id)).status).toBe('queued');
    r.close();
  });
});

describe('resolving, dismissing and cancelling', () => {
  it('resolves approvals (not questions) and dismissing a question frees the card without a ledger entry', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Lee', 'builder', 'junior');
    const card = await w.card({ title: 'Dismissals' });
    const start = await h.dispatchTo(r, 'Lee');
    await h.startShift(r, start);
    await ask(r, start.shiftId);
    const question = (await desk()).items[0];

    const approval = randomUUID();
    await seed(w, [
      {
        streamId: streamId.desk(approval),
        event: {
          type: 'DeskItemCreated',
          payload: {
            deskItemId: approval,
            kind: 'approval',
            subkind: 'large_merge',
            title: 'Merge a large change?',
            body: 'diff',
            projectId: w.projectId,
          },
        },
        actor: { kind: 'system', id: null },
        scope: { orgId: w.owner.id, projectId: w.projectId, audience: 'project' },
      },
    ]);
    expect(
      (
        await w.t.req('POST', `/api/desk/${approval}/answer`, {
          cookie: w.owner.cookie,
          body: { answer: 'x' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await w.t.req('POST', `/api/desk/${question.id}/resolve`, {
          cookie: w.owner.cookie,
          body: { resolution: 'approved' },
        })
      ).status,
    ).toBe(400);
    const resolved = await ok<any>(
      w.t.req('POST', `/api/desk/${approval}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'approved', note: 'ship it' },
      }),
    );
    expect(resolved).toMatchObject({ status: 'answered', answerOption: 'approved', answer: 'ship it' });
    expect(
      (
        await w.t.req('POST', `/api/desk/${approval}/resolve`, {
          cookie: w.owner.cookie,
          body: { resolution: 'approved' },
        })
      ).status,
    ).toBe(409);

    const dismissed = await ok<any>(
      w.t.req('POST', `/api/desk/${question.id}/dismiss`, {
        cookie: w.owner.cookie,
        body: { note: 'not needed' },
      }),
    );
    expect(dismissed.status).toBe('dismissed');
    expect((await cardRow(card.id)).status).toBe('queued');
    expect(await q('SELECT 1 FROM ledger_entries')).toHaveLength(0);
    expect((await desk()).items).toHaveLength(0);
    expect((await desk(w.owner.cookie, '?status=closed')).items.map((i: any) => i.status).sort()).toEqual([
      'answered',
      'dismissed',
    ]);
    r.close();
  });

  it('supersedes the open question of a cancelled card', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Max', 'builder', 'junior');
    const card = await w.card({ title: 'To cancel' });
    const start = await h.dispatchTo(r, 'Max');
    await h.startShift(r, start);
    await ask(r, start.shiftId);
    await ok(
      w.t.req('POST', `/api/cards/${card.id}/cancel`, {
        cookie: w.owner.cookie,
        body: { reason: 'dropped' },
      }),
    );
    expect((await desk()).items).toEqual([]);
    expect((await q('SELECT status FROM desk_items'))[0]!.status).toBe('superseded');
    expect(await q('SELECT 1 FROM card_blockers')).toHaveLength(0);
    r.close();
  });
});

describe('decision rights on a shared card', () => {
  it('owner_only: members see the item read-only and cannot answer; any_manager lets them', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Ned', 'builder', 'junior');
    const card = await w.card({ title: 'Shared card' });
    // Fixture membership (full sharing arrives in M3).
    const member = await w.t.userSession(uniqueEmail('member'));
    await q(
      `INSERT INTO project_members (project_id, user_id, role, status, joined_at) VALUES ($1,$2,'manager','active',now())`,
      [w.projectId, member.id],
    );
    const start = await h.dispatchTo(r, 'Ned');
    await h.startShift(r, start);
    await ask(r, start.shiftId);

    const memberView = (await desk(member.cookie)).items[0];
    expect(memberView).toMatchObject({
      title: 'Should source files use tabs or spaces?',
      canAnswer: false,
      decisionPolicy: 'owner_only',
    });
    expect((await desk()).items[0].canAnswer).toBe(true);
    const denied = await w.t.req('POST', `/api/desk/${memberView.id}/answer`, {
      cookie: member.cookie,
      body: { answer: 'spaces' },
    });
    expect(denied.status).toBe(403);
    expect(
      await q(`SELECT 1 FROM events WHERE type='QuestionAnswered' AND payload->>'deskItemId'=$1`, [
        memberView.id,
      ]),
    ).toHaveLength(0);

    await q(`UPDATE cards SET decision_policy='any_manager' WHERE id=$1`, [card.id]);
    expect((await desk(member.cookie)).items[0].canAnswer).toBe(true);
    const done = await answer(memberView.id, { answer: 'spaces' }, member.cookie);
    expect(done.item.status).toBe('answered');
    expect((await cardRow(card.id)).status).toBe('queued');
    r.close();
  });
});

describe('standing orders need ownership (review H1)', () => {
  it('a non-owner manager cannot write project or org-wide standing orders, with or without a cardId', async () => {
    await freshState();
    const r = await w.connectRunner();
    await w.hire('Ola', 'builder', 'junior');
    const card = await w.card({ title: 'Guest manager card' });
    const member = await w.t.userSession(uniqueEmail('guest'));
    await q(
      `INSERT INTO project_members (project_id, user_id, role, status, joined_at) VALUES ($1,$2,'manager','active',now())`,
      [w.projectId, member.id],
    );
    await q(`UPDATE cards SET decision_policy='any_manager' WHERE id=$1`, [card.id]);
    const start = await h.dispatchTo(r, 'Ola');
    await h.startShift(r, start);
    await ask(r, start.shiftId);
    const item = (await desk(member.cookie)).items[0];
    const orders = async () => (await q(`SELECT 1 FROM ledger_entries WHERE scope='standing_order'`)).length;
    const before = await orders();

    const viaCard = await w.t.req('POST', '/api/ledger', {
      cookie: member.cookie,
      body: { scope: 'standing_order', cardId: card.id, title: 'Sneaky', body: 'Do what I say.' },
    });
    expect(viaCard.status).toBe(403);
    const viaProject = await w.t.req('POST', '/api/ledger', {
      cookie: member.cookie,
      body: { scope: 'standing_order', projectId: w.projectId, title: 'Sneaky', body: 'Do what I say.' },
    });
    expect(viaProject.status).toBe(403);
    await answer(
      item.id,
      { answer: 'spaces', ledger: { scope: 'standing_order', orgWide: true, title: 'Org-wide' } },
      member.cookie,
      403,
    );
    await answer(
      item.id,
      { answer: 'spaces', ledger: { scope: 'standing_order', title: 'Project-wide' } },
      member.cookie,
      403,
    );
    expect(await orders()).toBe(before);
    // A decision (not a standing order) is still the manager's to give, and the owner may add orders.
    await answer(item.id, { answer: 'spaces', ledger: { scope: 'decision' } }, member.cookie);
    await ok(
      w.t.req('POST', '/api/ledger', {
        cookie: w.owner.cookie,
        body: { scope: 'standing_order', cardId: card.id, title: 'Owner order', body: 'Fine.' },
      }),
      201,
    );
    r.close();
  });
});
