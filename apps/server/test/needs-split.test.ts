import { MIN_RUNNER_FOR_NEEDS_SPLIT, NEEDS_SPLIT_DESK_SUBKIND } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { baTaskPass } from '../src/dispatcher/ba-tasks.ts';
import { keepOnline } from './helpers/ceo.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, fullFields, ok, type World } from './helpers/world.ts';

/**
 * Needs split: an over-budget card goes back to the BA once with the architect's folder scope and seams (AC1), the BA's
 * split creates children linked to the parent (AC2), and a second over-budget verdict goes to the owner's desk (AC3).
 */
let w: World;
let r: FakeRunner;
const ctx = () => w.t.app.ctx;

const proposal = {
  reason: 'Estimated 1400 changed lines against a budget of 400.',
  folderScope: ['apps/server/src/commands', 'apps/web/src/components'],
  seams: [
    {
      title: 'Server: the transition',
      folders: ['apps/server/src/commands'],
      note: 'the command and the route',
    },
    { title: 'Web: the panel', folders: ['apps/web/src/components'] },
  ],
  estimate: { size: 1400, budget: 400, unit: 'changed_lines' },
};

beforeAll(async () => {
  w = await createWorld({ lean: true, env: { AOM_FIRST_RUN_HIRE_CAP: 'false', AOM_MOCK_UI: 'true' } });
  r = await w.connectRunner();
  await q('UPDATE workstations SET runner_version=$2 WHERE id=$1', [
    w.workstationId,
    MIN_RUNNER_FOR_NEEDS_SPLIT,
  ]);
  await w.hire('Ben', 'ba', 'senior');
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const tasksOf = async (cardId: string) =>
  q(`SELECT * FROM ba_tasks WHERE card_id=$1 AND kind='spec_card' ORDER BY created_at`, [cardId]);
const openDecision = async (cardId: string) =>
  q(`SELECT * FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`, [
    cardId,
    NEEDS_SPLIT_DESK_SUBKIND,
  ]);

/** A specified card moved into the design stage (where the over-budget verdict comes from). */
async function cardAtDesign(title: string) {
  const card = await w.card({ title, repoId: w.repoId });
  await ok(
    w.t.req('POST', `/api/cards/${card.id}/move`, {
      cookie: w.owner.cookie,
      body: { toStage: 'investigate', reason: 'to the design' },
    }),
  );
  return card as { id: string; ref: string };
}

const needsSplit = (id: string, body: unknown = proposal) =>
  w.t.req('POST', `/api/cards/${id}/needs-split`, { cookie: w.owner.cookie, body });

async function dispatch() {
  await keepOnline(w);
  const from = r.received.length;
  await baTaskPass(ctx());
  const start = (await r.waitFor(
    'shift.start',
    (f) => f.kind === 'ba_task' && f.baTask?.kind === 'spec_card',
    8000,
    from,
  )) as any;
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  return start;
}
async function report(start: any, outcomeId: string, data: unknown, note = 'done') {
  const sent = r.report(start.shiftId, { kind: 'outcome', outcomeId, note, data });
  return (await r.waitFor('shift.report.result', (f) => f.reportId === sent.reportId)) as any;
}
const answer = (itemId: string, optionId: string) =>
  ok(
    w.t.req('POST', `/api/desk/${itemId}/answer`, {
      cookie: w.owner.cookie,
      body: { answer: `chose ${optionId}`, optionId },
    }),
  );

describe('needs split, first time (AC1)', () => {
  it('sends the card to the BA with the folder scope and seams visible', async () => {
    const card = await cardAtDesign('Too big a card');
    const res = await ok<any>(needsSplit(card.id));
    expect(res.needsSplitRoute).toBe('ba');
    expect(res.card.stage).toBe('spec');
    expect(res.card.status).toBe('draft');
    expect(res.needsSplit).toMatchObject({
      state: 'with_ba',
      reason: 'first',
      round: 1,
      fromStage: 'investigate',
    });
    expect(res.needsSplit.proposal.folderScope).toEqual(proposal.folderScope);
    expect(res.needsSplit.proposal.seams.map((s: any) => s.title)).toEqual(
      proposal.seams.map((s) => s.title),
    );
    expect(res.needsSplitTaken).toBe(true);
    expect((await cardRow(card.id)).needs_split_count).toBe(1);
    const tasks = await tasksOf(card.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'queued' });
    expect(res.needsSplit.taskId).toBe(tasks[0]!.id);

    // the thread shows the scope and the seams at once
    const notes = await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system'`, [card.id]);
    const all = notes.map((n) => n.body).join('\n');
    for (const f of proposal.folderScope) expect(all).toContain(f);

    // the BA's brief carries the proposal
    const start = await dispatch();
    expect(start.baTask.specCard.needsSplit.proposal.seams.map((s: any) => s.title)).toEqual(
      proposal.seams.map((s) => s.title),
    );
    expect(start.baTask.specCard.needsSplit.defaultRepo).toBe('toy');
    // a fields-only report is refused: this card was returned to be split
    const fieldsOnly = await report(start, 'spec_card_done', { fields: { context: 'x' } });
    expect(fieldsOnly.accepted).toBe(false);
    expect(fieldsOnly.error).toContain('returned to be split');
    // close the task: the BA cannot split it, so the owner decides (covered in AC3)
    expect((await report(start, 'spec_card_fail', {}, 'not now')).accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
  });

  it('refuses a file in the folder scope (400), a non-manager (403) and a card already being built (409)', async () => {
    const card = await cardAtDesign('Refusals');
    const bad = await needsSplit(card.id, { ...proposal, folderScope: ['apps/server/src/index.ts'] });
    expect(bad.status).toBe(400);
    const stranger = await w.t.userSession(`stranger-${Date.now()}@example.com`);
    const denied = await w.t.req('POST', `/api/cards/${card.id}/needs-split`, {
      cookie: stranger.cookie,
      body: proposal,
    });
    expect([403, 404]).toContain(denied.status);
    await q(
      `INSERT INTO card_handoffs (id, card_id, stage, outcome, note, event_seq, created_at)
       VALUES (gen_random_uuid(), $1, 'build', 'handoff', 'built', 0, now())`,
      [card.id],
    );
    const late = await needsSplit(card.id);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('needs_split_too_late');
  });
});

describe('the BA splits it (AC2)', () => {
  it('creates child cards linked to the parent', async () => {
    const card = await cardAtDesign('Split me');
    await ok(needsSplit(card.id));
    const start = await dispatch();
    const fields = fullFields();
    const sent = await report(start, 'spec_card_done', {
      split: [
        {
          title: 'Server: the transition',
          repo: 'toy',
          fields: { ...fields, affectedAreas: 'apps/server/src/commands' },
        },
        {
          title: 'Web: the panel',
          repo: 'toy',
          fields: { ...fields, affectedAreas: 'apps/web/src/components' },
          dependsOn: [1],
        },
      ],
    });
    expect(sent.accepted, JSON.stringify(sent)).toBe(true);
    r.ended(start.shiftId, 'reported');

    const kids = await q('SELECT * FROM cards WHERE parent_card_id=$1 ORDER BY number', [card.id]);
    expect(kids).toHaveLength(2);
    const parent = await cardRow(card.id);
    expect(parent.status).toBe('cancelled');
    expect(parent.needs_split).toMatchObject({ state: 'split', childCardIds: kids.map((k) => k.id) });

    const detail = await ok<any>(w.t.req('GET', `/api/cards/${card.id}`, { cookie: w.owner.cookie }));
    expect(detail.splitInto.map((c: any) => c.id)).toEqual(kids.map((k) => k.id));
    expect(detail.needsSplit.state).toBe('split');
    for (const k of kids) {
      const kd = await ok<any>(w.t.req('GET', `/api/cards/${k.id}`, { cookie: w.owner.cookie }));
      expect(kd.splitFrom).toMatchObject({ id: card.id, ref: card.ref });
      // a child of a needs-split split inherits the one return
      expect(kd.needsSplitTaken).toBe(true);
    }

    // AC3, inherited: a child that is over budget again goes to the owner, not the BA
    await ok(
      w.t.req('POST', `/api/cards/${kids[0]!.id}/move`, {
        cookie: w.owner.cookie,
        body: { toStage: 'investigate', reason: 'to the design' },
      }),
    );
    const again = await ok<any>(needsSplit(kids[0]!.id));
    expect(again.needsSplitRoute).toBe('owner');
    expect(again.needsSplit).toMatchObject({ state: 'owner', reason: 'inherited' });
    expect(await tasksOf(kids[0]!.id)).toHaveLength(0);
    expect(await openDecision(kids[0]!.id)).toHaveLength(1);
  });
});

describe('a second over-budget verdict (AC3)', () => {
  it("goes to the owner's desk, not the BA; the owner's options work", async () => {
    const card = await cardAtDesign('Twice too big');
    await ok(needsSplit(card.id));
    const start = await dispatch();
    // the BA cannot split it: the owner decides
    const failed = await report(start, 'spec_card_fail', {}, 'no clean seam');
    expect(failed.accepted).toBe(true);
    r.ended(start.shiftId, 'reported');
    expect((await cardRow(card.id)).needs_split).toMatchObject({ state: 'owner' });
    const [first] = await openDecision(card.id);
    expect(first).toBeDefined();
    expect(first!.data).toMatchObject({ reason: 'ba_failed' });
    expect(
      await q(`SELECT 1 FROM desk_items WHERE card_id=$1 AND subkind='spec_needed'`, [card.id]),
    ).toHaveLength(0);

    // keep it as one card: back to the design stage it came from
    await answer(first!.id, 'continue');
    let row = await cardRow(card.id);
    expect(row.stage).toBe('investigate');
    expect(row.needs_split).toMatchObject({ state: 'continued' });

    // over budget again: the owner's desk, no new BA task, the card stays where it is
    const again = await ok<any>(needsSplit(card.id));
    expect(again.needsSplitRoute).toBe('owner');
    expect(again.needsSplit).toMatchObject({ state: 'owner', reason: 'second_time' });
    expect(again.card.stage).toBe('investigate');
    expect(await tasksOf(card.id)).toHaveLength(1);
    const [second] = await openDecision(card.id);
    expect(second).toBeDefined();
    expect((second!.options as any[]).map((o) => o.id)).toEqual(['continue', 'ba_again', 'cancel']);
    expect(second!.chain_level ?? 'desk').toBe('desk');

    // asking again while the owner decides is refused
    expect((await needsSplit(card.id)).status).toBe(409);

    // the owner sends it to the BA anyway: a second task, the count goes to 2
    await answer(second!.id, 'ba_again');
    row = await cardRow(card.id);
    expect(row.stage).toBe('spec');
    expect(row.needs_split_count).toBe(2);
    expect(row.needs_split).toMatchObject({ state: 'with_ba', reason: 'owner_again' });
    expect(await tasksOf(card.id)).toHaveLength(2);
  });

  it('the owner can cancel the card', async () => {
    const card = await cardAtDesign('Cancel me');
    await q('UPDATE cards SET needs_split_count=1 WHERE id=$1', [card.id]);
    const res = await ok<any>(needsSplit(card.id));
    expect(res.needsSplitRoute).toBe('owner');
    const [item] = await openDecision(card.id);
    await answer(item!.id, 'cancel');
    const row = await cardRow(card.id);
    expect(row.status).toBe('cancelled');
    expect(row.needs_split).toMatchObject({ state: 'cancelled' });
  });
});
