import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import {
  approveWith,
  board,
  bounce,
  DIFF_LARGE,
  DIFF_SMALL,
  handoff,
  kindsOf,
  recommendations,
  resetHr,
} from './helpers/hr.ts';
import { pipeline } from './helpers/pipeline.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

// Each rule fires on its fixture and not on a control fixture (docs/PLAN.md M9 AC). Fixtures are real event logs: cards
// go through the dispatcher and a fake runner, so the track record is built by the projectors from the events.
let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld();
  r = await w.connectRunner();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const RICH = {
  requirements: 'A requirements text that is long enough to be a real spec and not a thin one.',
  acceptanceCriteria: ['first criterion', 'second criterion'],
};
const sizeOf = (large: boolean) => (large ? DIFF_LARGE : DIFF_SMALL);
const recOf = async (kind: string, cookie = w.owner.cookie) =>
  (await recommendations(w, cookie)).find((x) => x.kind === kind);
const agentRow = async (name: string) => (await q('SELECT * FROM agents WHERE name=$1', [name]))[0]!;

/** Bea takes a fresh card and asks a blocking question about it. */
async function ask(text: string, fields: Record<string, unknown> = RICH) {
  const card = await w.card({ title: text.slice(0, 40), fields: fullFields(fields) });
  const start = await p.next('Bea');
  await p.startShift(r, start);
  const res = (await p.report(r, start.shiftId, {
    kind: 'question',
    text,
    options: [],
    doing: 'working',
    blocking: true,
  })) as any;
  expect(res.accepted).toBe(true);
  r.ended(start.shiftId, 'reported');
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
    3000,
    'question shift ended',
  );
  return card;
}

/** Bea builds a card (small or large) and Rex either approves it once or bounces it and approves the rework. */
async function build(opts: { large?: boolean; bounceWith?: ReturnType<typeof bounce>; score?: number } = {}) {
  const card = await w.card({
    title: `Card ${Math.random().toString(36).slice(2, 6)}`,
    fields: fullFields(RICH),
  });
  await p.run('Bea', handoff(), sizeOf(!!opts.large));
  if (opts.bounceWith) {
    await p.run('Rex', opts.bounceWith);
    await p.run('Bea', handoff(), sizeOf(!!opts.large));
  }
  await p.run('Rex', approveWith(opts.score ?? 4));
  return card;
}

async function team(model = 'sonnet') {
  await w.hire('Bea', 'builder', 'junior', { model });
  await w.hire('Rex', 'reviewer', 'senior');
}

