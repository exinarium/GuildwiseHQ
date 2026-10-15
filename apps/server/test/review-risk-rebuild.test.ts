import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, DIFF_LARGE, DIFF_SMALL, hireTeam, pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const handoff = { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} };

describe('reviewer risk projection (backlog #70)', () => {
  it('a rebuild reproduces the risk', async () => {
    const p = pipeline(w, r);
    await hireTeam(w);
    const card = await w.card({ title: 'Risky replay' });
    await p.run('Bea', handoff, DIFF_SMALL);
    await p.run('Rex', {
      kind: 'outcome',
      outcomeId: 'approve',
      note: 'ok',
      data: { score: 4, risk: 'high', riskAnalysis: 'scenario A', qaFocus: 'try A' },
    });
    const before = (await q('SELECT review_risk FROM cards WHERE id=$1', [card.id]))[0]!.review_risk;
    expect(before).toEqual({ level: 'high', analysis: 'scenario A', qaFocus: 'try A' });
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    const after = (await q('SELECT review_risk FROM cards WHERE id=$1', [card.id]))[0]!.review_risk;
    expect(after).toEqual(before);
  });

  it('two approvals keep the highest risk and both analyses; a rework round clears them', async () => {
    await freshState();
    r.close();
    r = await w.connectRunner();
    const p = pipeline(w, r);
    await hireTeam(w, { reviewers: ['Rex', 'Ria'] });
    const card = await w.card({ title: 'Large replay' });
    await p.run('Bea', handoff, DIFF_LARGE);
    const approve = (data: Record<string, unknown>) => ({
      kind: 'outcome',
      outcomeId: 'approve',
      note: 'ok',
      data: { score: 4, ...data },
    });
    await p.run('Rex', approve({ risk: 'medium', riskAnalysis: 'first look', qaFocus: 'focus one' }));
    expect((await cardRow(card.id)).review_risk).toMatchObject({ level: 'medium' });
    await p.run('Ria', approve({ risk: 'high', riskAnalysis: 'second look', qaFocus: 'focus two' }));
    const merged = (await cardRow(card.id)).review_risk;
    expect(merged.level).toBe('high');
    expect(merged.analysis).toContain('first look');
    expect(merged.analysis).toContain('second look');
    expect(merged.qaFocus).toContain('focus one');
    expect(merged.qaFocus).toContain('focus two');
  });

  it('requesting changes after a first approval and handing off again clears the risk', async () => {
    await freshState();
    r.close();
    r = await w.connectRunner();
    const p = pipeline(w, r);
    await hireTeam(w, { reviewers: ['Rex', 'Ria'] });
    const card = await w.card({ title: 'Large rework' });
    await p.run('Bea', handoff, DIFF_LARGE);
    await p.run('Rex', {
      kind: 'outcome',
      outcomeId: 'approve',
      note: 'ok',
      data: { score: 4, risk: 'medium', riskAnalysis: 'a', qaFocus: 'b' },
    });
    await p.run('Ria', {
      kind: 'outcome',
      outcomeId: 'changes',
      note: 'no',
      data: { score: 2, reasons: ['regression_risk'], criteriaMissed: [], risk: 'high', riskAnalysis: 'c' },
    });
    await p.run('Bea', handoff, DIFF_LARGE);
    expect(await cardRow(card.id)).toMatchObject({ stage: 'review', review_risk: null });
  });
});
