import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, MOCK_RUNTIME, ok, REPO_SSH, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
beforeAll(async () => {
  w = await createWorld({ env: { AOM_FIRST_RUN_HIRE_CAP: 'false' } });
  // A runner of this version announces the key for the sudo password in hello.
  r = await w.connectRunner({ hello: false });
  r.hello({
    repos: [{ remoteUrl: REPO_SSH, localPath: '/tmp/toy', headBranch: 'main' }],
    runtimes: MOCK_RUNTIME,
    sudoKey: { keyId: 'abcd1234abcd1234', publicKey: 'AAAA' },
  });
  await r.waitFor('welcome');
  await w.t.app.ctx.notifier.flush();
});
afterAll(async () => {
  r.close();
  await w.t.close();
  await closeAdminPool();
});

const owner = (method: string, url: string, body?: unknown) =>
  w.t.req(method, url, { cookie: w.owner.cookie, body });
const project = () => ok<any>(owner('GET', `/api/projects/${w.projectId}`));
const workstation = async () =>
  (await ok<any>(owner('GET', '/api/workstations'))).workstations.find((x: any) => x.id === w.workstationId);
const commands = (type: string) => r.of('command').filter((c) => c.command === type);
const nextCommand = (type: string, from = 0) =>
  r
    .waitFor('command', (c) => c.command === type, 5000, from)
    .then(async (c) => {
      await r.barrier();
      return c;
    });
const answer = (commandId: string, result: unknown, ok_ = true) =>
  r.send('command.result', { commandId, ok: ok_, ...(ok_ ? { result } : { error: String(result) }) });
const settle = async () => {
  await r.barrier();
  await w.t.app.ctx.notifier.flush();
};
const reportRepos = (...urls: string[]) => {
  r.send('repos.report', {
    repos: urls.map((u) => ({ remoteUrl: u, localPath: `/tmp/${u.split('/').pop()}`, headBranch: 'main' })),
  });
  return settle();
};

describe('the toolchain is prepared before build work', () => {
  it('a repository that appears on a workstation queues env.ensure and holds the build cards until it is ready', async () => {
    await freshState();
    await q('DELETE FROM project_environments');
    await w.hire('Bea', 'builder', 'junior');
    const card = await w.card({ title: 'Needs tools' });
    const from = r.received.length;
    // The workstation's repository set changes: the toy repo is reported again as new (it was never matched in this test).
    await q('DELETE FROM workstation_repos WHERE workstation_id=$1', [w.workstationId]);
    await reportRepos('git@github.com:acme/toy.git');
    const env = await nextCommand('env.ensure', from);
    expect(env.payload).toMatchObject({ projectId: w.projectId, access: { allowInstall: false } });
    expect((env.payload as any).repos.map((x: any) => x.name)).toContain('toy');
    const row = (await q('SELECT * FROM project_environments WHERE project_id=$1', [w.projectId]))[0];
    expect(row?.state).toBe('preparing');

    // while preparing the card is not dispatched and says why
    w.t.app.ctx.services.dispatcher.cooldown.clear();
    await w.t.app.ctx.services.dispatcher.run();
    await r.barrier();
    expect(r.of('shift.start').filter((s) => s.brief.card.id === card.id)).toEqual([]);
    const wk = (await ok<any>(owner('GET', `/api/cards/${card.id}`))).workability;
    expect(wk.ok).toBe(false);
    expect(wk.reason).toContain('development environment');
    expect(wk.reason).toContain('Desk');

    // the runner says what is missing: still held, with the fix on the project page
    answer(env.commandId, {
      state: 'needs_access',
      stacks: [{ id: 'dotnet-maui', name: '.NET MAUI', repo: 'toy' }],
      tools: [
        {
          stack: 'dotnet-maui',
          tool: '.NET SDK',
          status: 'needs_access',
          detail: 'not found',
          fix: 'Allow "Install packages and tools"',
        },
      ],
      summary: 'Needs access: .NET SDK (not found)',
      logTail: [],
    });
    await settle();
    const detail = await project();
    expect(detail.environments).toMatchObject([
      { workstationName: 'Desk', state: 'needs_access', summary: 'Needs access: .NET SDK (not found)' },
    ]);
    expect(detail.environments[0].report.tools[0].fix).toContain('Install packages');
    const again = (await ok<any>(owner('GET', `/api/cards/${card.id}`))).workability;
    expect(again.reason).toContain('Needs access: .NET SDK');

    // ticking the access re-runs the preparation; ready lets the card go
    const before = r.received.length;
    await ok(owner('PATCH', `/api/workstations/${w.workstationId}/devops-access`, { allowInstall: true }));
    const second = await nextCommand('env.ensure', before);
    expect((second.payload as any).access.allowInstall).toBe(true);
    answer(second.commandId, {
      state: 'ready',
      stacks: [],
      tools: [],
      summary: 'Ready: .NET MAUI',
      logTail: [],
    });
    await settle();
    await w.t.app.ctx.services.dispatcher.run();
    const start = await r.waitFor('shift.start', (s) => s.brief.card.id === card.id, 5000, before);
    expect(start.agent.name).toBe('Bea');
  });

  it('a project that was never prepared is not held back', async () => {
    await freshState();
    await q('DELETE FROM project_environments');
    await w.hire('Cy', 'builder', 'junior');
    const card = await w.card({ title: 'Unmanaged' });
    const from = r.received.length;
    w.t.app.ctx.services.dispatcher.cooldown.clear();
    await w.t.app.ctx.services.dispatcher.run();
    await r.waitFor('shift.start', (s) => s.brief.card.id === card.id, 5000, from);
  });
});