describe('blocked', () => {
  it('thin specs behind the questions are blamed on the spec author, not the builder', async () => {
    await resetHr();
    await team();
    // The default test spec is thin (one criterion, "reqs"). Three distinct topics, so no standing order applies.
    await ask('Should invoices round totals?', {});
    await ask('Which timezone do reports use?', {});
    await ask('Where do avatars live?', {});
    const recs = await recommendations(w);
    expect(kindsOf(recs)).toEqual(['blocked_thin_specs']);
    const thin = recs[0];
    expect(thin).toMatchObject({ agentId: null, roleKey: 'ba', canApply: true });
    expect(thin.action.type).toBe('standing_order');
    expect(thin.evidence.metrics[0].value).toBe('3 of 3');
    expect(thin.evidence.items).toHaveLength(3);
  });

  it('questions clustering on one topic propose a standing order with the last answer', async () => {
    await resetHr();
    await team();
    const c1 = await ask('What naming should the orders schema use?');
    await ask('Should the billing schema keep audit columns?');
    await ask('Which schema holds the reporting views?');
    // The manager answered one of them: the proposal reuses the answer.
    const d = (await q(`SELECT id FROM desk_items WHERE card_id=$1`, [c1.id]))[0]!;
    await ok(
      w.t.req('POST', `/api/desk/${d.id}/answer`, {
        cookie: w.owner.cookie,
        body: { answer: 'Use snake_case table names in every schema.', ledger: { scope: 'decision' } },
      }),
    );
    const recs = await recommendations(w);
    expect(kindsOf(recs)).toEqual(['blocked_topic']);
    expect(recs[0].action).toMatchObject({
      type: 'standing_order',
      topic: 'schema',
      text: expect.stringContaining('snake_case'),
    });
    expect(recs[0].evidence.items.length).toBe(3);
  });

  it('questions the ledger already answered mean ledger search is failing', async () => {
    await resetHr();
    await team();
    await ok(
      w.t.req('POST', '/api/ledger', {
        cookie: w.owner.cookie,
        body: {
          scope: 'decision',
          projectId: w.projectId,
          title: 'Invoice totals round to cents',
          body: 'All invoice totals round to cents with banker rounding.',
        },
      }),
      201,
    );
    await ask('Should invoice totals round to cents?');
    await ask('Do invoice totals round to cents or euros?');
    await ask('How do invoice totals round, to cents?');
    const recs = await recommendations(w);
    expect(kindsOf(recs).filter((k) => k.startsWith('blocked'))).toContain('blocked_ledger');
    const rec = recs.find((x) => x.kind === 'blocked_ledger');
    expect(rec.summary).toMatch(/3 of 3 questions/);
    expect(rec.action).toMatchObject({ type: 'standing_order', topic: 'ledger search' });
  });

  it('control: one question in three cards is under the blocked rate, and a lone card is under the minimum', async () => {
    await resetHr();
    await team();
    await ask('Where do the avatars live in storage?');
    await build();
    await build();
    expect((await recommendations(w)).filter((x) => x.kind.startsWith('blocked'))).toEqual([]);
  });
});

describe('rework', () => {
  it('a recurring review reason becomes a proposed standing order; applying it puts an approval on the desk', async () => {
    await resetHr();
    await team();
    for (let i = 0; i < 3; i++) await build({ bounceWith: bounce(2, ['weak_tests']) });
    const rec = await recOf('rework_reason');
    expect(rec).toMatchObject({ id: expect.stringMatching(/^rework_reason:.+:weak_tests$/), canApply: true });
    expect(rec.action).toMatchObject({ type: 'standing_order', topic: 'No or weak tests' });
    expect(rec.evidence.metrics.map((m: any) => m.label)).toEqual(['Rework rate', 'No or weak tests']);
    expect(rec.evidence.metrics[0].value).toBe('100% (3 of 3 cards)');
    expect(rec.evidence.items).toHaveLength(3);
    expect(rec.evidence.items[0].ref).toMatch(/^TOY-/);

    const applied = await ok<any>(
      w.t.req('POST', `/api/hr/recommendations/${rec.id}/apply`, { cookie: w.owner.cookie }),
    );
    expect(applied).toMatchObject({ applied: true, deskItemId: expect.any(String) });
    const item = (await q('SELECT * FROM desk_items WHERE id=$1', [applied.deskItemId]))[0]!;
    expect(item).toMatchObject({
      kind: 'approval',
      subkind: 'standing_order',
      status: 'open',
      project_id: null,
    });
    expect(item.body).toContain('tests');
    // It is no longer suggested, and approving it writes the org-wide standing order into the ledger.
    expect(await recOf('rework_reason')).toBeUndefined();
    await ok(
      w.t.req('POST', `/api/desk/${item.id}/resolve`, {
        cookie: w.owner.cookie,
        body: { resolution: 'approved', editedBody: 'Always ship tests with the code.' },
      }),
    );
    await until(
      async () =>
        (await q(`SELECT 1 FROM ledger_entries WHERE scope='standing_order' AND tags @> ARRAY['hr']`))[0],
      3000,
      'standing order in the ledger',
    );
    const entry = (await q(`SELECT * FROM ledger_entries WHERE scope='standing_order'`))[0]!;
    expect(entry).toMatchObject({ project_id: null, body: 'Always ship tests with the code.' });
    expect(
      (await q(`SELECT payload FROM events WHERE type='RecommendationApplied'`)).map((e) => e.payload.kind),
    ).toEqual(['rework_reason']);
  });

  it('spec unclear does not count against the builder, so it proposes nothing for them', async () => {
    await resetHr();
    await team();
    for (let i = 0; i < 3; i++) await build({ bounceWith: bounce(3, ['spec_unclear']) });
    expect(await recOf('rework_reason')).toBeUndefined();
    const b = await board(w);
    const bea = b.agents.find((a: any) => a.agent.name === 'Bea');
    expect(bea.stats.reworkRate.value).toBe(0);
    expect(bea.quality.reworkByReason).toEqual([
      { reason: 'spec_unclear', count: 3, countsAgainstBuilder: false },
    ]);
  });

  it('control: two bounces for the same reason are not yet a pattern', async () => {
    await resetHr();
    await team();
    for (let i = 0; i < 2; i++) await build({ bounceWith: bounce(2, ['weak_tests']) });
    await build();
    expect(await recOf('rework_reason')).toBeUndefined();
  });
});

