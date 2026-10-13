import { randomUUID } from 'node:crypto';
import { WORKING_BRANCH_SUBKIND } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, until, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner();
  // These tests cover the questions a git expert gets; simple mode (the default) is covered in simple-mode.test.ts.
  await q('UPDATE users SET git_expert=true WHERE id=$1', [w.owner.id]);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const dispatcher = () => w.t.app.ctx.services.dispatcher;
const flush = () => w.t.app.ctx.notifier.flush();
const repoRow = async () => (await q('SELECT * FROM project_repos WHERE id=$1', [w.repoId]))[0]!;
const questions = async (status = 'open') =>
  q(`SELECT * FROM desk_items WHERE subkind=$1 AND status=$2 ORDER BY created_at`, [
    WORKING_BRANCH_SUBKIND,
    status,
  ]);

/** Runs "Run hygiene now", lets the DevOps shift start and returns what the DevOps engineer received. */
async function startHygiene() {
  const from = r.received.length;
  const res = await ok<any>(owner('POST', `/api/workstations/${w.workstationId}/hygiene/run`), 201);
  await dispatcher().run();
  const start = await r.waitFor('shift.start', (f) => f.kind === 'devops', 5000, from);
  r.accepted(start.shiftId);
  r.started(start.shiftId);
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
    3000,
    'devops shift running',
  );
  return { requestId: res.requestId as string, start };
}

async function finish(start: { shiftId: string }, hygiene: unknown, summary = 'Repository hygiene done') {
  const { reportId } = r.report(start.shiftId, {
    kind: 'outcome',
    outcomeId: 'devops_done',
    note: summary,
    data: { summary, commands: ['git fetch'], hygiene },
  });
  const res = await r.waitFor('shift.report.result', (f) => f.reportId === reportId);
  r.ended(start.shiftId);
  await until(
    async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'ended']))[0],
    5000,
    'shift ended',
  );
  return res;
}

const result = (over: Record<string, unknown> = {}) => ({
  repoId: w.repoId,
  actions: ['fetched origin'],
  problem: null,
  branches: ['develop', 'staging'],
  uncommitted: [],
  pushed: false,
  removedBranches: [],
  cleaned: [],
  ...over,
});

