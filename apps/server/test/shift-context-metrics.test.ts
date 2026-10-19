import { randomUUID } from 'node:crypto';
import { graphHoldout, uuidv7 } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphArmFor, graphScopeFor } from '../src/commands/graph.ts';
import { graphContextReport } from '../src/costs/graph-context.ts';
import { rebuildProjections } from '../src/projections/rebuild.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { shiftHelpers } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_PROJECT_GRAPHS: 'true', AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  await w.hire('Ben', 'builder', 'junior', { capacity: 4 });
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const ctx = () => w.t.app.ctx;
const hh = () => shiftHelpers(w);
let seen = 0;

async function indexNow(at = ctx().clock.now()) {
  await q(
    `INSERT INTO project_graphs (project_id, repo_id, repo_key, org_id, status, commit_id, indexed_at, updated_at)
     SELECT $1, $2, 'abcabcabcabc', org_id, 'indexed', $3, $4, $4 FROM projects WHERE id=$1
     ON CONFLICT (project_id, repo_id) DO UPDATE SET status='indexed', indexed_at=$4`,
    [w.projectId, w.repoId, 'a'.repeat(40), at],
  );
}

describe('the holdout (design section 11)', () => {
  it('one card in five has no graph inside the window; the assignment is stable per card and independent of the project', async () => {
    const cards = Array.from({ length: 2000 }, () => randomUUID());
    const off = cards.filter(graphHoldout);
    expect(off.length).toBeGreaterThan(300); // about 400
    expect(off.length).toBeLessThan(500);
    for (const c of cards.slice(0, 100)) expect(graphHoldout(c)).toBe(graphHoldout(c));
    await indexNow();
    const probe = cards.find(graphHoldout) as string;
    const keep = cards.find((c) => !graphHoldout(c)) as string;
    expect(await graphArmFor(ctx(), w.projectId, probe)).toBe('off');
    expect(await graphArmFor(ctx(), w.projectId, keep)).toBe('on');
    // chats and anything without a card always have it
    expect(await graphArmFor(ctx(), w.projectId, null)).toBe('on');
    // after the four weeks everybody has it
    ctx().clock.setOffset(29 * 24 * 3600_000);
    try {
      expect(await graphArmFor(ctx(), w.projectId, probe)).toBe('on');
    } finally {
      ctx().clock.setOffset(0);
    }
  });

  it('the scope a shift gets says off for a holdout card, and a project without an index gets no scope at all', async () => {
    const probe = Array.from({ length: 50 }, () => randomUUID()).find(graphHoldout) as string;
    expect(await graphScopeFor(ctx(), w.projectId, probe)).toMatchObject({
      arm: 'off',
      folder: 'projects/toy',
    });
    await q('DELETE FROM project_graphs');
    expect(await graphScopeFor(ctx(), w.projectId, probe)).toBeUndefined();
    await indexNow();
  });
});

/** Runs one shift of a fresh card and ends it with usage and the runner's context counters. */
async function measuredShift(
  context: Record<string, unknown> | undefined,
  usage = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 300 },
) {
  await q(
    `UPDATE cards SET status='cancelled', claim_id=NULL, claimed_by_agent_id=NULL, claim_shift_id=NULL WHERE status NOT IN ('done','cancelled')`,
  );
  await q(`UPDATE shifts SET status='ended' WHERE status <> 'ended'`);
  const card = await w.card({ title: `measured ${++seen}` });
  const start = await hh().dispatchTo(r, 'Ben', r.received.length);
  await hh().startShift(r, start);
  r.ended(start.shiftId, 'stopped', { usage, ...(context ? { context } : {}) });
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
    4000,
    'ended',
  );
  return { shiftId: start.shiftId as string, cardId: card.id as string };
}

describe('ShiftContextMeasured', () => {
  it('a card shift with counters is stored with its billed input tokens (input + cache read + cache write)', async () => {
    const s = await measuredShift({
      graphArm: 'on',
      discoveryBytes: 4000,
      discoveryCalls: 3,
      graphBytes: 900,
      graphCalls: 1,
      briefBytes: 1200,
    });
    const [row] = await q('SELECT * FROM shift_context_metrics WHERE shift_id=$1', [s.shiftId]);
    expect(row).toMatchObject({
      card_id: s.cardId,
      project_id: w.projectId,
      graph_arm: 'on',
      billed_input_tokens: '6300',
      output_tokens: '200',
      discovery_bytes: '4000',
      discovery_calls: 3,
      graph_bytes: '900',
      graph_calls: 1,
      brief_bytes: 1200,
    });
    const ev = (
      await q(`SELECT payload FROM events WHERE type='ShiftContextMeasured' AND payload->>'shiftId'=$1`, [
        s.shiftId,
      ])
    )[0]!.payload;
    expect(Object.keys(ev).sort()).toEqual(
      [
        'billedInputTokens',
        'briefBytes',
        'cardId',
        'discoveryBytes',
        'discoveryCalls',
        'graphArm',
        'graphBytes',
        'graphCalls',
        'orgId',
        'outputTokens',
        'projectId',
        'shiftId',
      ].sort(),
    );
  });

  it('a shift without a graph, or without counters, is not stored', async () => {
    const none = await measuredShift({
      graphArm: 'none',
      discoveryBytes: 1,
      discoveryCalls: 1,
      graphBytes: 0,
      graphCalls: 0,
      briefBytes: 0,
    });
    const old = await measuredShift(undefined);
    expect(
      await q('SELECT 1 FROM shift_context_metrics WHERE shift_id = ANY($1::uuid[])', [
        [none.shiftId, old.shiftId],
      ]),
    ).toEqual([]);
    expect(
      await q(
        `SELECT 1 FROM events WHERE type='ShiftContextMeasured' AND payload->>'shiftId' = ANY($1::text[])`,
        [[old.shiftId]],
      ),
    ).toEqual([]);
  });

  it('a projection rebuild reproduces the rows', async () => {
    const before = await q('SELECT * FROM shift_context_metrics ORDER BY shift_id');
    expect(before.length).toBeGreaterThan(0);
    await rebuildProjections(ctx().pool, ctx().store);
    expect(await q('SELECT * FROM shift_context_metrics ORDER BY shift_id')).toEqual(before);
  });
});

