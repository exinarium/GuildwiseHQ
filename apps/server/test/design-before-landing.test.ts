import { READONLY_DESIGN_CAPABILITY } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, eventsOfType, pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, fullFields, ok, until, type World } from './helpers/world.ts';

// Backlog #80: dependencies count as landed at Finalize; the architect designs before dependencies land, and
// reviews its assumptions once they have.

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ capabilities: [READONLY_DESIGN_CAPABILITY] });
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const cookie = () => w.owner.cookie;
const REPORT = 'docs/investigations/design.md';
const ASSUMPTIONS = [
  {
    assumption: 'P1 exposes a greet() function',
    dependency: 'TOY-1',
    ifWrong: 'call the HTTP endpoint instead',
  },
  { assumption: 'greet() is synchronous', dependency: 'TOY-1', ifWrong: 'await it in the module' },
];
const design = (over: Record<string, unknown> = {}) => ({
  kind: 'outcome',
  outcomeId: 'handoff',
  note: 'designed',
  data: { reportPath: REPORT, summary: 'Build it in module X.', location: 'repo', ...over },
});
const review = (decision: 'confirm' | 'revise', revised: number[] = [], over: Record<string, unknown> = {}) =>
  design({ review: { decision, revised, note: 'checked against the landed code' }, ...over });

async function team() {
  await freshState();
  await q(`UPDATE project_repos SET main_branch=NULL, working_branch=NULL WHERE id=$1`, [w.repoId]);
  await q(`UPDATE projects SET design_step=true, investigation_location='repo' WHERE id=$1`, [w.projectId]);
  await w.hire('Bea', 'builder', 'junior', { capacity: 4 });
  await w.hire('Aria', 'architect', 'senior');
}

/** TOY-1, a base card that stays where the test puts it, and a designed dependent TOY-2. */
async function pair(opts: { designNeeded?: boolean } = {}) {
  const base = await w.card({
    title: 'Greeting module',
    designNeeded: false,
    fields: fullFields({ context: 'greet people', requirements: 'export greet()' }),
  });
  // the base card sits in its build stage, claimed by nobody we dispatch
  await q(`UPDATE cards SET status='blocked' WHERE id=$1`, [base.id]);
  const dep = await w.card({
    title: 'Use the greeting',
    designNeeded: opts.designNeeded ?? true,
    dependencies: [base.id],
  });
  return { base, dep };
}
const landBase = (id: string, over = '') =>
  q(
    `UPDATE cards SET status='waiting', stage='qa_steps', finalized_at=now(), merged_into_working_at=now() ${over} WHERE id=$1`,
    [id],
  );
/** A dispatch pass hands out no new shift. */
async function idle() {
  const before = r.of('shift.start').length;
  await q('UPDATE workstations SET last_seen_at=$1 WHERE connected', [w.t.clock.now()]);
  await r.barrier();
  await p.dispatcher().run();
  await new Promise((res) => setTimeout(res, 300));
  expect(r.of('shift.start').length).toBe(before);
}
const startReadOnly = async (start: any) => {
  r.accepted(start.shiftId);
  r.started(start.shiftId); // no worktree: the runner made a read-only checkout
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
    3000,
    'shift running',
  );
};
async function finish(shiftId: string) {
  r.ended(shiftId, 'reported');
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [shiftId, 'ended']))[0],
    3000,
    'shift ended',
  );
}

describe('rule 1: a dependency counts as landed once it is finalized and merged', () => {
  it('a dependency in Manual QA after a merge-finalize releases the dependent build', async () => {
    await team();
    const { base, dep } = await pair({ designNeeded: false });
    expect(dep.stage).toBe('build');
    // not finalized: the dependent build waits
    await idle();
    await landBase(base.id);
    const start = await p.next('Bea');
    expect(start.brief.card.ref).toBe(dep.ref);
    expect(start.brief.card.dependencies).toEqual([
      expect.objectContaining({ ref: base.ref, status: 'waiting', landed: true }),
    ]);
  });

  it('a pr-finalized dependency that is not merged has not landed; it has once the merge is seen', async () => {
    await team();
    const { base, dep } = await pair({ designNeeded: false });
    await q(
      `UPDATE cards SET status='waiting', stage='qa_steps', finalized_at=now(), finalize_action='pr',
              finalize_result='{"prUrl":"https://example.test/pr/1"}' WHERE id=$1`,
      [base.id],
    );
    await idle();
    await q(`UPDATE cards SET merged_into_working_at=now() WHERE id=$1`, [base.id]);
    expect((await p.next('Bea')).brief.card.ref).toBe(dep.ref);
  });

  it('done and cancelled dependencies still count', async () => {
    await team();
    const { base, dep } = await pair({ designNeeded: false });
    await q(`UPDATE cards SET status='cancelled', stage='cancelled' WHERE id=$1`, [base.id]);
    expect((await p.next('Bea')).brief.card.ref).toBe(dep.ref);
  });

  it('the card page tells which dependencies have landed', async () => {
    await team();
    const { base, dep } = await pair({ designNeeded: false });
    const get = async () =>
      (await ok<any>(w.t.req('GET', `/api/cards/${dep.id}`, { cookie: cookie() }))).card.dependencies;
    expect(await get()).toEqual([expect.objectContaining({ ref: base.ref, landed: false })]);
    await landBase(base.id);
    expect(await get()).toEqual([
      expect.objectContaining({ ref: base.ref, landed: true, stage: 'qa_steps' }),
    ]);
  });
});