describe('model up and down', () => {
  it('model up: high rework on large cards, applied as an AgentChanged event', async () => {
    await resetHr();
    await team('sonnet');
    for (let i = 0; i < 2; i++) await build({ large: true, bounceWith: bounce(2) });
    const rec = await recOf('model_up');
    expect(rec).toMatchObject({
      canApply: true,
      action: { type: 'change_model', model: 'opus', fromModel: 'sonnet' },
    });
    expect(rec.evidence.metrics.find((m: any) => m.label === 'Rework rate on large cards').value).toBe(
      '100%',
    );
    const bea = await agentRow('Bea');
    const applied = await ok<any>(
      w.t.req('POST', `/api/hr/recommendations/${rec.id}/apply`, { cookie: w.owner.cookie }),
    );
    expect(applied.agentIds).toEqual([bea.id]);
    expect((await agentRow('Bea')).model).toBe('opus');
    const ev = (
      await q(
        `SELECT payload FROM events WHERE type='AgentChanged' AND payload->>'agentId'=$1 ORDER BY seq DESC`,
        [bea.id],
      )
    )[0]!;
    expect(ev.payload.changes).toEqual({ model: 'opus' });
    expect(await recOf('model_up')).toBeUndefined();
    // Applying twice is refused: the recommendation is gone.
    expect(
      (await w.t.req('POST', `/api/hr/recommendations/${rec.id}/apply`, { cookie: w.owner.cookie })).status,
    ).toBe(404);
  });

  it('control: large cards that pass first time do not ask for a stronger model', async () => {
    await resetHr();
    await team('sonnet');
    for (let i = 0; i < 2; i++) await build({ large: true });
    expect(await recOf('model_up')).toBeUndefined();
  });

  it('model down: small, clean work on a strong model', async () => {
    await resetHr();
    await team('opus');
    for (let i = 0; i < 4; i++) await build();
    const rec = await recOf('model_down');
    expect(rec).toMatchObject({ action: { type: 'change_model', model: 'sonnet', fromModel: 'opus' } });
    expect(rec.evidence.metrics.find((m: any) => m.label === 'Small cards').value).toBe('4 of 4');
    await ok(w.t.req('POST', `/api/hr/recommendations/${rec.id}/apply`, { cookie: w.owner.cookie }));
    expect((await agentRow('Bea')).model).toBe('sonnet');
  });

  it('a reviewer never gets an applicable model-down: it is advice for the owner (backlog #70)', async () => {
    await resetHr();
    await team('opus');
    for (let i = 0; i < 4; i++) await build();
    await q(`UPDATE agents SET role_key='reviewer' WHERE name='Bea'`);
    const rec = await recOf('model_down');
    expect(rec).toMatchObject({ action: { type: 'none' }, canApply: false });
    expect(rec.summary).toContain('reviewers run at high effort');
    expect((await agentRow('Bea')).model).toBe('opus');
  });

  it('control: one bounce in four cards, or the lightest model, gives no model-down advice', async () => {
    await resetHr();
    await team('opus');
    await build({ bounceWith: bounce(2) });
    for (let i = 0; i < 3; i++) await build();
    expect(await recOf('model_down')).toBeUndefined();
    await resetHr();
    await team('haiku');
    for (let i = 0; i < 4; i++) await build();
    expect(await recOf('model_down')).toBeUndefined();
  });
});