describe('the report: arms, ratio, guards and the claim rule', () => {
  /** Finished cards with a measured shift each: real cards (the API fills every column), marked done by hand. */
  async function seedCards(
    arm: 'on' | 'off',
    n: number,
    tokens: (i: number) => number,
    over: { rework?: number } = {},
  ) {
    for (let i = 0; i < n; i++) {
      const card = await w.card({ title: 'seed' });
      const base = ctx().clock.now();
      await q(
        `UPDATE cards SET status='done', stage='done', claim_id=NULL, claimed_by_agent_id=NULL, claim_shift_id=NULL,
                rework_round=$2, created_at=$3, finalized_at=$4 WHERE id=$1`,
        [card.id, over.rework ?? 0, new Date(base.getTime() - 86_400_000), base],
      );
      await q(
        `INSERT INTO shift_context_metrics (shift_id, org_id, project_id, card_id, graph_arm, billed_input_tokens, measured_at)
         SELECT $1, org_id, $2, $3, $4, $5, $6 FROM projects WHERE id=$2`,
        [uuidv7(), w.projectId, card.id, arm, tokens(i), base],
      );
    }
  }

  it('says nothing until both arms have ten finished cards', async () => {
    await indexNow(); // the rebuild above emptied the projection: index state is a projection of events, not of this test's rows
    await q('DELETE FROM shift_context_metrics');
    const rep = await graphContextReport(ctx().pool, await orgId(), null, ctx().clock.now());
    expect(rep.claim).toMatchObject({ allowed: false, reason: 'not_enough_cards' });
    expect(rep.evaluating).toBe(true);
  });

  it('offers the saving only when the whole interval is below one and no quality guard is worse', async () => {
    await q('DELETE FROM shift_context_metrics');
    // the graph arm used about 30% fewer tokens, with a little spread
    await seedCards('on', 14, (i) => 70_000 + (i % 5) * 1500);
    await seedCards('off', 14, (i) => 100_000 + (i % 5) * 1500);
    const rep = await graphContextReport(ctx().pool, await orgId(), null, ctx().clock.now());
    expect(rep.on.cards).toBe(14);
    expect(rep.off.cards).toBe(14);
    expect(rep.interval?.ratio).toBeCloseTo(0.7, 1);
    expect(rep.interval!.hi).toBeLessThan(1);
    expect(rep.claim).toMatchObject({ allowed: true, reason: 'ok' });
    expect(rep.claim.savingPercent).toBeGreaterThanOrEqual(25);
    // the same data over a second request gives the same interval (the seed is the organization, not the clock)
    const again = await graphContextReport(ctx().pool, await orgId(), null, ctx().clock.now());
    expect(again.interval).toEqual(rep.interval);
  });

  it('a quality guard that is worse in the graph arm withholds the claim', async () => {
    await q('DELETE FROM shift_context_metrics');
    await seedCards('on', 12, () => 60_000, { rework: 2 });
    await seedCards('off', 12, () => 100_000, { rework: 0 });
    const rep = await graphContextReport(ctx().pool, await orgId(), null, ctx().clock.now());
    expect(rep.claim).toMatchObject({ allowed: false, reason: 'guard_worse' });
    expect(rep.claim.worseGuards).toContain('reworkRounds');
  });

  it('is available to the Owner over the API and refused to a Member', async () => {
    const res = await ok<any>(w.t.req('GET', '/api/value/graph', { cookie: w.owner.cookie }));
    expect(res).toHaveProperty('claim');
    const member = await w.t.userSession('graph-member@example.test');
    await w.t.addOrgMember(await orgId(), member.id, 'member');
    const res2 = await w.t.req('GET', '/api/value/graph', {
      cookie: member.cookie,
      headers: { 'x-aom-org': await orgId() },
    });
    expect(res2.status).toBe(403);
  });
});

async function orgId(): Promise<string> {
  return (await q('SELECT org_id FROM projects WHERE id=$1', [w.projectId]))[0]!.org_id;
}
