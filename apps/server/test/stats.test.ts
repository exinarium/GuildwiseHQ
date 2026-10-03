import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROJECTION_TABLES } from '../src/projections/index.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { approveWith, board, bounce, diffWithTests, handoff } from './helpers/hr.ts';
import { pipeline, testFail, testPass } from './helpers/pipeline.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

// Stats of the HR board against a seeded event fixture whose numbers are worked out by hand below.
let w: World;
let r: FakeRunner;
let bea: any;
let rex: any;
let ben: any;

beforeAll(async () => {
  w = await createWorld();
  r = await w.connectRunner();
  const p = pipeline(w, r);
  bea = await w.hire('Bea', 'builder', 'junior', { model: 'sonnet' });
  rex = await w.hire('Rex', 'reviewer', 'senior');
  await w.hire('Tess', 'tester', 'junior');

  // Card A: small, with a test file; bounced once for weak tests (score 2, one criterion missed), then approved (4).
  await w.card({ title: 'A' });
  await p.run('Bea', handoff(), diffWithTests(1));
  await p.run('Rex', bounce(2, ['weak_tests'], ['c1']));
  await p.run('Bea', handoff(), diffWithTests(1));
  await p.run('Rex', approveWith(4));
  await p.run('Tess', testPass());
  // Card B: small, no test file; approved (5); the tester finds a bug, so the bug card B2 goes back to Bea.
  await w.card({ title: 'B' });
  await p.run('Bea', handoff(), diffWithTests(0));
  await p.run('Rex', approveWith(5));
  await p.run('Tess', testFail('Bug in B'));
  await p.run('Bea', handoff()); // B2: the diff is not measured (no testFiles)
  await p.run('Rex', approveWith(4));
  await p.run('Tess', testPass());
  // A second builder joins afterwards: no cards, so the team averages mix a busy and an idle builder.
  ben = await w.hire('Ben', 'builder', 'junior', { model: 'sonnet' });
  await w.t.app.ctx.notifier.flush();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const stats = (id: string) => ok<any>(w.t.req('GET', `/api/agents/${id}/stats`, { cookie: w.owner.cookie }));

describe('agent stats over the rolling window', () => {
  it("matches the hand-computed values of the builder's fixture", async () => {
    const { stats: s } = await stats(bea.id);
    expect(s.windowDays).toBe(30);
    // Bea touched A, B and the bug card B2: 3 cards, all of which she handed off.
    expect(s.cardsTouched).toBe(3);
    expect(s.cardsDone.value).toBe(3);
    expect(s.blockedRate.value).toBe(0); // nobody asked a question: 0 of 3
    expect(s.reworkRate.value).toBeCloseTo(1 / 3, 3); // only A was bounced: 1 of 3 submitted
    expect(s.bugsEscaped.value).toBeCloseTo(1 / 3, 3); // only B failed test: 1 of 3
    // Four shifts of 1200 tokens (A twice, B, B2) over 3 finished cards.
    expect(s.tokensPerCard.value).toBe(1600);
    // 4 shifts of one second against at least the one-hour floor of the window.
    expect(s.utilisation.value).toBeCloseTo(4000 / 3_600_000, 4);
    expect(s.doneByDay).toHaveLength(14);
    expect(s.doneByDay.at(-1)).toBe(4); // four handoffs today
  });

  it('shows every stat against the average of the role', async () => {
    const { stats: s } = await stats(bea.id);
    // Ben has no cards: counts average over both builders, rates only over the builders that have data.
    expect(s.cardsDone.team).toBe(1.5);
    expect(s.reworkRate.team).toBeCloseTo(1 / 3, 3);
    expect(s.blockedRate.team).toBe(0);
    expect(s.tokensPerCard.team).toBe(1600);
    expect((await stats(ben.id)).stats).toMatchObject({
      cardsTouched: 0,
      cardsDone: { value: 0, team: 1.5 },
      reworkRate: { value: null },
      blockedRate: { value: null },
      tokensPerCard: { value: null },
    });
  });

  it('builds the work quality panel from the reviews of the builder', async () => {
    const { quality: q1 } = await stats(bea.id);
    // Scores 2 (bounce), 4 (A approved) and 5 (B): 11 / 3. The bug card's review is a different workflow outcome.
    expect(q1.reviewCount).toBe(3);
    expect(q1.reviewScoreAvg).toBe(3.67);
    expect(q1.reworkByReason).toEqual([{ reason: 'weak_tests', count: 1, countsAgainstBuilder: true }]);
    expect(q1.reworkRoundsPerCard).toEqual({
      avg: expect.closeTo(1 / 3, 3),
      max: 1,
      cardsWithThreeOrMore: 0,
    });
    expect(q1.bugsEscaped).toBe(1);
    expect(q1.criteriaMissed).toBe(1);
    // Tests came with A (1 test file) but not with B; B2's diff was not measured.
    expect(q1.testCoverage).toEqual({ cardsWithTests: 1, cardsMeasured: 2, rate: 0.5 });
  });

  it('attributes work to the stage that did it: the reviewer has its own numbers, no rework or bugs', async () => {
    const { stats: s, quality } = await stats(rex.id);
    expect(s.cardsTouched).toBe(3);
    expect(s.cardsDone.value).toBe(3);
    expect(s.reworkRate.value).toBeNull();
    expect(s.bugsEscaped.value).toBeNull();
    expect(quality.reviewCount).toBe(0); // scores are given to builders, not received
    expect(s.tokensPerCard.value).toBe(1600); // four review shifts over three cards
  });

  it('serves the HR board with agents, stats, hiring manager and the window', async () => {
    const b = await ok<any>(w.t.req('GET', '/api/hr/board', { cookie: w.owner.cookie }));
    expect(b.windowDays).toBe(30);
    const names = b.agents.filter((a: any) => !a.agent.isDevops).map((a: any) => a.agent.name);
    expect(names).toEqual(['Bea', 'Rex', 'Tess', 'Ben']);
    const bea1 = b.agents.find((a: any) => a.agent.name === 'Bea');
    expect(bea1.hiredByName).toBeTruthy();
    expect(bea1.stats.cardsDone.value).toBe(3);
    expect(bea1.quality.reviewScoreAvg).toBe(3.67);
    expect(b.roleUpdates).toEqual([]);
    // Another user sees nothing of this organization.
    const other = await w.t.userSession(`other-${Date.now()}@example.test`);
    expect((await ok<any>(w.t.req('GET', '/api/hr/board', { cookie: other.cookie }))).agents).toEqual([]);
    expect((await w.t.req('GET', `/api/agents/${bea.id}/stats`, { cookie: other.cookie })).status).toBe(404);
  });
});

describe('track record projections', () => {
  it('rebuilding from the events reproduces them exactly', async () => {
    const snap = async () => {
      const out: Record<string, string[]> = {};
      for (const t of ['agent_card_stats', 'agent_review_log', 'agent_stats_daily', 'hr_applied']) {
        expect(PROJECTION_TABLES).toContain(t);
        out[t] = (await q(`SELECT to_jsonb(t)::text AS j FROM "${t}" t`)).map((x) => x.j as string).sort();
      }
      return out;
    };
    const before = await snap();
    expect(before.agent_card_stats?.length).toBeGreaterThanOrEqual(6);
    expect(before.agent_review_log).toHaveLength(3);
    await w.t.app.ctx.notifier.flush();
    await rebuildProjections(w.t.app.ctx.pool, w.t.app.ctx.store);
    expect(await snap()).toEqual(before);
  });
});
