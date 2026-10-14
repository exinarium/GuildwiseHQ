import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniqueEmail } from './helpers/app.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, DIFF_LARGE, DIFF_SMALL, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

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

const patch = (id: string, body: Record<string, unknown>, cookie = w.owner.cookie) =>
  w.t.req('PATCH', `/api/cards/${id}`, { cookie, body });
const detail = (id: string, cookie = w.owner.cookie) =>
  ok<any>(w.t.req('GET', `/api/cards/${id}`, { cookie }));
const draft = async (over: Record<string, unknown> = {}) =>
  (
    await ok<any>(
      w.t.req('POST', '/api/cards', {
        cookie: w.owner.cookie,
        body: {
          projectId: w.projectId,
          title: 'Draft',
          cardType: 'feature',
          fields: fullFields(),
          completionAction: 'merge',
          ...over,
        },
      }),
      201,
    )
  ).card;

describe('editing a card', () => {
  it('edits a draft, removes an emptied field, and shows the edit in the timeline', async () => {
    const card = await draft({ title: 'Original', fields: fullFields({ constraints: 'keep it small' }) });
    const res = await patch(card.id, {
      title: 'Renamed',
      priority: 3,
      fields: { requirements: 'new reqs', constraints: null },
    });
    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({ title: 'Renamed', priority: 3 });
    expect(res.body.card.fields.requirements).toBe('new reqs');
    expect(res.body.card.fields).not.toHaveProperty('constraints');
    expect(res.body.activity).toHaveLength(1);
    expect(res.body.activity[0]).toMatchObject({ kind: 'edited', actorName: expect.any(String) });
    expect(res.body.activity[0].summary).toBe('Edited title, priority, requirements, constraints');
    // an edit that changes nothing leaves no trace
    const same = await patch(card.id, { title: 'Renamed' });
    expect(same.body.activity).toHaveLength(1);
  });

  it('applies the same field validation as creation', async () => {
    const card = await draft();
    const bad = await patch(card.id, { fields: { acceptanceCriteria: 'not a list' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_fields');
  });

  it('a queued, unclaimed card can be edited; the owner and project owner only', async () => {
    await freshState();
    const card = await w.card({ title: 'Queued one' });
    expect((await detail(card.id)).permissions).toMatchObject({ canEdit: true });
    const ok1 = await patch(card.id, { title: 'Queued two' });
    expect(ok1.status).toBe(200);
    const stranger = await w.t.userSession(uniqueEmail('stranger'));
    const denied = await patch(card.id, { title: 'Hijack' }, stranger.cookie);
    expect([403, 404]).toContain(denied.status);
    expect((await cardRow(card.id)).title).toBe('Queued two');
  });

  it('refuses to edit a claimed card with a clear message, and a closed one', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Being built' });
    const start = await p.next('Bea');
    await p.startShift(r, start);
    expect((await cardRow(card.id)).status).toBe('claimed');
    const refused = await patch(card.id, { title: 'Too late' });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('card_claimed');
    expect(refused.body.error.message).toMatch(/being worked on/);
    expect((await detail(card.id)).permissions.canEdit).toBe(false);
    // the risk tier is not an edit: it may be set while the card is claimed
    const risk = await patch(card.id, { riskTier: 'large', reason: 'touches billing' });
    expect(risk.status).toBe(200);
    await ok(
      w.t.req('POST', `/api/cards/${card.id}/cancel`, {
        cookie: w.owner.cookie,
        body: { reason: 'done here' },
      }),
    );
    expect((await patch(card.id, { title: 'Zombie' })).status).toBe(409);
  });
});

describe('priority and completion action at any time (#54)', () => {
  it('both change on a claimed card; other fields stay locked; the permissions say so', async () => {
    await freshState();
    await hireTeam(w);
    const card = await w.card({ title: 'Claimed light edits' });
    const start = await p.next('Bea');
    await p.startShift(r, start);
    expect((await cardRow(card.id)).status).toBe('claimed');
    const d = await detail(card.id);
    expect(d.permissions).toMatchObject({ canEdit: false, canEditPriority: true, canEditCompletion: true });
    const res = await patch(card.id, { priority: 1, completionAction: 'pr' });
    expect(res.status).toBe(200);
    expect(res.body.card).toMatchObject({ priority: 1, completionAction: 'pr' });
    expect((await q('SELECT priority FROM cards WHERE id=$1', [card.id]))[0]?.priority).toBe(1);
    // push_branch was retired (backlog #61): a command refuses it and the card keeps its action
    const retired = await patch(card.id, { completionAction: 'push_branch' });
    expect(retired.status).toBe(400);
    expect((await cardRow(card.id)).completion_action).toBe('pr');
    // mixed with a heavy edit, the whole patch is refused
    const mixed = await patch(card.id, { priority: 2, title: 'Nope' });
    expect(mixed.status).toBe(409);
    expect(mixed.body.error.code).toBe('card_claimed');
    expect((await cardRow(card.id)).priority).toBe(1);
  });

  it('the completion action waits while a finalise is awaiting approval or running; priority does not', async () => {
    const card = await draft({ title: 'Finalising', completionAction: 'merge' });
    for (const state of ['awaiting_approval', 'running']) {
      await q(`UPDATE cards SET finalize_state=$2 WHERE id=$1`, [card.id, state]);
      const d = await detail(card.id);
      expect(d.permissions).toMatchObject({ canEditCompletion: false, canEditPriority: true });
      const refused = await patch(card.id, { completionAction: 'pr' });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('finalize_pending');
      expect((await patch(card.id, { priority: 4 })).status).toBe(200);
    }
    await q(`UPDATE cards SET finalize_state=NULL WHERE id=$1`, [card.id]);
    expect((await patch(card.id, { completionAction: 'pr' })).status).toBe(200);
  });

  it('a done card takes a priority only; a cancelled card takes nothing', async () => {
    const done = await draft({ title: 'Finished' });
    await q(`UPDATE cards SET status='done', stage='done' WHERE id=$1`, [done.id]);
    const d = await detail(done.id);
    expect(d.permissions).toMatchObject({ canEditPriority: true, canEditCompletion: false });
    expect((await patch(done.id, { priority: 2 })).status).toBe(200);
    const c1 = await patch(done.id, { completionAction: 'pr' });
    expect(c1.status).toBe(409);
    expect(c1.body.error.code).toBe('card_closed');
    expect((await patch(done.id, { title: 'x' })).body.error.code).toBe('card_closed');
    expect((await patch(done.id, { riskTier: 'large', reason: 'why' })).body.error.code).toBe('card_closed');

    const gone = await draft({ title: 'Cancelled' });
    await q(`UPDATE cards SET status='cancelled' WHERE id=$1`, [gone.id]);
    expect((await detail(gone.id)).permissions).toMatchObject({
      canEditPriority: false,
      canEditCompletion: false,
    });
    expect((await patch(gone.id, { priority: 2 })).body.error.code).toBe('card_closed');
  });
});

describe('risk tier override', () => {
  const riskActivity = async (id: string) =>
    (await detail(id)).activity.filter((a: any) => a.kind === 'risk_tier');

  it('needs a reason, is recorded in the timeline, and can be cleared', async () => {
    const card = await draft({ title: 'Risky?' });
    const noReason = await patch(card.id, { riskTier: 'large' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.error.code).toBe('reason_required');

    const set = await patch(card.id, { riskTier: 'large', reason: 'It changes the billing rules' });
    expect(set.status).toBe(200);
    expect(set.body.card).toMatchObject({ riskTier: 'large', riskTierOverridden: true });
    expect(set.body.permissions.canSetRisk).toBe(true);
    const [entry] = await riskActivity(card.id);
    expect(entry).toMatchObject({
      reason: 'It changes the billing rules',
      summary: 'Risk tier set to large by override (was not set)',
    });
    expect(
      await q(`SELECT 1 FROM events WHERE type='CardUpdated' AND payload->>'reason' IS NOT NULL`),
    ).not.toHaveLength(0);

    const cleared = await patch(card.id, { riskTier: null, reason: 'Fine after all' });
    expect(cleared.body.card).toMatchObject({ riskTier: null, riskTierOverridden: false });
    expect(await riskActivity(card.id)).toHaveLength(2);
  });

  it('an override to the computed value still sticks', async () => {
    const card = await draft({ title: 'Sticky' });
    await ok(
      w.t.req('PATCH', `/api/cards/${card.id}`, {
        cookie: w.owner.cookie,
        body: { riskTier: 'small', reason: 'Trust me' },
      }),
    );
    expect((await cardRow(card.id)).risk_tier_overridden).toBe(true);
  });

  it('an override to large beats a small diff: two reviewers, then the merge waits for approval', async () => {
    await freshState();
    await hireTeam(w, { reviewers: ['Rex', 'Ria'] });
    const card = await w.card({ title: 'Small diff, big risk' });
    expect((await patch(card.id, { riskTier: 'large', reason: 'Touches payments' })).status).toBe(200);
    await p.run('Bea', { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} }, DIFF_SMALL);
    expect(await cardRow(card.id)).toMatchObject({ risk_tier: 'large', stage: 'review' });
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    expect((await cardRow(card.id)).stage).toBe('review'); // one approval is not enough for a large card
    await p.run('Ria', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Tess', testPass());
    expect((await cardRow(card.id)).stage).toBe('finalize');
    const fin = await ok<any>(
      w.t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: w.owner.cookie, body: {} }),
    );
    expect(fin.state).toBe('awaiting_approval');
  });

  it('an override to small beats a large diff: one reviewer, and the merge needs no approval', async () => {
    await freshState();
    await hireTeam(w, { reviewers: ['Rex', 'Ria'] });
    const card = await w.card({ title: 'Big diff, mechanical' });
    expect((await patch(card.id, { riskTier: 'small', reason: 'Generated code only' })).status).toBe(200);
    await p.run('Bea', { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} }, DIFF_LARGE);
    expect(await cardRow(card.id)).toMatchObject({ risk_tier: 'small', stage: 'review' });
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    expect((await cardRow(card.id)).stage).toBe('test');
    await p.run('Tess', testPass());
    const from = r.received.length;
    const fin = await ok<any>(
      w.t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: w.owner.cookie, body: {} }),
    );
    expect(fin.state).toBe('running');
    await r.waitFor('command', (f: any) => f.command === 'finalize.execute', 5000, from);
  });

  it('is refused while a merge approval is pending', async () => {
    await freshState();
    await hireTeam(w, { reviewers: ['Rex', 'Ria'] });
    const card = await w.card({ title: 'Pending merge' });
    await p.run('Bea', { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} }, DIFF_LARGE);
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Ria', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Tess', testPass());
    await ok(w.t.req('POST', `/api/cards/${card.id}/finalize`, { cookie: w.owner.cookie, body: {} }));
    const res = await patch(card.id, { riskTier: 'small', reason: 'Changed my mind' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('finalize_pending');
    expect((await detail(card.id)).permissions.canSetRisk).toBe(false);
  });
});

