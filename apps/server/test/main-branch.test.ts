import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, ok, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld();
  r = await w.connectRunner();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const project = () => ok<any>(owner('GET', `/api/projects/${w.projectId}`));
const toy = async () => (await project()).repos.find((x: any) => x.id === w.repoId);
const repoUrl = () => `/api/projects/${w.projectId}/repos/${w.repoId}`;
const settle = async () => {
  await r.barrier();
  await w.t.app.ctx.notifier.flush();
};
const nextCommand = (type: string, from = 0) =>
  r
    .waitFor('command', (c) => c.command === type, 5000, from)
    .then(async (c) => {
      await r.barrier();
      return c;
    });

describe('the main branch of a repository', () => {
  it('defaults to the repository default branch (null), can be named, and cleared', async () => {
    expect(await toy()).toMatchObject({ mainBranch: null, workingBranchCreated: null });
    const set = await owner('PATCH', repoUrl(), { mainBranch: 'release' });
    expect(set.status).toBe(200);
    expect(set.body.repos[0].mainBranch).toBe('release');
    const events = await q(`SELECT payload FROM events WHERE type='ProjectRepoMainBranchSet'`);
    expect(events.at(-1)?.payload).toMatchObject({ repoId: w.repoId, mainBranch: 'release' });
    const cleared = await owner('PATCH', repoUrl(), { mainBranch: null });
    expect(cleared.body.repos[0].mainBranch).toBeNull();
  });

  it('is validated and owner only', async () => {
    expect((await owner('PATCH', repoUrl(), { mainBranch: '--force' })).status).toBe(400);
    expect((await owner('PATCH', repoUrl(), { mainBranch: 'a..b' })).status).toBe(400);
    const stranger = await w.t.userSession(`stranger-${Date.now()}@example.test`);
    const denied = await w.t.req('PATCH', repoUrl(), { cookie: stranger.cookie, body: { mainBranch: 'x' } });
    expect(denied.status).toBeGreaterThanOrEqual(403);
  });

  it('can be named when the repository is added, and old events without it stay valid', async () => {
    const add = await owner('POST', `/api/projects/${w.projectId}/repos`, {
      name: 'api',
      remoteUrl: 'https://github.com/acme/api.git',
      mainBranch: 'trunk',
      workingBranch: 'develop',
    });
    expect(add.status).toBe(201);
    const repo = add.body.repos.find((x: any) => x.name === 'api');
    expect(repo).toMatchObject({ mainBranch: 'trunk', workingBranch: 'develop' });
    // the toy repository was added without a main branch: its projection row has none
    const [toy] = await q('SELECT main_branch FROM project_repos WHERE id=$1', [w.repoId]);
    expect(toy?.main_branch).toBeNull();
  });
});

describe('open a pull request from the working branch to the main branch', () => {
  it('queues repo.open_pr on a workstation that has the repository, then shows the answer', async () => {
    await owner('PATCH', repoUrl(), { mainBranch: 'release' });
    await owner('PUT', `${repoUrl()}/working-branch`, { branch: 'develop' });
    const from = r.received.length;
    const asked = await owner('POST', `${repoUrl()}/release-pr`);
    expect(asked.status).toBe(202);
    const cmd = await nextCommand('repo.open_pr', from);
    expect(cmd.payload).toMatchObject({
      requestId: asked.body.requestId,
      repoId: w.repoId,
      head: 'develop',
      base: 'release',
    });
    expect((await toy()).releasePr).toMatchObject({ state: 'pending' });
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, base: 'release', url: 'https://github.com/acme/toy/pull/12' },
    });
    await settle();
    expect((await toy()).releasePr).toMatchObject({
      state: 'opened',
      url: 'https://github.com/acme/toy/pull/12',
    });
  });

  it('a runner that finds nothing to open, or fails, is reported', async () => {
    let from = r.received.length;
    await owner('POST', `${repoUrl()}/release-pr`);
    let cmd = await nextCommand('repo.open_pr', from);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: true, nothingToDo: true, notice: 'Nothing new on the working branch.' },
    });
    await settle();
    expect((await toy()).releasePr).toMatchObject({
      state: 'nothing',
      message: 'Nothing new on the working branch.',
    });
    from = r.received.length;
    await owner('POST', `${repoUrl()}/release-pr`);
    cmd = await nextCommand('repo.open_pr', from);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: false, error: 'the main branch does not exist' },
    });
    await settle();
    expect((await toy()).releasePr).toMatchObject({
      state: 'failed',
      message: 'the main branch does not exist',
    });
  });

  it('refuses when working and main branch are the same, and for non-owners', async () => {
    await owner('PATCH', repoUrl(), { mainBranch: 'develop' });
    const same = await owner('POST', `${repoUrl()}/release-pr`);
    expect(same.status).toBe(409);
    expect(same.body.error?.message ?? same.body.message ?? '').toMatch(/nothing to open a pull request/);
    const stranger = await w.t.userSession(`stranger2-${Date.now()}@example.test`);
    const denied = await w.t.req('POST', `${repoUrl()}/release-pr`, { cookie: stranger.cookie });
    expect(denied.status).toBeGreaterThanOrEqual(403);
  });
});
