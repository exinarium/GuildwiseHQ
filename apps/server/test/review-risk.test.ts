import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, DIFF_SMALL, eventsOfType, hireTeam, pipeline, testPass } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

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

const owner = () => ({
  get: (url: string) => w.t.req('GET', url, { cookie: w.owner.cookie }),
  post: (url: string, body: unknown = {}) => w.t.req('POST', url, { cookie: w.owner.cookie, body }),
  put: (url: string, body: unknown = {}) => w.t.req('PUT', url, { cookie: w.owner.cookie, body }),
});
const handoff = { kind: 'outcome', outcomeId: 'handoff', note: 'x', data: {} };
const review = (outcomeId: 'approve' | 'changes', data: Record<string, unknown>) => ({
  kind: 'outcome',
  outcomeId,
  note: 'reviewed',
  data: { score: 4, ...data },
});
const HIGH = {
  risk: 'high',
  riskAnalysis: '## Failure scenarios\n- retries double-charge (likely, severe)',
  qaFocus: 'Pay twice in quick succession',
};

async function atTest(data: Record<string, unknown>, o: { ba?: boolean } = {}) {
  await freshState();
  r.close();
  r = await w.connectRunner();
  p = pipeline(w, r);
  await ok(owner().put(`/api/projects/${w.projectId}/full-suite`, { enabled: false }));
  await hireTeam(w);
  if (o.ba) await w.hire('Ben', 'ba', 'senior');
  const card = await w.card({ title: 'Risky' });
  await p.run('Bea', handoff, DIFF_SMALL);
  await p.run('Rex', review('approve', data));
  expect((await cardRow(card.id)).stage).toBe('test');
  return card;
}

describe('reviewer effort (backlog #70)', () => {
  it('a reviewer hired without an effort gets high, the role default', async () => {
    await freshState();
    await w.hire('Rex', 'reviewer', 'senior');
    expect((await q(`SELECT effort FROM agents WHERE name='Rex'`))[0]!.effort).toBe('high');
    const roles = await ok<any>(owner().get('/api/org/catalogue'));
    const reviewer = roles.roles.find((x: any) => x.key === 'reviewer');
    expect(reviewer.versions[0].definition?.defaultModel?.effort ?? 'high').toBe('high');
  });
});

describe('reviewer risk (backlog #70)', () => {
  it('stores the risk on the event, the card and the card query', async () => {
    const card = await atTest(HIGH);
    const ev = (await eventsOfType('ReviewApproved')).find((e) => e.cardId === card.id);
    expect(ev).toMatchObject({ risk: 'high', qaFocus: HIGH.qaFocus, riskAnalysis: HIGH.riskAnalysis });
    expect((await cardRow(card.id)).review_risk).toMatchObject({ level: 'high', qaFocus: HIGH.qaFocus });
    const d = await ok<any>(owner().get(`/api/cards/${card.id}`));
    expect(d.card.reviewRisk).toMatchObject({
      level: 'high',
      analysis: HIGH.riskAnalysis,
      qaFocus: HIGH.qaFocus,
    });
    expect(d.card.reviewRisk.mergeApprovalReason).toContain('HIGH risk');
    // the handoff keeps the analysis for the review section
    expect(d.handoffs.find((h: any) => h.outcome === 'approve').data).toMatchObject({ risk: 'high' });
  });

  it('a review without risk (an older runner) is stored as unknown and changes nothing', async () => {
    const card = await atTest({});
    const ev = (await eventsOfType('ReviewApproved')).find((e) => e.cardId === card.id);
    expect(ev?.risk).toBe('unknown');
    const d = await ok<any>(owner().get(`/api/cards/${card.id}`));
    expect(d.card.reviewRisk).toBeNull();
    await p.run('Tess', testPass());
    const out = await ok<any>(owner().post(`/api/cards/${card.id}/finalize`, {}));
    expect(out.state).toBe('running');
  });

  it('changes requested with regression_risk is recorded with its risk fields', async () => {
    await freshState();
    r.close();
    r = await w.connectRunner();
    p = pipeline(w, r);
    await hireTeam(w);
    const card = await w.card({ title: 'Breaks things' });
    await p.run('Bea', handoff, DIFF_SMALL);
    await p.run(
      'Rex',
      review('changes', { reasons: ['regression_risk'], criteriaMissed: [], ...HIGH, qaFocus: undefined }),
    );
    const ev = (await eventsOfType('ChangesRequested')).find((e) => e.cardId === card.id);
    expect(ev).toMatchObject({ reasons: ['regression_risk'], risk: 'high' });
    expect((await cardRow(card.id)).stage).toBe('build');
  });

  it('a high risk makes even a small merge wait for the manager, waiver or not', async () => {
    const card = await atTest(HIGH);
    await q('UPDATE projects SET merge_large_without_approval=true WHERE id=$1', [w.projectId]);
    await p.run('Tess', testPass());
    expect(await cardRow(card.id)).toMatchObject({ stage: 'finalize', risk_tier: 'small' });
    const out = await ok<any>(owner().post(`/api/cards/${card.id}/finalize`, {}));
    expect(out.state).toBe('awaiting_approval');
    expect(out.deskItemId).toBeTruthy();
    const d = await ok<any>(owner().get(`/api/cards/${card.id}`));
    expect(d.testing.finalize).toMatchObject({ state: 'awaiting_approval', requiresApproval: true });
    expect(d.testing.finalize.approvalReason).toContain('HIGH risk');
    const item = (await ok<any>(owner().get('/api/desk'))).items.find((i: any) => i.id === out.deskItemId);
    expect(item.body).toContain('HIGH risk');
    await q('UPDATE projects SET merge_large_without_approval=false WHERE id=$1', [w.projectId]);
  });

  it('a medium risk does not gate the merge', async () => {
    const card = await atTest({ risk: 'medium', riskAnalysis: 'thin coverage', qaFocus: 'Check export' });
    await p.run('Tess', testPass());
    const out = await ok<any>(owner().post(`/api/cards/${card.id}/finalize`, {}));
    expect(out.state).toBe('running');
  });

  it("the tester's brief carries the QA focus and the failure scenarios", async () => {
    await atTest(HIGH);
    const start = await p.next('Tess');
    expect(start.brief.reviewRisk).toMatchObject({
      level: 'high',
      qaFocus: HIGH.qaFocus,
      analysis: HIGH.riskAnalysis,
    });
  });

  it('the QA steps brief carries them too', async () => {
    await ok(owner().put(`/api/projects/${w.projectId}/manual-qa`, { enabled: true }));
    const card = await atTest(
      { risk: 'medium', riskAnalysis: 'shared parser', qaFocus: 'Parse a huge file' },
      { ba: true },
    );
    await p.run('Tess', testPass());
    const from = r.received.length;
    const start = await p.next('Ben');
    await p.startShift(r, start);
    await p.report(r, start.shiftId, { kind: 'outcome', outcomeId: 'finalized', note: 'ready', data: {} });
    r.ended(start.shiftId, 'reported');
    const cmd = await r.waitFor('command', (f) => f.command === 'finalize.execute', 15_000, from);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, action: 'merge', mergeCommit: 'abc1234567' },
    });
    await until(async () => (await cardRow(card.id)).stage === 'qa_steps', 5000, 'qa_steps');
    const qa = await p.next('Tess');
    expect(qa.brief.shift.stage).toBe('qa_steps');
    expect(qa.brief.reviewRisk).toMatchObject({ level: 'medium', qaFocus: 'Parse a huge file' });
    await ok(owner().put(`/api/projects/${w.projectId}/manual-qa`, { enabled: false }));
  });
});
