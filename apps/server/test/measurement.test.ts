import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultMigrationsDir } from '../src/db/migrate.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { approve, DIFF_SMALL, handoff, pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

// Lean Team v3 (S1b), section 9 and section 11 "Measurement": an accepted report is never labelled stopped, a crashed
// shift's usage is recorded when the runner sends it, the rejection reason is on the shift, cost by cause.

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

const shiftRow = async (id: string) => (await q('SELECT * FROM shifts WHERE id=$1', [id]))[0]!;
const ended = (id: string) =>
  until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [id, 'ended']))[0],
    3000,
    'ended',
  );
const owner = (url: string) => ok<any>(w.t.req('GET', url, { cookie: w.owner.cookie }));

describe('what a shift ended as', () => {
  it('a shift whose report was accepted and that was then stopped ended as reported, with its usage', async () => {
    await freshState();
    await w.hire('Bea', 'builder', 'junior');
    await w.card({ title: 'Reports then stops' });
    const start = await p.next('Bea');
    await p.startShift(r, start);
    const res = (await p.report(r, start.shiftId, handoff(), DIFF_SMALL)) as any;
    expect(res.accepted).toBe(true);
    r.ended(start.shiftId, 'stopped');
    await ended(start.shiftId);
    const s = await shiftRow(start.shiftId);
    expect(s).toMatchObject({ outcome: 'reported', report_outcome: 'handoff' });
    expect(Number(s.tokens_input)).toBe(1000);
  });

  it('a shift stopped without a report stays stopped', async () => {
    await freshState();
    await w.hire('Bea', 'builder', 'junior');
    await w.card({ title: 'Stopped for real' });
    const start = await p.next('Bea');
    await p.startShift(r, start);
    r.ended(start.shiftId, 'stopped');
    await ended(start.shiftId);
    expect((await shiftRow(start.shiftId)).outcome).toBe('stopped');
  });

  it('the history is repaired by the migration, with the same rule as the projection', async () => {
    const sql = await readFile(join(defaultMigrationsDir(), '2125_relabel_reported.sql'), 'utf8');
    const orgId = w.owner.id;
    const agent = (await q('SELECT id FROM agents LIMIT 1'))[0]!;
    const id = crypto.randomUUID();
    await q(
      `INSERT INTO shifts (id, org_id, agent_id, workstation_id, kind, stage, status, outcome, report_outcome, runtime, model, overflow, started_at, ended_at)
       VALUES ($1,$2,$3,$4,'card','build','ended','stopped','handoff','mock','mock',false,now(),now())`,
      [id, orgId, agent.id, w.workstationId],
    );
    await q(sql);
    expect((await shiftRow(id)).outcome).toBe('reported');
  });
});

describe('usage of a shift the server had already ended', () => {
  it('a crashed shift priced at zero gets its tokens and price when the runner reports them', async () => {
    await freshState();
    await w.hire('Bea', 'builder', 'junior', { model: 'claude-sonnet-5-5' });
    await w.card({ title: 'Crashes' });
    const start = await p.next('Bea');
    await p.startShift(r, start);
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    r.ended(start.shiftId, 'crashed', { usage: zero });
    await ended(start.shiftId);
    expect(await q('SELECT cost_usd_micros FROM shift_costs WHERE shift_id=$1', [start.shiftId])).toEqual([
      { cost_usd_micros: '0' },
    ]);
    // the runner's late, fuller report (the same message again, now with what it read from the transcript)
    r.ended(start.shiftId, 'crashed', {
      usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await until(
      async () => Number((await shiftRow(start.shiftId)).tokens_input) === 1_000_000,
      3000,
      'usage recorded',
    );
    const cost = (
      await q('SELECT cost_usd_micros, tokens_output FROM shift_costs WHERE shift_id=$1', [start.shiftId])
    )[0]!;
    // Sonnet: 1M input x $2 + 100K output x $10 = $3
    expect(Number(cost.cost_usd_micros)).toBe(3_000_000);
    expect(Number(cost.tokens_output)).toBe(100_000);
    // recorded once: a third message changes nothing
    r.ended(start.shiftId, 'crashed', {
      usage: { inputTokens: 5_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    });
    await r.barrier();
    expect(Number((await shiftRow(start.shiftId)).tokens_input)).toBe(1_000_000);
  });
});

describe('cost by cause', () => {
  it('splits a card by working, asking and reviewing, and an organization by day', async () => {
    await freshState();
    await q('TRUNCATE shift_costs');
    await w.hire('Bea', 'builder', 'junior', { model: 'claude-sonnet-5-5' });
    await w.hire('Rex', 'reviewer', 'senior', { model: 'claude-sonnet-5-5' });
    // asking: a shift that ends with a blocking question
    const asked = await w.card({ title: 'Asking card' });
    const q1 = await p.next('Bea');
    await p.startShift(r, q1);
    await p.report(r, q1.shiftId, {
      kind: 'question',
      text: 'Which database?',
      options: [],
      doing: 'x',
      blocking: true,
    });
    r.ended(q1.shiftId, 'reported');
    await ended(q1.shiftId);
    const card = await w.card({ title: 'Costly card' });
    // working: build, then reviewing
    const b = await p.run('Bea', handoff(), DIFF_SMALL);
    const rv = await p.run('Rex', approve());
    const price = async (shiftId: string, micros: number) =>
      q('UPDATE shift_costs SET cost_usd_micros=$2 WHERE shift_id=$1', [shiftId, micros]);
    await price(q1.shiftId, 1_000_000);
    await price(b.start.shiftId, 3_000_000);
    await price(rv.start.shiftId, 2_000_000);

    const a = await owner(`/api/cards/${asked.id}/cost-causes`);
    expect(a.total.asking).toMatchObject({ costMicros: 1_000_000, shifts: 1 });
    const c = await owner(`/api/cards/${card.id}/cost-causes`);
    expect(c.total.asking.shifts).toBe(0);
    expect(c.total.working).toMatchObject({ costMicros: 3_000_000, shifts: 1 });
    expect(c.total.reviewing).toMatchObject({ costMicros: 2_000_000, shifts: 1 });
    expect(c.total.re_review_after_conflict.shifts).toBe(0);
    expect(c.totalMicros).toBe(5_000_000);

    // a conflict before a later review makes that review a re-review after the conflict
    await q(
      `INSERT INTO events (stream_id, stream_version, type, payload, actor_kind, org_id, audience, created_at)
       VALUES ($1, 9000, 'RebaseConflict', '{}', 'system', $2, 'org', now() - interval '1 hour')`,
      [`card-${card.id}`, w.owner.id],
    );
    const again = await owner(`/api/cards/${card.id}/cost-causes`);
    expect(again.total.reviewing.shifts).toBe(0);
    expect(again.total.re_review_after_conflict).toMatchObject({ costMicros: 2_000_000, shifts: 1 });

    const day = await owner('/api/costs/causes');
    const total = day.days.reduce((n: number, d: any) => n + d.causes.working.costMicros, 0);
    expect(total).toBe(3_000_000);
    expect(day.total.reviewing.costMicros + day.total.re_review_after_conflict.costMicros).toBe(2_000_000);
  });

  it('the board card shows what the card has cost', async () => {
    const board = await owner(`/api/board?projectId=${w.projectId}`);
    const cards = board.columns.flatMap((col: any) => col.cards);
    const costly = cards.find((x: any) => x.title === 'Costly card');
    expect(costly.spend.totalMicros).toBe(5_000_000);
    expect(costly.spend.currency).toBe('USD');
  });
});