describe('split the role', () => {
  it('a wide mix of small and large cards: a strong senior for large, a light junior for small', async () => {
    await resetHr();
    await team('sonnet');
    for (let i = 0; i < 3; i++) await build();
    for (let i = 0; i < 3; i++) await build({ large: true });
    const rec = await recOf('split_role');
    expect(rec.action).toMatchObject({
      type: 'split_role',
      seniorModel: 'opus',
      juniorModel: 'haiku',
      roleKey: 'builder',
    });
    const before = await q(`SELECT 1 FROM agents WHERE role_key='builder'`);
    const applied = await ok<any>(
      w.t.req('POST', `/api/hr/recommendations/${rec.id}/apply`, { cookie: w.owner.cookie }),
    );
    expect(applied.agentIds).toHaveLength(2);
    const builders = await q(
      `SELECT name, model, seniority, permissions FROM agents WHERE role_key='builder' ORDER BY hired_at`,
    );
    expect(builders).toHaveLength(before.length + 1);
    expect(builders[0]).toMatchObject({ name: 'Bea', model: 'opus', seniority: 'senior' });
    expect(builders[0]!.permissions.riskTiers).toEqual(['large']);
    expect(builders[1]).toMatchObject({ name: rec.action.juniorName, model: 'haiku' });
    expect(builders[1]!.permissions.riskTiers).toEqual(['small']);
    expect(await recOf('split_role')).toBeUndefined();
  });

  it('control: only small cards need no split', async () => {
    await resetHr();
    await team('sonnet');
    for (let i = 0; i < 6; i++) await build();
    expect(await recOf('split_role')).toBeUndefined();
  });
});

describe('fire or reassign', () => {
  it('low review scores on large and small cards alike suggest firing and hiring a fresh profile', async () => {
    await resetHr();
    await team('sonnet');
    const c = await w.card({ title: 'Struggle', fields: fullFields(RICH) });
    await p.run('Bea', handoff(), DIFF_LARGE);
    await p.run('Rex', bounce(1, ['poor_structure']));
    await p.run('Bea', handoff(), DIFF_SMALL);
    await p.run('Rex', bounce(1, ['poor_structure']));
    await p.run('Bea', handoff(), DIFF_SMALL);
    await p.run('Rex', bounce(2, ['poor_structure']));
    const rec = await recOf('fire_quality');
    expect(rec.action.type).toBe('fire');
    expect(rec.summary).toMatch(/fresh profile/);
    expect(rec.evidence.items).toHaveLength(3);
    const applied = await ok<any>(
      w.t.req('POST', `/api/hr/recommendations/${rec.id}/apply`, { cookie: w.owner.cookie }),
    );
    expect(applied.effect).toMatch(/let go/);
    expect((await agentRow('Bea')).status).toBe('retired');
    expect((await q(`SELECT claim_id FROM cards WHERE id=$1`, [c.id]))[0]!.claim_id).toBeNull();
    expect(await q(`SELECT 1 FROM events WHERE type='AgentRetired'`)).toHaveLength(1);
  });

  it('control: good scores on both sizes, or only one size, are not a firing matter', async () => {
    await resetHr();
    await team('sonnet');
    await w.card({ title: 'Fine', fields: fullFields(RICH) });
    await p.run('Bea', handoff(), DIFF_LARGE);
    await p.run('Rex', bounce(4, ['poor_structure']));
    await p.run('Bea', handoff(), DIFF_SMALL);
    await p.run('Rex', bounce(4, ['poor_structure']));
    await p.run('Bea', handoff(), DIFF_SMALL);
    await p.run('Rex', bounce(4, ['poor_structure']));
    expect(await recOf('fire_quality')).toBeUndefined();
    await resetHr();
    await team('sonnet');
    await w.card({ title: 'Small only', fields: fullFields(RICH) });
    for (let i = 0; i < 3; i++) {
      await p.run('Bea', handoff(), DIFF_SMALL);
      await p.run('Rex', bounce(1, ['poor_structure']));
    }
    expect(await recOf('fire_quality')).toBeUndefined();
  });

  it('a reviewer who bounces nearly every card shows up on its own card, as advice', async () => {
    await resetHr();
    await team('sonnet');
    await w.card({ title: 'Never good enough', fields: fullFields(RICH) });
    for (let i = 0; i < 4; i++) {
      await p.run('Bea', handoff(), DIFF_SMALL);
      await p.run('Rex', bounce(3, ['broke_convention']));
    }
    const rec = await recOf('reviewer_strict');
    const rex = await agentRow('Rex');
    expect(rec).toMatchObject({ agentId: rex.id, action: { type: 'none' }, canApply: false });
    expect(rec.evidence.metrics[0].value).toBe('100% (4 of 4)');
    expect(
      (await w.t.req('POST', `/api/hr/recommendations/${rec.id}/apply`, { cookie: w.owner.cookie })).status,
    ).toBe(400);
  });

  it('control: a reviewer who approves half of the cards is not strict', async () => {
    await resetHr();
    await team('sonnet');
    await w.card({ title: 'Mixed', fields: fullFields(RICH) });
    for (let i = 0; i < 2; i++) {
      await p.run('Bea', handoff(), DIFF_SMALL);
      await p.run('Rex', bounce(3, ['broke_convention']));
    }
    await build();
    await build();
    expect(await recOf('reviewer_strict')).toBeUndefined();
  });
});

