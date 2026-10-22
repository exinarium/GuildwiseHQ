import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  approve,
  cardRow,
  changes,
  DIFF_LARGE,
  DIFF_SMALL,
  handoff,
  hireTeam,
  pipeline,
} from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

describe('review tiers', () => {
  it('a large-tier card needs two approvals from two distinct senior reviewers', async () => {
    await freshState();
    await hireTeam(w, { reviewers: ['Rex', 'Ria'] });
    const card = await w.card({ title: 'Big refactor' });
    await p.run('Bea', handoff(), DIFF_LARGE);
    expect(await cardRow(card.id)).toMatchObject({
      stage: 'review',
      risk_tier: 'large',
      review_approvals: 0,
    });

    const first = await p.run('Rex', approve('first'));
    expect(first.start.brief.shift.stage).toBe('review');
    let c = await cardRow(card.id);
    expect(c).toMatchObject({ stage: 'review', status: 'queued', review_approvals: 1 });
    expect(c.excluded_agent_ids).toContain(first.start.agent.agentId);

    // the same reviewer is never offered the card again; the other one is
    const start = await p.next('Ria');
    expect(
      r.of('shift.start').filter((f) => f.agent.name === 'Rex' && f.brief.card.ref === card.ref),
    ).toHaveLength(1);
    await p.startShift(r, start);
    await p.report(r, start.shiftId, approve('second'));
    r.ended(start.shiftId, 'reported');
    await until(async () => (await cardRow(card.id)).stage === 'test', 3000, 'second approval');
    c = await cardRow(card.id);
    expect(c).toMatchObject({ stage: 'test', status: 'queued' });
    const approvals = await q(
      `SELECT payload FROM events WHERE type='ReviewApproved' AND payload->>'cardId'=$1 ORDER BY seq`,
      [card.id],
    );
    expect(
      approvals.map((e) => [e.payload.approvalsSoFar, e.payload.approvalsRequired, e.payload.toStage]),
    ).toEqual([
      [1, 2, 'review'],
      [2, 2, 'test'],
    ]);
  });

  it('with one senior reviewer the second approval of a large card never gets claimed by the same agent', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Big, one reviewer' });
    await p.run('Bea', handoff(), DIFF_LARGE);
    await p.run('Rex', approve());
    const made = await w.t.app.ctx.services.dispatcher.runPass();
    expect(made.filter((m) => m.cardId === card.id)).toHaveLength(0);
    expect((await cardRow(card.id)).stage).toBe('review');
  });

  it('a small card needs one approval', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Tiny' });
    await p.toTest('Bea', ['Rex'], DIFF_SMALL);
    expect((await cardRow(card.id)).stage).toBe('test');
  });
});

describe('out-of-scope unit test changes are the reviewer\'s decision', () => {
  // A diff recorded by an older runner still carries the retired flag; it must not matter any more.
  const legacy = {
    diffStats: { files: 3, added: 20, removed: 5, architecturalPaths: [], outOfScopeTestChange: true },
    riskTier: 'small',
  };

  it('accepts an approval although the diff carries the legacy flag', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Edited a foreign test' });
    await p.run('Bea', handoff(), legacy);

    const start = await p.next('Rex');
    await p.startShift(r, start);
    const res = await p.report(r, start.shiftId, approve());
    expect(res).toMatchObject({ accepted: true });
    r.ended(start.shiftId, 'reported');
    expect((await cardRow(card.id)).stage).not.toBe('review');
  });

  it('stores only the reasons the reviewer gave', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Weak tests only' });
    await p.run('Bea', handoff(), legacy);

    const start = await p.next('Rex');
    await p.startShift(r, start);
    const ok = await p.report(r, start.shiftId, changes(['weak_tests']));
    expect(ok).toMatchObject({ accepted: true });
    r.ended(start.shiftId, 'reported');
    const ev = await q(`SELECT payload FROM events WHERE type='ChangesRequested' AND payload->>'cardId'=$1`, [
      card.id,
    ]);
    expect(ev[0]?.payload.reasons).toEqual(['weak_tests']);
  });

  it('lets the reviewer request changes for out-of-scope tests by hand', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Reviewer judges scope' });
    await p.run('Bea', handoff());

    const start = await p.next('Rex');
    await p.startShift(r, start);
    const ok = await p.report(r, start.shiftId, changes(['out_of_scope_test_change']));
    expect(ok).toMatchObject({ accepted: true });
    r.ended(start.shiftId, 'reported');
    expect(await cardRow(card.id)).toMatchObject({ stage: 'build', rework_round: 1 });
  });
});