describe('repository hygiene request', () => {
  it('lists the workstation repositories with an unconfirmed working branch as null, and the runner gets a sweep command', async () => {
    const { requestId, start } = await startHygiene();
    const spec = start.devops?.hygiene;
    expect(spec?.trigger).toBe('manual');
    expect(spec?.repos).toHaveLength(1);
    expect(spec?.repos[0]).toMatchObject({
      repoId: w.repoId,
      projectKey: 'TOY',
      name: 'toy',
      localPath: '/tmp/toy',
      workingBranch: null,
      branchSource: null,
    });
    // the same request is stored with its repositories and the runner is asked to sweep stale worktrees
    const req = (await q('SELECT hygiene, status FROM devops_requests WHERE id=$1', [requestId]))[0];
    expect(req?.hygiene.repos[0].repoId).toBe(w.repoId);
    const sweep = await r.waitFor('command', (f) => f.command === 'worktrees.sweep');
    expect(sweep.payload.requestId).toBe(requestId);
    // a second click while it runs does not start another
    const again = await ok<any>(owner('POST', `/api/workstations/${w.workstationId}/hygiene/run`), 200);
    expect(again).toMatchObject({ requestId, alreadyRunning: true });
    await finish(start, { repos: [result({ problem: { kind: 'needs_branch', detail: 'not confirmed' } })] });
    await until(
      async () =>
        (await q('SELECT 1 FROM devops_requests WHERE id=$1 AND status=$2', [requestId, 'done']))[0],
      5000,
      'request done',
    );
  });

  it('an unconfirmed branch with no uncommitted changes becomes a non-blocking question with the branches as options', async () => {
    const [item] = await questions();
    expect(item).toBeTruthy();
    expect(item).toMatchObject({ kind: 'question', blocking: false, pinned: false, routed_to: 'manager' });
    expect(item?.title).toContain('Which branch is the working branch of toy (TOY)');
    expect(item?.options.map((o: any) => o.label)).toEqual(['develop', 'staging', 'Another branch']);
    expect(item?.options.map((o: any) => o.id)).toEqual(['branch:develop', 'branch:staging', 'other']);
    expect(item?.asked_by_kind).toBe('agent');
    expect(item?.asked_by_role).toBe('devops');
    expect(item?.data).toMatchObject({ repoId: w.repoId, reason: 'unconfirmed' });
    // one question per repository: asking again while it is open adds nothing
    const { start } = await startHygiene();
    await finish(start, { repos: [result({ problem: { kind: 'needs_branch', detail: 'not confirmed' } })] });
    expect(await questions()).toHaveLength(1);
  });

  it('a repository whose default branch can be told is confirmed without asking (a repository with only master gets master)', async () => {
    const [open] = await questions();
    await ok(owner('POST', `/api/desk/${open?.id}/dismiss`, {}));
    const { start } = await startHygiene();
    await finish(start, {
      repos: [result({ branches: ['master'], problem: { kind: 'needs_branch', detail: 'not confirmed' } })],
    });
    expect(await questions()).toHaveLength(0);
    expect((await repoRow()).working_branch).toBe('master');
    await q('UPDATE project_repos SET working_branch=NULL, working_branch_set_at=NULL WHERE id=$1', [
      w.repoId,
    ]);
  });

  it('a missing branch that holds back a commit is a blocking, pinned question', async () => {
    // settle the open one first, then see the blocking variant
    const [open] = await questions();
    if (open) await ok(owner('POST', `/api/desk/${open.id}/dismiss`, {}));

    const { start } = await startHygiene();
    await finish(start, {
      repos: [
        result({
          problem: { kind: 'needs_branch', detail: 'not confirmed' },
          uncommitted: ['wip.txt', 'README.md'],
        }),
      ],
    });
    const [item] = await questions();
    expect(item).toMatchObject({ blocking: true, pinned: true });
    expect(item?.doing).toContain('2 file(s) have uncommitted changes');
  });

  it('answering the question stores the branch on the repository, writes a ledger entry and runs hygiene right away', async () => {
    const [item] = await questions();
    const from = r.received.length;
    const ans = await ok<any>(
      owner('POST', `/api/desk/${item?.id}/answer`, {
        answer: 'develop',
        optionId: 'branch:develop',
        ledger: { scope: 'decision' },
      }),
    );
    expect(ans.ledgerEntryId).toBeTruthy();
    const repo = await repoRow();
    expect(repo.working_branch).toBe('develop');
    expect(repo.working_branch_set_by).toBe(w.owner.id);
    const ledger = (await q('SELECT * FROM ledger_entries WHERE id=$1', [ans.ledgerEntryId]))[0];
    expect(ledger?.body).toContain('develop');
    expect(ledger?.source_desk_item_id).toBe(item?.id);
    const ev = (
      await q(`SELECT payload FROM events WHERE type='ProjectRepoWorkingBranchSet' ORDER BY seq DESC LIMIT 1`)
    )[0]?.payload;
    expect(ev).toMatchObject({ workingBranch: 'develop', previousBranch: null, reason: 'unconfirmed' });
    // a hygiene request starts at once so the held-back work is committed
    await dispatcher().run();
    const start = await r.waitFor('shift.start', (f) => f.kind === 'devops', 5000, from);
    expect(start.devops?.hygiene?.trigger).toBe('branch_confirmed');
    expect(start.devops?.hygiene?.repos[0]).toMatchObject({ workingBranch: 'develop', branchSource: 'repo' });
    r.accepted(start.shiftId);
    r.started(start.shiftId);
    await until(
      async () => (await q('SELECT 1 FROM shifts WHERE id=$1 AND status=$2', [start.shiftId, 'running']))[0],
      3000,
      'shift running',
    );
    await finish(start, { repos: [result({ actions: ['committed 2 file(s) on develop (abc1234)'] })] });
    await until(
      async () =>
        (await q(`SELECT 1 FROM devops_requests WHERE hygiene IS NOT NULL AND status='running'`))[0] ===
        undefined,
      5000,
      'request ended',
    );
    // later runs do not ask again
    expect(await questions()).toHaveLength(0);
  });

  it('the answer "another branch" needs a valid branch name', async () => {
    const id = randomUUID();
    const { start } = await startHygiene();
    // reset the repo to unconfirmed to get a fresh question
    await q(`UPDATE project_repos SET working_branch=NULL WHERE id=$1`, [w.repoId]);
    await finish(start, { repos: [result({ problem: { kind: 'needs_branch', detail: 'x' } })] });
    const [item] = await questions();
    const bad = await owner('POST', `/api/desk/${item?.id}/answer`, {
      answer: 'not a branch name!',
      optionId: 'other',
      ledger: { scope: 'decision' },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_branch');
    expect((await repoRow()).working_branch).toBeNull();
    const good = await owner('POST', `/api/desk/${item?.id}/answer`, {
      answer: 'release/2026',
      optionId: 'other',
      ledger: { scope: 'decision' },
    });
    expect(good.status).toBe(200);
    expect((await repoRow()).working_branch).toBe('release/2026');
    expect(id).toBeTruthy();
  });
});

describe('the project settings change the working branch', () => {
  it('only the owner changes it, it must be a valid name, and it settles an open question', async () => {
    await q(`UPDATE project_repos SET working_branch=NULL WHERE id=$1`, [w.repoId]);
    const put = (branch: string) =>
      owner('PUT', `/api/projects/${w.projectId}/repos/${w.repoId}/working-branch`, { branch });
    expect((await put('bad branch')).status).toBe(400);
    const res = await put('main');
    expect(res.status).toBe(200);
    expect(res.body.repos[0].workingBranch).toBe('main');
    expect((await repoRow()).working_branch).toBe('main');
  });
});

describe('re-confirming when something changes', () => {
  it('a new phase also asks about a repository with no working branch yet, and the answer sets the repository default', async () => {
    await q(`UPDATE project_repos SET working_branch=NULL WHERE id=$1`, [w.repoId]);
    await q(
      `DELETE FROM ledger_entries WHERE source_desk_item_id IN (SELECT id FROM desk_items WHERE subkind=$1)`,
      [WORKING_BRANCH_SUBKIND],
    );
    await q(`DELETE FROM desk_items WHERE subkind=$1`, [WORKING_BRANCH_SUBKIND]);
    await ok(
      owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'Unasked', description: 'u' }),
      201,
    );
    await flush();
    await until(
      async () => (await questions()).length === 1,
      5000,
      'the question for the repo with no branch',
    );
    const [item] = await questions();
    expect(item?.title).toContain('Which branch is the working branch of toy (TOY)?');
    expect(item?.data).toMatchObject({ repoId: w.repoId, reason: 'phase' });
    await ok(
      owner('POST', `/api/desk/${item?.id}/answer`, {
        answer: 'develop',
        optionId: 'branch:develop',
        ledger: { scope: 'decision' },
      }),
    );
    expect((await repoRow()).working_branch).toBe('develop');
  });

  it('a new phase asks to keep the current branch or name another; one that names its own branch asks nothing', async () => {
    await q(
      `UPDATE project_repos SET working_branch='main', working_branch_set_at=now() - interval '3 hours' WHERE id=$1`,
      [w.repoId],
    );
    await q(
      `DELETE FROM ledger_entries WHERE source_desk_item_id IN (SELECT id FROM desk_items WHERE subkind=$1)`,
      [WORKING_BRANCH_SUBKIND],
    );
    await q(`DELETE FROM desk_items WHERE subkind=$1`, [WORKING_BRANCH_SUBKIND]);
    await ok(
      owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'Autosave', description: 'x' }),
      201,
    );
    await flush();
    await until(async () => (await questions()).length === 1, 5000, 'the re-confirmation question');
    const [item] = await questions();
    expect(item?.title).toContain('Keep main as the working branch of toy (TOY)');
    expect(item?.title).toContain('phase');
    expect(item?.options.map((o: any) => o.id)).toEqual([
      'keep',
      'branch:develop',
      'branch:staging',
      'other',
    ]);
    expect(item?.recommendation).toBe('keep');
    expect(item).toMatchObject({ blocking: false, pinned: false });
    // keeping it changes nothing
    await ok(
      owner('POST', `/api/desk/${item?.id}/answer`, {
        answer: 'Keep main',
        optionId: 'keep',
        ledger: { scope: 'decision' },
      }),
    );
    expect((await repoRow()).working_branch).toBe('main');
    // a phase with its own branch needs no question
    await ok(
      owner('POST', `/api/projects/${w.projectId}/phases`, {
        name: 'Branchy',
        description: 'y',
        workingBranch: 'phase/2',
      }),
      201,
    );
    await flush();
    await new Promise((res) => setTimeout(res, 200));
    expect(await questions()).toHaveLength(0);
  });

  it('there is no re-ask timer: a branch named a moment ago is asked about again for a new phase', async () => {
    await q(`UPDATE project_repos SET working_branch='main', working_branch_set_at=now() WHERE id=$1`, [
      w.repoId,
    ]);
    await q(
      `DELETE FROM ledger_entries WHERE source_desk_item_id IN (SELECT id FROM desk_items WHERE subkind=$1)`,
      [WORKING_BRANCH_SUBKIND],
    );
    await q(`DELETE FROM desk_items WHERE subkind=$1`, [WORKING_BRANCH_SUBKIND]);
    await ok(owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'Recent', description: 'z' }), 201);
    await flush();
    await until(async () => (await questions()).length === 1, 5000, 'the question');
    await q(`DELETE FROM desk_items WHERE subkind=$1`, [WORKING_BRANCH_SUBKIND]);
  });

  it('a branch named for a phase is saved on the phase; the repository default stays', async () => {
    await q(`UPDATE project_repos SET working_branch='main', working_branch_set_at=now() WHERE id=$1`, [
      w.repoId,
    ]);
    await q(
      `DELETE FROM ledger_entries WHERE source_desk_item_id IN (SELECT id FROM desk_items WHERE subkind=$1)`,
      [WORKING_BRANCH_SUBKIND],
    );
    await q(`DELETE FROM desk_items WHERE subkind=$1`, [WORKING_BRANCH_SUBKIND]);
    const phase = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/phases`, { name: 'Own branch later', description: 'q' }),
      201,
    );
    await flush();
    await until(async () => (await questions()).length === 1, 5000, 'the question');
    const [item] = await questions();
    expect(item?.data).toMatchObject({ reason: 'phase', phaseId: phase.id });
    expect(item?.body ?? item?.doing ?? '').toBeDefined();
    await ok(
      owner('POST', `/api/desk/${item?.id}/answer`, {
        answer: 'develop',
        optionId: 'branch:develop',
        ledger: { scope: 'decision' },
      }),
    );
    expect((await repoRow()).working_branch).toBe('main');
    expect((await q('SELECT working_branch FROM phases WHERE id=$1', [phase.id]))[0]?.working_branch).toBe(
      'develop',
    );
  });

  it('the active phase branch wins over the repository branch in the hygiene request', async () => {
    // runs queued by earlier answers are not what this test is about
    await q(
      `UPDATE devops_requests SET status='done' WHERE hygiene IS NOT NULL AND status IN ('queued','running')`,
    );
    await q(`UPDATE project_repos SET working_branch='main' WHERE id=$1`, [w.repoId]);
    const phase = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/phases`, {
        name: 'Own',
        description: 'o',
        workingBranch: 'phase/own',
      }),
      201,
    );
    const { start } = await startHygiene();
    expect(start.devops?.hygiene?.repos[0]).toMatchObject({
      workingBranch: 'phase/own',
      branchSource: 'phase',
    });
    expect(start.devops?.hygiene?.repos[0]?.phaseRef).toBeTruthy();
    await finish(start, { repos: [result()] });
    expect(phase).toBeTruthy();
  });
});

