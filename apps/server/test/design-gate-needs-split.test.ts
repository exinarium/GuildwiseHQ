import { MIN_RUNNER_FOR_DESIGN_SIZE, NEEDS_SPLIT_QUESTION_SUBKIND } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { designed, hireLeanTeam, leanPipeline, planned, resetLean } from './helpers/lean.ts';
import { cardRow, eventsOfType } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, type World } from './helpers/world.ts';

// The design gate together with the size budget: an over-budget design stops for the needs-split question first, and
// the gate still applies when the owner then chooses to build it as designed.

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof leanPipeline>;
beforeAll(async () => {
  w = await createWorld({
    env: { AOM_FIRST_RUN_HIRE_CAP: 'false' },
    project: { workflowKey: 'code' },
    lean: true,
    designGate: true,
    integrationTests: 'off',
  });
  r = await w.connectRunner();
  p = leanPipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

async function team(gate: boolean) {
  await freshState();
  await resetLean();
  w.t.app.ctx.services.dispatcher.cooldown.clear();
  await q(
    `UPDATE projects SET design_gate=$2, risk_map=NULL, size_budget=400, size_unit='changed_lines' WHERE id=$1`,
    [w.projectId, gate],
  );
  await q('UPDATE workstations SET runner_version=$2 WHERE id=$1', [
    w.workstationId,
    MIN_RUNNER_FOR_DESIGN_SIZE,
  ]);
  await hireLeanTeam(w);
}

/** A design hand-off with a size estimate (over the budget of 400 with two seams, unless given). */
function sizedDesign(ref: string, estimate = 1400) {
  const base = designed(ref);
  return {
    ...base,
    data: {
      ...base.data,
      size: {
        estimate,
        paths: ['apps/web/src/components', 'apps/web/src/pages'],
        seams: [
          { title: 'Web: the components', folders: ['apps/web/src/components'] },
          { title: 'Web: the pages', folders: ['apps/web/src/pages'] },
        ],
      },
    },
  };
}

async function cardAtDesign(title: string) {
  const card = await w.card({ title, fields: fullFields({ affectedAreas: 'apps/web/src/components/' }) });
  await p.run('Pia', planned());
  expect((await cardRow(card.id)).stage).toBe('investigate');
  return card;
}

const openQuestion = async (cardId: string) =>
  q(`SELECT * FROM desk_items WHERE card_id=$1 AND subkind=$2 AND status='open'`, [
    cardId,
    NEEDS_SPLIT_QUESTION_SUBKIND,
  ]);

describe('design gate and needs-split', () => {
  it('an over-budget design with the gate on stops for the needs-split question, not at the gate', async () => {
    await team(true);
    const card = await cardAtDesign('Over budget, gate on');
    await p.run('Arc', sizedDesign(card.ref));
    const row = await cardRow(card.id);
    expect(row.stage).toBe('investigate');
    expect(row.stage).not.toBe('design_gate');
    expect(await openQuestion(card.id)).toHaveLength(1);
    // the gate decision is recorded all the same
    expect(row).toMatchObject({ design_gate_required: true, design_gate_reason: 'project' });
    const decided = (await eventsOfType('DesignGateDecided')).filter((e) => e.cardId === card.id);
    expect(decided).toEqual([expect.objectContaining({ required: true, reason: 'project' })]);
  });

  it("'build it as designed' then goes to the design gate, not straight to Build", async () => {
    await team(true);
    const card = await cardAtDesign('Over budget, kept as one, gate on');
    await p.run('Arc', sizedDesign(card.ref));
    const [item] = await openQuestion(card.id);
    expect(item).toBeDefined();
    await ok(
      w.t.req('POST', `/api/desk/${item!.id}/answer`, {
        cookie: w.owner.cookie,
        body: { answer: 'chose build', optionId: 'build' },
      }),
    );
    expect((await cardRow(card.id)).stage).toBe('design_gate');
  });

  it("with the gate off, 'build it as designed' goes on to Build as before", async () => {
    await team(false);
    const card = await cardAtDesign('Over budget, kept as one, gate off');
    await p.run('Arc', sizedDesign(card.ref));
    expect((await cardRow(card.id)).design_gate_required).toBe(false);
    const [item] = await openQuestion(card.id);
    await ok(
      w.t.req('POST', `/api/desk/${item!.id}/answer`, {
        cookie: w.owner.cookie,
        body: { answer: 'chose build', optionId: 'build' },
      }),
    );
    expect((await cardRow(card.id)).stage).toBe('build');
  });

  it('a design within the budget with the gate on goes to the gate directly', async () => {
    await team(true);
    const card = await cardAtDesign('Within budget, gate on');
    await p.run('Arc', sizedDesign(card.ref, 100));
    expect(await openQuestion(card.id)).toHaveLength(0);
    expect((await cardRow(card.id)).stage).toBe('design_gate');
  });
});
