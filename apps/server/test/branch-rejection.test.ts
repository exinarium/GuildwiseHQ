import { WORKING_BRANCH_SUBKIND } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { cardRow, pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

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

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const repoRow = async () => (await q('SELECT * FROM project_repos WHERE id=$1', [w.repoId]))[0]!;
const questions = async (status = 'open') =>
  q(`SELECT * FROM desk_items WHERE subkind=$1 AND status=$2 ORDER BY created_at`, [
    WORKING_BRANCH_SUBKIND,
    status,
  ]);
const workability = async (cardId: string) =>
  (await ok<any>(owner('GET', `/api/cards/${cardId}`))).workability;
const missing = { base: 'main', defaultBranch: 'master', branches: ['master'] };
const REASON = "working branch 'main' does not exist in this repo; its default branch is 'master'";
const rejectMissing = (agent: string, branchProblem = missing) => {
  w.t.app.ctx.services.dispatcher.cooldown.clear(); // the agent's own 30 s pause after a rejection
  return p.reject(agent, 'worktree_failed', { detail: REASON, branchProblem });
};

async function reset() {
  await freshState();
  await q(`DELETE FROM desk_items WHERE subkind=$1`, [WORKING_BRANCH_SUBKIND]);
  await q(
    `UPDATE project_repos SET working_branch=NULL, working_branch_set_by=NULL, working_branch_set_at=NULL WHERE id=$1`,
    [w.repoId],
  );
  w.t.clock.setOffset(0);
}

describe('a base branch the runner does not have', () => {
  it('adding a repository without a branch leaves the working branch unconfirmed', async () => {
    await reset();
    expect((await repoRow()).working_branch).toBeNull();
  });

  it('asks the manager once, with the branches as options, the default preselected and the card linked', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Needs a branch' });
    await rejectMissing('Bea');

    const [item, ...rest] = await questions();
    expect(rest).toEqual([]);
    expect(item).toMatchObject({
      card_id: card.id,
      pinned: true,
      blocking: false,
      recommendation: 'branch:master',
    });
    expect(item?.title).toContain("Working branch 'main' does not exist");
    expect(item?.title).toContain('default branch is master');
    expect(((item?.options ?? []) as any[]).map((o) => o.id)).toEqual(['branch:master', 'other']);
    expect(item?.asked_by_kind).toBe('system'); // not held back for the BA's triage
    expect(item?.triage).not.toBe('pending');
    // the repository is untouched: only the manager confirms a branch
    expect((await repoRow()).working_branch).toBeNull();
  });

  it('shows the last failure on the board, linked to the repository settings, until a shift starts', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Warned' });
    await rejectMissing('Bea');
    const wk = await workability(card.id);
    expect(wk).toMatchObject({ ok: false, level: 'waiting', settings: 'repositories' });
    expect(wk.reason).toBe(
      "Last attempt failed: working branch 'main' does not exist in toy (default branch is master). Fix the working branch in project settings.",
    );
    const board = await ok<any>(owner('GET', `/api/board?projectId=${w.projectId}`));
    const tile = board.columns.flatMap((c: any) => c.cards).find((c: any) => c.id === card.id);
    expect(tile.workability.settings).toBe('repositories');
    const events = await q(`SELECT payload FROM events WHERE type='ClaimReleased' AND stream_id=$1`, [
      `card-${card.id}`,
    ]);
    expect(events[0]?.payload.rejection).toMatchObject({ kind: 'branch', repoId: w.repoId });

    // a shift that starts clears it
    await q('UPDATE cards SET retry_after=NULL WHERE id=$1', [card.id]);
    w.t.app.ctx.services.dispatcher.cooldown.clear();
    const start = await p.next('Bea');
    await p.startShift(r, start);
    expect((await cardRow(card.id)).last_rejection).toBeNull();
    r.ended(start.shiftId, 'stopped');
  });

  it('other rejections show their detail too', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'No clone' });
    await p.reject('Bea', 'repo_missing', { detail: 'no local clone for github.com/acme/toy' });
    const wk = await workability(card.id);
    expect(wk.reason).toBe('Last attempt failed: no local clone for github.com/acme/toy');
    expect(wk.settings).toBeUndefined();
  });

  it('holds the card back with a growing pause, and keeps one open question per repository', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Hammered' });
    await rejectMissing('Bea');
    let c = await cardRow(card.id);
    expect(c).toMatchObject({ status: 'queued', retry_failures: 1 });
    const first = new Date(c.retry_after).getTime();
    expect(first - w.t.clock.now().getTime()).toBeGreaterThan(55_000);

    // not dispatched again while it waits
    const starts = r.of('shift.start').length;
    await w.t.app.ctx.services.dispatcher.run();
    await new Promise((res) => setTimeout(res, 150));
    expect(r.of('shift.start').length).toBe(starts);

    w.t.clock.advance(61_000);
    await rejectMissing('Bea');
    c = await cardRow(card.id);
    expect(c.retry_failures).toBe(2);
    expect(new Date(c.retry_after).getTime() - w.t.clock.now().getTime()).toBeGreaterThan(115_000);
    expect((await questions()).length).toBe(1);

    // a second card on the same repository adds no second question
    const other = await w.card({ title: 'Second' });
    await rejectMissing('Bea'); // the first card is still held back: the second one is tried
    expect((await questions()).length).toBe(1);
    expect((await cardRow(other.id)).last_rejection).not.toBeNull();
  });

  it('answering the question confirms the branch, clears the warning and lets the card go at once', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Fixed in one click' });
    await rejectMissing('Bea');
    const [item] = await questions();
    await ok(
      owner('POST', `/api/desk/${item?.id}/answer`, {
        answer: 'master',
        optionId: 'branch:master',
        ledger: { scope: 'decision' },
      }),
    );
    expect(await repoRow()).toMatchObject({ working_branch: 'master', working_branch_set_by: w.owner.id });
    const c = await cardRow(card.id);
    expect(c).toMatchObject({ last_rejection: null, retry_after: null, retry_failures: 0 });
    expect((await workability(card.id)) ?? { ok: true }).toMatchObject({ ok: true });
  });

  it('never overrides a branch the manager confirmed: it asks, offering the existing branches', async () => {
    await reset();
    await q(
      `UPDATE project_repos SET working_branch='main', working_branch_set_by=$2, working_branch_set_at=now() WHERE id=$1`,
      [w.repoId, w.owner.id],
    );
    await w.hire('Bea', 'builder', 'junior');
    await w.card({ title: 'Confirmed but gone' });
    await rejectMissing('Bea');
    expect((await repoRow()).working_branch).toBe('main');
    const [item] = await questions();
    const ids = ((item?.options ?? []) as any[]).map((o) => o.id);
    expect(ids).toEqual(['branch:master', 'other']); // no "keep main": it does not exist
    expect(item?.data).toMatchObject({ repoId: w.repoId, current: 'main' });
  });

  it('suggests the only branch when the runner could not tell the default', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.card({ title: 'Single branch' });
    await rejectMissing('Bea', { base: 'main', branches: ['trunk'] } as typeof missing);
    const [item] = await questions();
    expect(item?.recommendation).toBe('branch:trunk');
  });
});