describe('the BA overrides the risk tier from its shift (aom risk)', () => {
  const rpc = async (shiftId: string, params: Record<string, unknown>) => {
    const rpcId = randomUUID();
    const from = r.received.length;
    r.send('rpc.request', { rpcId, shiftId, method: 'card.risk', params });
    return (await r.waitFor('rpc.response', (f: any) => f.rpcId === rpcId, 15_000, from)) as any;
  };

  it('sets the tier with a reason, recorded in the timeline, and it drives the merge approval', async () => {
    await freshState();
    r.close();
    r = await w.connectRunner();
    p = pipeline(w, r);
    await hireTeam(w, { reviewers: ['Rex'] });
    await w.hire('Ben', 'ba', 'senior');
    const card = await w.card({ title: 'BA sets the tier' });
    await p.run('Bea', { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} }, DIFF_SMALL);
    await p.run('Rex', { kind: 'outcome', outcomeId: 'approve', note: 'ok', data: { score: 4 } });
    await p.run('Tess', testPass());
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finalize', risk_tier: 'small' });

    const start = await p.next('Ben');
    await p.startShift(r, start);
    expect((await rpc(start.shiftId, { tier: 'bogus', reason: 'x' })).ok).toBe(false);
    expect((await rpc(start.shiftId, { tier: 'large' })).ok).toBe(false); // a reason is required
    const set = await rpc(start.shiftId, { tier: 'large', reason: 'The diff rewrites the auth flow' });
    expect(set).toMatchObject({ ok: true });
    expect(await cardRow(card.id)).toMatchObject({ risk_tier: 'large', risk_tier_overridden: true });
    const d = await detail(card.id);
    const entry = d.activity.find((a: any) => a.kind === 'risk_tier');
    expect(entry).toMatchObject({ reason: 'The diff rewrites the auth flow', agentId: expect.any(String) });
    expect(entry.actorName).toBe('Ben');
    // the BA's finalize now waits for the manager's approval, as a computed large tier does
    const fin = await p.report(r, start.shiftId, {
      kind: 'outcome',
      outcomeId: 'finalized',
      note: 'ready',
      data: {},
    });
    expect(fin).toMatchObject({ accepted: true });
    expect(await cardRow(card.id)).toMatchObject({ status: 'waiting', finalize_state: 'awaiting_approval' });
  });

  it('only the BA, and only on a card it holds', async () => {
    await freshState();
    r.close();
    r = await w.connectRunner();
    p = pipeline(w, r);
    await hireTeam(w);
    const card = await w.card({ title: 'Builder tries' });
    const start = await p.next('Bea');
    await p.startShift(r, start);
    const res = await rpc(start.shiftId, { tier: 'large', reason: 'I feel like it' });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/business analyst/);
    expect((await cardRow(card.id)).risk_tier_overridden).toBe(false);
    expect((await rpc(randomUUID(), { tier: 'large', reason: 'x' })).ok).toBe(false);
    await until(async () => true);
  });
});
