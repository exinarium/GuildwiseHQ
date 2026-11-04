import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentView, candidateCards, isCandidate } from '../src/dispatcher/candidates.ts';
import { claim } from '../src/dispatcher/claim.ts';
import { cardWorkability } from '../src/queries/workability.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, markOnline, type World } from './helpers/world.ts';

// A builder is never kept from a card because they worked it before; on rework the builder who worked it last is the
// preferred pick, as a tie-breaker among the eligible builders only.

let w: World;
let minute = 0;

beforeAll(async () => {
  w = await createWorld({ listen: false, env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

async function reset() {
  await q(
    'TRUNCATE cards, card_dependencies, card_handoffs, card_transitions, shifts, threads, thread_messages, agents CASCADE',
  );
  await q('UPDATE projects SET next_card_number = 1');
  await markOnline(w.t, w.workstationId, {
    repoIds: (await q('SELECT id FROM project_repos')).map((r) => r.id),
  });
}

const ctx = () => w.t.app.ctx;
const pass = () => ctx().services.dispatcher.runPass();
const cardRow = async (id: string) => (await q('SELECT * FROM cards WHERE id=$1', [id]))[0]!;
const holder = async (cardId: string) => (await cardRow(cardId)).claimed_by_agent_id as string | null;

/** A builder; `tiers` limits the risk tiers it may take (a junior on small cards only). */
async function builder(name: string, seniority: 'junior' | 'senior', tiers = ['small', 'large']) {
  const a = await w.hire(name, 'builder', seniority, { capacity: 1 });
  await q(
    `UPDATE agents SET permissions = permissions || jsonb_build_object('riskTiers', $2::jsonb) WHERE id=$1`,
    [a.id, JSON.stringify(tiers)],
  );
  return a as { id: string; name: string };
}

/** A build shift of `agentId` on the card, each one later than the one before. */
async function workedBy(cardId: string, agentId: string) {
  minute++;
  await q(
    `INSERT INTO shifts (id, org_id, agent_id, workstation_id, card_id, kind, stage, status, outcome, runtime, model, started_at, ended_at)
     SELECT $1, c.org_id, $3, $4, c.id, 'card', 'build', 'ended', 'reported', 'mock', 'mock',
            now() - interval '1 day' + make_interval(mins => $5), now() - interval '1 day' + make_interval(mins => $5 + 1)
       FROM cards c WHERE c.id = $2`,
    [randomUUID(), cardId, agentId, w.workstationId, minute],
  );
}

/**
 * The card went through review and back to Build (a rebase conflict, which keeps the review-time list): `builders` in
 * the order they worked it, the first is the original builder, the last the last agent; all of them are on the
 * review guard's list.
 */
async function backToBuild(cardId: string, builders: string[], round = builders.length) {
  for (const b of builders) await workedBy(cardId, b);
  await q(
    `UPDATE cards SET stage='build', status='queued', claim_id=NULL, claimed_by_agent_id=NULL, rework_round=$2,
            original_builder_agent_id=$3, last_agent_id=$4, excluded_agent_ids=$5::uuid[]
      WHERE id=$1`,
    [cardId, round, builders[0], builders.at(-1), builders],
  );
}

/** Puts `agentId` ahead of the others in the dispatcher's agent order (it rested longest). */
const restedLongest = (agentId: string) =>
  q(`UPDATE agents SET last_shift_ended_at = now() - interval '30 days' WHERE id=$1`, [agentId]);
const busy = (agentId: string) => q(`UPDATE agents SET last_shift_ended_at = now() WHERE id=$1`, [agentId]);

const viewOf = async (agentId: string) =>
  agentView((await q('SELECT * FROM agents WHERE id=$1', [agentId]))[0]!, []);

describe('a builder who worked a card before', () => {
  it('can claim it again when it comes back for rework (T1)', async () => {
    await reset();
    const ada = await builder('Ada', 'senior');
    const card = await w.card({ title: 'rework me' });
    await backToBuild(card.id, [ada.id]);
    expect(await isCandidate(ctx().pool, await viewOf(ada.id), card.id)).toBe(true);
    const offered = await candidateCards(ctx().pool, await viewOf(ada.id));
    expect(offered.map((c) => c.id)).toContain(card.id);
    expect(offered.find((c) => c.id === card.id)?.prev_builder_id).toBe(ada.id);
    const r = await claim(ctx(), { cardId: card.id, agentId: ada.id, expectedStage: 'build' });
    expect(r).toBeTruthy();
    expect(await holder(card.id)).toBe(ada.id);
  });

  it('is still kept from reviewing their own work at a review stage', async () => {
    await reset();
    const ada = await builder('Ada', 'senior');
    const rev = await w.hire('Rex', 'reviewer', 'senior');
    const card = await w.card({ title: 'review me' });
    await backToBuild(card.id, [ada.id]);
    await q(`UPDATE cards SET stage='review', excluded_agent_ids=ARRAY[$2,$3]::uuid[] WHERE id=$1`, [
      card.id,
      ada.id,
      rev.id,
    ]);
    expect(await isCandidate(ctx().pool, await viewOf(rev.id), card.id)).toBe(false);
    const wk = (await cardWorkability(ctx(), [await cardRow(card.id)])).get(card.id);
    expect(wk?.ok).toBe(false);
    expect(JSON.stringify(wk)).not.toMatch(/excluded/);
    expect(JSON.stringify(wk)).toMatch(/built or already reviewed this card/);
  });
});

describe('the dispatcher prefers the previous builder on rework', () => {
  it('gives the card to its previous builder even when another builder comes first (T3)', async () => {
    await reset();
    const ada = await builder('Ada', 'senior');
    const ben = await builder('Ben', 'senior');
    const card = await w.card({ title: 'X' });
    await backToBuild(card.id, [ada.id]);
    await restedLongest(ben.id);
    await busy(ada.id);
    const made = await pass();
    expect(made.map((m) => m.cardId)).toEqual([card.id]);
    expect(await holder(card.id)).toBe(ada.id);
  });

  it('another builder does not take it first when that builder is the previous builder of a card it cannot take', async () => {
    await reset();
    const ada = await builder('Ada', 'senior');
    const jun = await builder('Jun', 'junior', ['small']);
    const x = await w.card({ title: 'X' });
    const y = await w.card({ title: 'Y' });
    await backToBuild(x.id, [ada.id]);
    // Jun built Y, which is large now: Jun is sorted with the previous builders but cannot take Y
    await backToBuild(y.id, [jun.id]);
    await q(`UPDATE cards SET risk_tier='large' WHERE id=$1`, [y.id]);
    await q(`UPDATE cards SET risk_tier='small' WHERE id=$1`, [x.id]);
    await restedLongest(jun.id);
    await busy(ada.id);
    await pass();
    expect(await holder(x.id)).toBe(ada.id);
    expect(await holder(y.id)).toBeNull(); // Ada was busy with X, Jun may not take a large card
  });

  it('goes to another builder in the same pass when the previous builder is busy (T4)', async () => {
    await reset();
    const ada = await builder('Ada', 'senior');
    const ben = await builder('Ben', 'senior');
    const other = await w.card({ title: 'Ada is on this' });
    const card = await w.card({ title: 'X' });
    await backToBuild(card.id, [ada.id]);
    await claim(ctx(), { cardId: other.id, agentId: ada.id, expectedStage: 'build' });
    expect(await holder(other.id)).toBe(ada.id); // capacity 1: Ada is at her cap
    await pass();
    expect(await holder(card.id)).toBe(ben.id);
  });

  it('goes to another builder in the same pass when the previous builder is paused or retired (T4)', async () => {
    await reset();
    const ada = await builder('Ada', 'senior');
    const ben = await builder('Ben', 'senior');
    const card = await w.card({ title: 'X' });
    await backToBuild(card.id, [ada.id]);
    await q(`UPDATE agents SET paused_at = now() WHERE id=$1`, [ada.id]);
    await pass();
    expect(await holder(card.id)).toBe(ben.id);

    await reset();
    const ada2 = await builder('Ada', 'senior');
    const ben2 = await builder('Ben', 'senior');
    const card2 = await w.card({ title: 'X' });
    await backToBuild(card2.id, [ada2.id]);
    await q(`UPDATE agents SET status = 'retired' WHERE id=$1`, [ada2.id]);
    await pass();
    expect(await holder(card2.id)).toBe(ben2.id);
  });

  it('keeps the seniority rule: a large card a junior worked goes to a senior (T5)', async () => {
    await reset();
    const jun = await builder('Jun', 'junior', ['small']);
    const sen = await builder('Sen', 'senior');
    const card = await w.card({ title: 'big' });
    await backToBuild(card.id, [jun.id]);
    await q(`UPDATE cards SET risk_tier='large' WHERE id=$1`, [card.id]);
    await restedLongest(jun.id);
    expect(await isCandidate(ctx().pool, await viewOf(jun.id), card.id)).toBe(false);
    await pass();
    expect(await holder(card.id)).toBe(sen.id);
  });

  it('prefers the builder who worked it most recently (T7)', async () => {
    await reset();
    const ann = await builder('Ann', 'senior');
    const cal = await builder('Cal', 'senior');
    const card = await w.card({ title: 'X' });
    await backToBuild(card.id, [ann.id, cal.id]); // Ann round 1 (original builder), Cal round 2
    await restedLongest(ann.id);
    await busy(cal.id);
    await pass();
    expect(await holder(card.id)).toBe(cal.id);
  });

  it('a large card after 3 rework rounds whose only free seniors both worked it stays workable (T6, GWP-74)', async () => {
    await reset();
    const ada = await builder('Ada', 'senior');
    const ken = await builder('Ken', 'senior');
    const card = await w.card({ title: 'GWP-74 like' });
    await backToBuild(card.id, [ada.id, ken.id, ada.id, ken.id], 3); // Ken worked the latest round
    await q(`UPDATE cards SET risk_tier='large' WHERE id=$1`, [card.id]);
    await restedLongest(ada.id);
    const wk = (await cardWorkability(ctx(), [await cardRow(card.id)])).get(card.id);
    expect(wk?.ok).toBe(true);
    expect(JSON.stringify(wk)).not.toMatch(/excluded/);
    await pass();
    expect(await holder(card.id)).toBe(ken.id);
  });
});