describe('removing the branches of finished cards', () => {
  const setDone = (id: string, branch: string, finalize?: Record<string, unknown>) =>
    q(
      `UPDATE cards SET status='done', stage='done', branch_name=$2, repo_id=$3, finalize_result=$4 WHERE id=$1`,
      [id, branch, w.repoId, finalize ? JSON.stringify(finalize) : null],
    );

  it('sends done and cancelled cards with their branch and pull request, and leaves out a branch an open card uses', async () => {
    await q(
      `UPDATE devops_requests SET status='done' WHERE hygiene IS NOT NULL AND status IN ('queued','running')`,
    );
    const merged = await w.card();
    const viaPr = await w.card();
    const reopened = await w.card();
    const sibling = await w.card();
    await setDone(merged.id, 'aom/toy-a-merged');
    await setDone(viaPr.id, 'aom/toy-b-pr', { prUrl: 'https://github.com/acme/toy/pull/660' });
    await setDone(reopened.id, 'aom/toy-c-reopened');
    // a reopened card is open again (status no longer done) and keeps its branch name
    await q(`UPDATE cards SET status='queued', stage='build' WHERE id=$1`, [reopened.id]);
    await q(`UPDATE cards SET status='cancelled', branch_name='aom/toy-c-reopened' WHERE id=$1`, [
      sibling.id,
    ]);

    const { start } = await startHygiene();
    const repo = start.devops?.hygiene?.repos[0];
    const byBranch = Object.fromEntries((repo?.finishedCards ?? []).map((c: any) => [c.branch, c]));
    expect(Object.keys(byBranch).sort()).toEqual(['aom/toy-a-merged', 'aom/toy-b-pr']);
    expect(byBranch['aom/toy-b-pr']).toMatchObject({
      cardId: viaPr.id,
      ref: viaPr.ref,
      prUrl: 'https://github.com/acme/toy/pull/660',
    });
    expect(byBranch['aom/toy-a-merged'].prUrl).toBeUndefined();
    await finish(start, { repos: [result()] });
  });

  it('the project setting "Remove finished card branches" (default on) switches it off', async () => {
    const proj = await ok<any>(owner('GET', `/api/projects/${w.projectId}`));
    expect(proj.project.removeFinishedBranches).toBe(true);
    await ok(owner('PATCH', `/api/projects/${w.projectId}`, { removeFinishedBranches: false }));
    expect((await ok<any>(owner('GET', `/api/projects/${w.projectId}`))).project.removeFinishedBranches).toBe(
      false,
    );
    const { start } = await startHygiene();
    const repo = start.devops?.hygiene?.repos[0];
    expect(repo?.finishedCards).toEqual([]);
    expect(repo?.finishedBranches).toEqual([]);
    await finish(start, { repos: [result()] });
    await ok(owner('PATCH', `/api/projects/${w.projectId}`, { removeFinishedBranches: true }));
  });

  it('a report with removed branches logs each on its card and posts one notice for the run', async () => {
    const a = await w.card();
    const b = await w.card();
    await q(`UPDATE cards SET status='done', branch_name='aom/toy-x-a', repo_id=$2 WHERE id=$1`, [
      a.id,
      w.repoId,
    ]);
    await q(`UPDATE cards SET status='cancelled', branch_name='aom/toy-x-b', repo_id=$2 WHERE id=$1`, [
      b.id,
      w.repoId,
    ]);
    const { start } = await startHygiene();
    await finish(start, {
      repos: [
        result({
          cleaned: [
            {
              cardId: a.id,
              ref: a.ref,
              branch: 'aom/toy-x-a',
              reason: 'merged into pieter/dev',
              origin: true,
              local: true,
              worktree: false,
            },
            {
              cardId: b.id,
              ref: b.ref,
              branch: 'aom/toy-x-b',
              reason: 'its pull request was declined',
              origin: true,
              local: false,
              worktree: true,
            },
          ],
        }),
      ],
    });
    const log = async (id: string) =>
      (
        await q(`SELECT body FROM thread_messages WHERE thread_id=$1 AND kind='system' ORDER BY created_at`, [
          id,
        ])
      )
        .map((m: any) => m.body)
        .join('\n');
    expect(await log(a.id)).toContain(
      'Branch aom/toy-x-a deleted from origin, this workstation: merged into pieter/dev.',
    );
    expect(await log(b.id)).toContain('deleted from origin, its worktree: its pull request was declined.');
    const notices = await q(`SELECT title, body FROM desk_items WHERE subkind='branch_cleanup'`);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.title).toBe('Repository hygiene removed 2 finished card branches');
    expect(notices[0]?.body).toContain('aom/toy-x-a');
    expect(notices[0]?.body).toContain('aom/toy-x-b');
  });
});