describe('fire or reassign: idle agents', () => {
  const idleTeam = async () => {
    await resetHr();
    await w.hire('Ada', 'builder', 'junior', { model: 'sonnet' });
    await w.hire('Bo', 'builder', 'junior', { model: 'sonnet' });
  };
  /** Sessions expire with the moved clock: log in again after advancing it. */
  const later = async (days: number) => {
    w.t.clock.advance(days * 86_400_000);
    return w.t.login(w.owner.email);
  };

  it('sustained low utilisation in a role with an empty queue suggests firing one', async () => {
    await idleTeam();
    const cookie = await later(10);
    const recs = await recommendations(w, cookie);
    expect(kindsOf(recs)).toEqual(['fire_idle', 'fire_idle']);
    expect(recs[0].evidence.metrics.map((m: any) => m.label)).toEqual([
      'Utilisation',
      'Queue for the role',
      'Other agents in the role',
    ]);
    const applied = await ok<any>(w.t.req('POST', `/api/hr/recommendations/${recs[0].id}/apply`, { cookie }));
    expect(applied.agentIds).toHaveLength(1);
    expect((await q(`SELECT 1 FROM agents WHERE status='retired' AND role_key='builder'`)).length).toBe(1);
    // Down to one builder: nobody to reassign the work to, so it is not suggested again.
    expect(kindsOf(await recommendations(w, cookie))).toEqual([]);
    w.t.clock.setOffset(0);
  });

  it('control: a young team, or work waiting in the queue, is not idle', async () => {
    await idleTeam();
    let cookie = await later(3);
    expect(kindsOf(await recommendations(w, cookie))).toEqual([]);
    cookie = await later(7);
    await ok(
      w.t.req('POST', '/api/cards', {
        cookie,
        body: {
          projectId: w.projectId,
          title: 'Waiting work',
          cardType: 'feature',
          fields: fullFields(RICH),
          completionAction: 'merge',
          specify: true,
        },
      }),
      201,
    );
    expect(kindsOf(await recommendations(w, cookie))).toEqual([]);
    w.t.clock.setOffset(0);
  });
});