describe('rule 2: the architect designs before the dependencies landed', () => {
  it('claims the design without a card branch; the brief says what is not landed and carries the dependency specs', async () => {
    await team();
    const { base, dep } = await pair();
    const start = await p.next('Aria');
    expect(start.brief.card.ref).toBe(dep.ref);
    expect(start.worktree).toMatchObject({ mode: 'readonly', baseBranch: expect.any(String) });
    expect(start.brief.investigation).toMatchObject({
      readOnly: true,
      unlandedDependencies: [
        expect.objectContaining({
          ref: base.ref,
          title: 'Greeting module',
          spec: expect.stringContaining('export greet()'),
        }),
      ],
    });
    await startReadOnly(start);
    const row = await cardRow(dep.id);
    expect(row.worktree_path).toBeNull();
    expect(row.branch_name).toBeNull();
  });

  it('an older runner (no read-only design capability) leaves the card waiting', async () => {
    await team();
    await pair();
    await q(`UPDATE workstation_capabilities SET capabilities = '{}'`);
    await idle();
    await q(`UPDATE workstation_capabilities SET capabilities = ARRAY[$1]`, [READONLY_DESIGN_CAPABILITY]);
  });

  it('an investigation-only card still waits for its dependencies', async () => {
    await team();
    const { dep } = await pair();
    await q(`UPDATE cards SET investigation_only=true WHERE id=$1`, [dep.id]);
    await idle();
  });

  it('the design records its assumptions; the card is held in the design stage and build waits', async () => {
    await team();
    const { base, dep } = await pair();
    const start = await p.next('Aria');
    await startReadOnly(start);
    // assumptions are required for a design made before the dependencies landed
    const refused = await p.report(r, start.shiftId, design({ body: '# design' }));
    expect(refused).toMatchObject({ accepted: false });
    expect(refused.error).toMatch(/assumptions/);
    const res = await p.report(
      r,
      start.shiftId,
      design({ body: '# design\nuses greet()', assumptions: ASSUMPTIONS }),
    );
    expect(res).toMatchObject({ accepted: true });
    await finish(start.shiftId);
    const row = await cardRow(dep.id);
    expect(row.stage).toBe('investigate');
    expect(row.status).toBe('queued');
    expect(row.design_review).toMatchObject({ state: 'waiting', dependencies: [base.ref] });
    expect(row.investigation).toMatchObject({
      location: 'repo',
      body: '# design\nuses greet()',
      assumptions: ASSUMPTIONS,
    });
    const dto = (await ok<any>(w.t.req('GET', `/api/cards/${dep.id}`, { cookie: cookie() }))).card;
    expect(dto.designReview).toMatchObject({ state: 'waiting', dependencies: [base.ref], result: null });
    expect(dto.designReview.assumptions).toHaveLength(2);
    // the board names the dependencies still not landed; one that has landed drops out
    const boardCard = async () =>
      (await ok<any>(w.t.req('GET', `/api/board?projectId=${w.projectId}`, { cookie: cookie() }))).columns
        .flatMap((c: any) => c.cards)
        .find((c: any) => c.id === dep.id);
    expect((await boardCard()).designHeld).toEqual({ waitingFor: [base.ref] });
    await q(`UPDATE cards SET merged_into_working_at=now() WHERE id=$1`, [base.id]);
    expect((await boardCard()).designHeld).toEqual({ waitingFor: [] });
    await q(`UPDATE cards SET merged_into_working_at=NULL WHERE id=$1`, [base.id]);
    // neither the architect (review) nor the builder gets it while the dependency has not landed
    await idle();
    await idle();
  });

  it('on landing the architect gets a review shift on a created branch; confirm releases the card to build', async () => {
    await team();
    const { base, dep } = await pair();
    const start = await p.next('Aria');
    await startReadOnly(start);
    await p.report(r, start.shiftId, design({ body: '# design', assumptions: ASSUMPTIONS }));
    await finish(start.shiftId);
    await landBase(base.id);

    const rev = await p.next('Aria');
    expect(rev.brief.card.ref).toBe(dep.ref);
    expect(rev.worktree).toMatchObject({ mode: 'create' });
    expect(rev.brief.investigation).toMatchObject({
      review: { dependencies: [base.ref], assumptions: ASSUMPTIONS },
      report: { reportPath: REPORT, body: '# design' },
    });
    expect(rev.brief.investigation!.readOnly).toBeUndefined();
    await p.startShift(r, rev);
    // the plain design outcome is not enough here
    const plain = await p.report(r, rev.shiftId, design());
    expect(plain).toMatchObject({ accepted: false });
    expect(plain.error).toMatch(/aom design confirm/);
    const res = await p.report(r, rev.shiftId, review('confirm'));
    expect(res).toMatchObject({ accepted: true });
    await finish(rev.shiftId);
    await until(async () => (await cardRow(dep.id)).stage === 'build', 3000, 'card moved to build');
    const row = await cardRow(dep.id);
    expect(row.design_review).toMatchObject({ state: 'reviewed', result: { confirmed: 2, revised: 0 } });
    const evs = (await eventsOfType('DesignReviewed')).filter((e) => e.cardId === dep.id);
    expect(evs).toEqual([expect.objectContaining({ decision: 'confirm', confirmed: 2, revised: 0 })]);
    // the builder gets the design with the carried report text to commit
    const build = await p.next('Bea');
    expect(build.brief.card.ref).toBe(dep.ref);
    expect(build.brief.investigation!.report).toMatchObject({ reportPath: REPORT, body: '# design' });
    const dto = (await ok<any>(w.t.req('GET', `/api/cards/${dep.id}`, { cookie: cookie() }))).card;
    expect(dto.designReview).toMatchObject({ state: 'reviewed', result: { confirmed: 2, revised: 0 } });
  });

  it('revise records the updated design and counts the assumptions that did not hold', async () => {
    await team();
    const { base, dep } = await pair();
    const start = await p.next('Aria');
    await startReadOnly(start);
    await p.report(r, start.shiftId, design({ body: '# design', assumptions: ASSUMPTIONS }));
    await finish(start.shiftId);
    await landBase(base.id);
    const rev = await p.next('Aria');
    await p.startShift(r, rev);
    expect(await p.report(r, rev.shiftId, review('revise', [3]))).toMatchObject({ accepted: false });
    expect(await p.report(r, rev.shiftId, review('revise', []))).toMatchObject({ accepted: false });
    // a revised report was committed on the new card branch by the architect
    const res = await p.report(
      r,
      rev.shiftId,
      review('revise', [2], { commit: 'def5678', summary: 'Now async.' }),
    );
    expect(res).toMatchObject({ accepted: true });
    await finish(rev.shiftId);
    await until(async () => (await cardRow(dep.id)).stage === 'build', 3000, 'card moved to build');
    const row = await cardRow(dep.id);
    expect(row.design_review).toMatchObject({ state: 'reviewed', result: { confirmed: 1, revised: 1 } });
    expect(row.investigation).toMatchObject({
      summary: 'Now async.',
      commit: 'def5678',
      assumptions: ASSUMPTIONS,
    });
    expect(row.investigation.body).toBeUndefined();
  });

  it('a design that assumes nothing skips the review: the card goes to build and build waits for the dependency', async () => {
    await team();
    const { base, dep } = await pair();
    const start = await p.next('Aria');
    await startReadOnly(start);
    const res = await p.report(
      r,
      start.shiftId,
      design({ body: '# design', noAssumptions: 'self-contained' }),
    );
    expect(res).toMatchObject({ accepted: true });
    await finish(start.shiftId);
    await until(async () => (await cardRow(dep.id)).stage === 'build', 3000, 'card moved to build');
    expect((await cardRow(dep.id)).design_review).toBeNull();
    await idle();
    await landBase(base.id);
    expect((await p.next('Bea')).brief.card.ref).toBe(dep.ref);
  });

  it('with the dependencies landed, the design is the usual one: a worktree is created and nothing is held', async () => {
    await team();
    const { base, dep } = await pair();
    await landBase(base.id);
    const start = await p.next('Aria');
    expect(start.worktree).toMatchObject({ mode: 'create' });
    expect(start.brief.investigation!.readOnly).toBeUndefined();
    await p.startShift(r, start);
    const res = await p.report(r, start.shiftId, design({ commit: 'abc1234' }));
    expect(res).toMatchObject({ accepted: true });
    await finish(start.shiftId);
    await until(async () => (await cardRow(dep.id)).stage === 'build', 3000, 'card moved to build');
    expect((await cardRow(dep.id)).design_review).toBeNull();
  });
});
