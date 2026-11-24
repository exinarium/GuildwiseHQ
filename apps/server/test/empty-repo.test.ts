import { DESK_SUBKIND, WORKING_BRANCH_SUBKIND } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { addMember } from './helpers/members.ts';
import { pipeline } from './helpers/pipeline.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, MOCK_RUNTIME, ok, REPO_SSH, type World } from './helpers/world.ts';

/**
 * uat-runner-fixes-3 finding 5: an empty bare repository (no commits, HEAD -> master, working branch main) gave four shifts
 * worktree_failed "working branch 'main' does not exist" and a question about which branch is the working branch, before
 * the CEO escalated to DevOps. Now: the cards wait on the environment and the owner gets ONE desk item with a one-click
 * "Create the first commit on main", which the runner does.
 */

let w: World;
let r: FakeRunner;
let p: ReturnType<typeof pipeline>;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  r = await w.connectRunner({ hello: false });
  r.hello({
    repos: [{ remoteUrl: REPO_SSH, localPath: '/tmp/toy', headBranch: 'main' }],
    runtimes: MOCK_RUNTIME,
    sudoKey: { keyId: 'abcd1234abcd1234', publicKey: 'AAAA' },
  });
  await r.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
  p = pipeline(w, r);
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const nextCommand = (type: string, from = 0) =>
  r
    .waitFor('command', (c) => c.command === type, 5000, from)
    .then(async (c) => {
      await r.barrier();
      return c;
    });
const answer = (commandId: string, result: unknown) =>
  r.send('command.result', { commandId, ok: true, result });
const settle = async () => {
  await r.barrier();
  await w.t.app.ctx.notifier.flush();
};
const items = (subkind: string, status = 'open') =>
  q(`SELECT * FROM desk_items WHERE subkind=$1 AND status=$2 ORDER BY created_at`, [subkind, status]);
const emptyReport = (branch = 'main') => ({
  state: 'failed',
  stacks: [],
  tools: [
    {
      stack: 'repository',
      tool: 'toy',
      status: 'failed',
      detail: 'the repository is empty: it has no commits yet',
    },
  ],
  summary: 'Not ready: toy (the repository is empty: it has no commits yet)',
  logTail: [],
  emptyRepos: [{ repoId: w.repoId, name: 'toy', branch }],
});

async function reset() {
  await freshState();
  await q('DELETE FROM project_environments');
  await q(`DELETE FROM desk_items WHERE subkind = ANY($1)`, [
    [DESK_SUBKIND.repoEmpty, WORKING_BRANCH_SUBKIND, DESK_SUBKIND.environmentAttention],
  ]);
  await q(`UPDATE project_repos SET working_branch='main' WHERE id=$1`, [w.repoId]);
}

