import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { approveWith, bounce, diffWithTests, handoff } from './helpers/hr.ts';
import { cardRow, pipeline, testFail, testPass } from './helpers/pipeline.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

// Manager dashboard metrics against a seeded event fixture with hand-computed values.
let w: World;
let r: FakeRunner;
let metricsUrl = '';
const HOUR = 3_600_000;

beforeAll(async () => {
  w = await createWorld();
  r = await w.connectRunner();
  const p = pipeline(w, r);
  await w.hire('Bea', 'builder', 'junior');
  await w.hire('Rex', 'reviewer', 'senior');
  await w.hire('Tess', 'tester', 'junior');

  // A: bounced once, passes test and is finalized.
  const a = await w.card({ title: 'A' });
  await p.run('Bea', handoff(), diffWithTests(1));
  await p.run('Rex', bounce(2, ['weak_tests'], ['c1']));
  await p.run('Bea', handoff(), diffWithTests(1));
  await p.run('Rex', approveWith(4));
  await p.run('Tess', testPass());
  const from = r.received.length;
  await ok(w.t.req('POST', `/api/cards/${a.id}/finalize`, { cookie: w.owner.cookie, body: {} }));
  const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 5000, from);
  r.send('command.result', {
    commandId: cmd.commandId,
    ok: true,
    result: { ok: true, action: 'merge', mergeCommit: 'abc' },
  });
  await until(async () => (await cardRow(a.id)).status === 'done', 3000, 'finalized');
  await p.run('Tess', testPass('suite green')); // the full E2E suite the finalize spawned
  // B: fails test once (a bug card goes back to Bea) and ends waiting at Finalize.
  await w.card({ title: 'B' });
  await p.run('Bea', handoff(), diffWithTests(0));
  await p.run('Rex', approveWith(5));
  await p.run('Tess', testFail('Bug in B'));
  await p.run('Bea', handoff());
  await p.run('Rex', approveWith(4));
  await p.run('Tess', testPass());
  // C waits in To do. E: Bea asks a blocking question; the manager answers two hours later.
  await w.card({ title: 'C' });
  await w.card({ title: 'E', fields: fullFields() });
  const e = await p.next('Bea');
  await p.startShift(r, e);
  await p.report(r, e.shiftId, {
    kind: 'question',
    text: 'Which port?',
    options: [],
    doing: 'x',
    blocking: true,
  });
  r.ended(e.shiftId, 'reported');
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [e.shiftId, 'ended']))[0],
    3000,
    'question shift ended',
  );
  w.t.clock.advance(2 * HOUR);
  const cookie = await w.t.login(w.owner.email);
  const item = (await q(`SELECT id FROM desk_items WHERE kind='question'`))[0]!;
  await ok(
    w.t.req('POST', `/api/desk/${item.id}/answer`, {
      cookie,
      body: { answer: 'Port 4600.', ledger: { scope: 'decision' } },
    }),
  );
  w.owner.cookie = cookie;
  metricsUrl = `/api/metrics?projectId=${w.projectId}`;
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const get = (qs = metricsUrl) => ok<any>(w.t.req('GET', qs, { cookie: w.owner.cookie }));

describe('dashboard metrics', () => {
  it('throughput counts the finalized cards per day, every day of the range present', async () => {
    const m = await get();
    expect(m.projectId).toBe(w.projectId);
    expect(m.throughput.length).toBeGreaterThanOrEqual(30);
    // A, and B's bug card once its fix passed review. The suite card spawned by the finalize is not work.
    expect(m.throughput.reduce((s: number, d: any) => s + d.count, 0)).toBe(2);
  });

  it('time blocked on the manager is the span a card sat in Blocked', async () => {
    const m = await get();
    expect(m.timeBlockedOnManager.cards).toBe(1);
    expect(m.timeBlockedOnManager.totalMs).toBeGreaterThanOrEqual(2 * HOUR);
    expect(m.timeBlockedOnManager.totalMs).toBeLessThan(2 * HOUR + 10_000);
    expect(m.timeBlockedOnManager.avgMsPerCard).toBe(m.timeBlockedOnManager.totalMs);
  });

  it('bounce rate per builder covers review bounces and test failures over the submitted cards', async () => {
    const m = await get();
    // Bea submitted A, B and the bug card B2; A bounced in review, B failed test: 2 of 3 cards.
    expect(m.bounceRate).toEqual([
      {
        agentId: expect.any(String),
        name: 'Bea',
        submitted: 3,
        reviewBounces: 1,
        testFailures: 1,
        rate: expect.closeTo(2 / 3, 3),
      },
    ]);
  });

  it('bugs escaped past test, by day', async () => {
    const m = await get();
    expect(m.bugsEscaped.total).toBe(1);
    expect(m.bugsEscaped.byDay.reduce((s: number, d: any) => s + d.count, 0)).toBe(1);
  });

  it('duration per card and per agent', async () => {
    const m = await get();
    expect(m.duration.cards).toBe(2);
    expect(m.duration.avgMsPerCard).toBeGreaterThan(0);
    expect(m.duration.medianMsPerCard).toBeGreaterThan(0);
    // One-second shifts: Bea A, A, B, B2 and the question shift; Rex A, A, B, B2; Tess A, the suite, B fail, B pass.
    expect(m.duration.perAgent).toEqual([
      { agentId: expect.any(String), name: 'Bea', shifts: 5, totalMs: 5000, avgMsPerShift: 1000 },
      { agentId: expect.any(String), name: 'Rex', shifts: 4, totalMs: 4000, avgMsPerShift: 1000 },
      { agentId: expect.any(String), name: 'Tess', shifts: 4, totalMs: 4000, avgMsPerShift: 1000 },
    ]);
  });

  it('queue depth per board column right now', async () => {
    const m = await get();
    // C and the answered E wait in To do, B waits at Finalize; A and its suite are done.
    expect(m.queueDepth).toEqual([
      { column: 'To do', count: 2 },
      { column: 'Finalize', count: 1 },
    ]);
  });

  it('respects the visible projects and the date range', async () => {
    const all = await get('/api/metrics');
    expect(all.projectId).toBeNull();
    expect(all.bugsEscaped.total).toBe(1);
    const other = await w.t.userSession(`m-other-${Date.now()}@example.test`);
    const none = await ok<any>(w.t.req('GET', '/api/metrics', { cookie: other.cookie }));
    expect(none.bugsEscaped.total).toBe(0);
    expect(none.queueDepth).toEqual([]);
    expect((await w.t.req('GET', metricsUrl, { cookie: other.cookie })).status).toBe(404);
    const past = await get(`${metricsUrl}&from=2020-01-01T00:00:00.000Z&to=2020-01-08T00:00:00.000Z`);
    expect(past.throughput).toHaveLength(7);
    expect(past.bugsEscaped.total).toBe(0);
    expect(past.timeBlockedOnManager).toEqual({ totalMs: 0, cards: 0, avgMsPerCard: null });
    expect(past.bounceRate).toEqual([]);
  });
});