describe('a working branch the runner created', () => {
  it("tells the runner the repository's main branch, so a missing working branch is created from it", async () => {
    await reset();
    await owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { mainBranch: 'release' });
    await w.hire('Bea', 'builder', 'junior');
    await w.card({ title: 'Main branch named' });
    const start = await p.next('Bea');
    expect(start.worktree).toMatchObject({ baseBranch: 'main', mainBranch: 'release' });
    r.accepted(start.shiftId);
    r.ended(start.shiftId, 'stopped');
    await owner('PATCH', `/api/projects/${w.projectId}/repos/${w.repoId}`, { mainBranch: null });
  });

  it('says so on the card', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Branch made' });
    const start = await p.next('Bea');
    r.accepted(start.shiftId);
    r.send('shift.started', {
      shiftId: start.shiftId,
      branchCreated: { base: 'main', from: 'master', pushed: true },
    });
    await new Promise((res) => setTimeout(res, 300));
    const events = await q(`SELECT payload FROM events WHERE type='ThreadMessagePosted' AND stream_id=$1`, [
      `thread-${card.id}`,
    ]);
    expect(events.map((e) => e.payload.body)).toContain(
      'Created working branch main from master and pushed it to origin: it did not exist in the repository.',
    );
    // and the repository remembers it, for the project settings
    const proj = await ok<any>(owner('GET', `/api/projects/${w.projectId}`));
    expect(proj.repos.find((x: any) => x.id === w.repoId).workingBranchCreated).toMatchObject({
      from: 'master',
      pushed: true,
    });
    r.ended(start.shiftId, 'stopped');
  });

  it('adds the created branch to the repository branch list, notes the unset main branch, and takes the origin list', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Branch list' });
    const start = await p.next('Bea');
    r.accepted(start.shiftId);
    r.send('shift.started', {
      shiftId: start.shiftId,
      branchCreated: { base: 'alex/dev', from: 'main', pushed: true, mainBranchSet: false },
    });
    await new Promise((res) => setTimeout(res, 300));
    let proj = await ok<any>(owner('GET', `/api/projects/${w.projectId}`));
    let repo = proj.repos.find((x: any) => x.id === w.repoId);
    expect(repo.knownBranches).toContain('alex/dev');
    const notes = await q(`SELECT payload FROM events WHERE type='ThreadMessagePosted' AND stream_id=$1`, [
      `thread-${card.id}`,
    ]);
    expect(notes.map((e) => e.payload.body).join('\n')).toContain('The main branch is not set');
    const alerts = await q(`SELECT 1 FROM desk_items WHERE subkind='main_branch_unset' AND card_id=$1`, [
      card.id,
    ]);
    expect(alerts).toHaveLength(1);

    // origin's own list replaces the stored one and dates it
    r.send('shift.started', { shiftId: start.shiftId, originBranches: ['main', 'alex/dev', 'feature/x'] });
    await new Promise((res) => setTimeout(res, 300));
    proj = await ok<any>(owner('GET', `/api/projects/${w.projectId}`));
    repo = proj.repos.find((x: any) => x.id === w.repoId);
    expect(repo.knownBranches).toEqual(['main', 'alex/dev', 'feature/x']);
    expect(repo.knownBranchesAt).toBeTruthy();
    r.ended(start.shiftId, 'stopped');
  });

  it('a failed creation reaches the question', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    await w.card({ title: 'Branch refused' });
    await rejectMissing('Bea', { ...missing, createFailed: 'git push failed: protected' } as typeof missing);
    const [item] = await questions();
    expect(JSON.stringify(item)).toContain('could not: git push failed: protected');
  });
});