describe('an empty repository', () => {
  it('a shift turned away on an empty repository: no branch question, the environment is checked, one desk item', async () => {
    await reset();
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'First feature' });
    const from = r.received.length;
    w.t.app.ctx.services.dispatcher.cooldown.clear();
    await p.reject('Bea', 'worktree_failed', {
      detail:
        "working branch 'main' does not exist in this repo; creating it failed: the default branch 'master' has no commits",
      branchProblem: { base: 'main', defaultBranch: 'master', branches: [], emptyRepository: true },
    });
    expect(await items(WORKING_BRANCH_SUBKIND)).toEqual([]);
    const [item, ...rest] = await items(DESK_SUBKIND.repoEmpty);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ kind: 'alert', title: 'toy has no commits yet' });
    expect(item?.body).toContain('Create the first commit on main');
    expect(item?.data).toMatchObject({ repoId: w.repoId, workstationId: w.workstationId, branch: 'main' });
    // the environment is checked again (with the working branch), so the cards wait on it instead of failing shifts
    const env = await nextCommand('env.ensure', from);
    expect((env.payload as any).repos.find((x: any) => x.name === 'toy').workingBranch).toBe('main');
    const row = (await q('SELECT state FROM project_environments WHERE project_id=$1', [w.projectId]))[0];
    expect(row?.state).toBe('preparing');
    // the runner's report: still one item, and no second "environment" notice for the same thing
    answer(env.commandId, emptyReport());
    await settle();
    expect(await items(DESK_SUBKIND.repoEmpty)).toHaveLength(1);
    expect(await items(DESK_SUBKIND.environmentAttention)).toEqual([]);
    expect(
      (await q('SELECT state FROM project_environments WHERE project_id=$1', [w.projectId]))[0]?.state,
    ).toBe('failed');
    // the card is held back, not dispatched again
    await q('UPDATE cards SET retry_after=NULL WHERE id=$1', [card.id]);
    w.t.app.ctx.services.dispatcher.cooldown.clear();
    const starts = r.of('shift.start').length;
    await w.t.app.ctx.services.dispatcher.run();
    await r.barrier();
    expect(r.of('shift.start').length).toBe(starts);
  });

  it('the one click: repo.initial_commit with the branch and Commit as; done closes the item and checks again', async () => {
    await reset();
    await owner('PUT', `/api/projects/${w.projectId}/commit-as`, {
      commitAs: { name: 'Pieter', email: 'pieter@example.test' },
    });
    const from = r.received.length;
    await ok(owner('POST', `/api/projects/${w.projectId}/environment/check`));
    const env = await nextCommand('env.ensure', from);
    answer(env.commandId, emptyReport());
    await settle();
    expect(await items(DESK_SUBKIND.repoEmpty)).toHaveLength(1);

    const before = r.received.length;
    await ok(
      owner('POST', `/api/projects/${w.projectId}/repos/${w.repoId}/initial-commit`, {
        workstationId: w.workstationId,
      }),
    );
    const cmd = await nextCommand('repo.initial_commit', before);
    expect(cmd.payload).toMatchObject({
      projectId: w.projectId,
      repoId: w.repoId,
      branch: 'main',
      commitAs: { name: 'Pieter', email: 'pieter@example.test' },
    });
    // a refusal says why on a fresh item
    answer(cmd.commandId, { ok: false, error: 'could not push the first commit to origin (denied)' });
    await settle();
    const [again] = await items(DESK_SUBKIND.repoEmpty);
    expect(again?.body).toContain('The first commit was not made: could not push');
    // the second click works: the item closes and the environment is checked again
    const before2 = r.received.length;
    await ok(
      owner('POST', `/api/projects/${w.projectId}/repos/${w.repoId}/initial-commit`, {
        workstationId: w.workstationId,
      }),
    );
    const cmd2 = await nextCommand('repo.initial_commit', before2);
    answer(cmd2.commandId, { ok: true, sha: 'a'.repeat(40), branch: 'main' });
    await settle();
    expect(await items(DESK_SUBKIND.repoEmpty)).toEqual([]);
    const recheck = await nextCommand('env.ensure', before2);
    answer(recheck.commandId, { state: 'ready', stacks: [], tools: [], summary: 'Ready', logTail: [] });
    await settle();
    expect(
      (await q('SELECT state FROM project_environments WHERE project_id=$1', [w.projectId]))[0]?.state,
    ).toBe('ready');
  });

  it('only the project owner, and only for a repository reported empty', async () => {
    await reset();
    const stranger = await w.t.userSession('stranger-empty@example.test');
    const res = await w.t.req('POST', `/api/projects/${w.projectId}/repos/${w.repoId}/initial-commit`, {
      cookie: stranger.cookie,
      body: { workstationId: w.workstationId },
    });
    // REVIEW N2: exact statuses (a 500 must not pass), and a member of the project who is not its owner is refused too
    expect(res.status).toBe(404);
    const member = await addMember(w, 'member-empty');
    const byMember = await w.t.req('POST', `/api/projects/${w.projectId}/repos/${w.repoId}/initial-commit`, {
      cookie: member.cookie,
      body: { workstationId: w.workstationId },
    });
    expect(byMember.status).toBe(403);
    const notEmpty = await owner('POST', `/api/projects/${w.projectId}/repos/${w.repoId}/initial-commit`, {
      workstationId: w.workstationId,
    });
    expect(notEmpty.status).toBe(409);
  });
});

describe('"Commit as" asked up front (finding 6)', () => {
  it('a new project created with Commit as has it set', async () => {
    const created = await ok<any>(
      owner('POST', '/api/projects', {
        key: 'CMA',
        name: 'Commit up front',
        commitAs: { name: 'Pieter', email: 'pieter@example.test' },
      }),
      201,
    );
    const id = created.project.id;
    expect(await ok<any>(owner('GET', `/api/projects/${id}/commit-as`))).toMatchObject({
      commitAs: { name: 'Pieter', email: 'pieter@example.test' },
    });
    expect(
      (
        await owner('POST', '/api/projects', {
          key: 'CMB',
          name: 'Bad',
          commitAs: { name: 'x', email: 'nope' },
        })
      ).status,
    ).toBe(400);
  });
});
