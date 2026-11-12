import { MIN_RUNNER_FOR_NEEDS_SPLIT, NEEDS_SPLIT_QUESTION_SUBKIND } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { needsSplitQuestionEvents } from '../src/commands/design-size.ts';
import { withTx } from '../src/db/tx.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

/**
 * The answer to the architect's needs-split question (AC2): "build it as designed" completes the design stage with the
 * handoff's outcome and the card goes on to Build; "split" sends it back to the BA once with the folder scope and seams.
 */
let w: World;
let r: FakeRunner;
let architect: { id: string; name: string };
const ctx = () => w.t.app.ctx;

const sizing = {
  unit: 'changed_lines',
  budget: 400,
  estimate: 1400,
  verdict: 'over_budget',
  note: null,
  paths: ['apps/server/src/commands', 'apps/web/src/components'],
  risk: { class: 'medium', fromPaths: 'medium', declared: null },
  seams: [],
} as never;
const proposal = {
  reason: 'Estimated 1400 changed lines against a budget of 400.',
  folderScope: ['apps/server/src/commands', 'apps/web/src/components'],
  seams: [
    { title: 'Server: the transition', folders: ['apps/server/src/commands'] },
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
  const hired = await w.hire('Aria', 'architect', 'senior');
  architect = { id: hired.id ?? hired.agent?.id, name: 'Aria' };
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;

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

/** Raises the architect's question the way the over-budget design handoff does. */
async function raise(cardId: string, outcomeId?: string) {
  await withTx(ctx().pool, async (tx) => {
    const card = (await q('SELECT * FROM cards WHERE id=$1', [cardId]))[0]!;
    const agent = (await q('SELECT * FROM agents WHERE id=$1', [architect.id]))[0]!;
    const events = await needsSplitQuestionEvents(
      ctx(),
      tx,
      card,
      agent,
      undefined,
      sizing,
      proposal as never,
      outcomeId,
    );
    expect(events.length).toBeGreaterThan(0);
    await ctx().store.append(events, { tx });
  });
  const items = await q(`SELECT * FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`, [
    cardId,
    NEEDS_SPLIT_QUESTION_SUBKIND,
  ]);
  expect(items).toHaveLength(1);
  return items[0]!;
}
const answer = (itemId: string, optionId: string) =>
  ok(
    w.t.req('POST', `/api/desk/${itemId}/answer`, {
      cookie: w.owner.cookie,
      body: { answer: `chose ${optionId}`, optionId },
    }),
  );

describe("the architect's needs-split question", () => {
  it('blocks the card, asked by the architect, and keeps the handoff outcome in its data', async () => {
    const card = await cardAtDesign('Over budget, blocked');
    const item = await raise(card.id, 'handoff');
    expect(item.blocking).toBe(true);
    expect(item.data).toMatchObject({ outcomeId: 'handoff', fromStage: 'investigate' });
    expect((await cardRow(card.id)).status).toBe('blocked');
    // one open question per card
    await withTx(ctx().pool, async (tx) => {
      const row = (await q('SELECT * FROM cards WHERE id=$1', [card.id]))[0]!;
      const agent = (await q('SELECT * FROM agents WHERE id=$1', [architect.id]))[0]!;
      expect(
        await needsSplitQuestionEvents(
          ctx(),
          tx,
          row,
          agent,
          undefined,
          sizing,
          proposal as never,
          'handoff',
        ),
      ).toEqual([]);
    });
  });

  it("'build it as designed' completes the design stage: the card goes on to Build", async () => {
    const card = await cardAtDesign('Over budget, kept as one');
    const item = await raise(card.id, 'handoff');
    await answer(item.id, 'build');
    const row = await cardRow(card.id);
    expect(row.stage).toBe('build');
    expect(row.status).not.toBe('blocked');
    const completed = await q(
      `SELECT payload FROM events WHERE stream_id LIKE $1 AND type='StageCompleted' ORDER BY seq DESC LIMIT 1`,
      [`%${card.id}`],
    );
    expect(completed[0]?.payload).toMatchObject({
      fromStage: 'investigate',
      toStage: 'build',
      outcome: 'handoff',
    });
  });

  it("'build' with a stored outcome the stage does not have still completes it (its success outcome)", async () => {
    const card = await cardAtDesign('Over budget, unknown outcome');
    const item = await raise(card.id, 'done');
    await answer(item.id, 'build');
    expect((await cardRow(card.id)).stage).toBe('build');
  });

  it("'split' sends the card back to the BA with the folder scope and seams", async () => {
    const card = await cardAtDesign('Over budget, split');
    const item = await raise(card.id, 'handoff');
    await answer(item.id, 'split');
    const row = await cardRow(card.id);
    expect(row.stage).toBe('spec');
    expect(row.needs_split_count).toBe(1);
    const tasks = await q(`SELECT * FROM ba_tasks WHERE card_id=$1 AND kind='spec_card'`, [card.id]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ status: 'queued' });
  });
});
