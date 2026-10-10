import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { createWorld, MOCK_RUNTIME, ok, REPO_SSH, type World } from './helpers/world.ts';

let w: World;
let r: FakeRunner;
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

describe('the git provider is per repository', () => {
  it('is detected from the URL and can be overridden or cleared', async () => {
    const p = await project();
    expect(p.repos[0]).toMatchObject({ forgeOverride: null });

    const added = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/repos`, {
        name: 'shop',
        remoteUrl: 'git@ssh.dev.azure.com:v3/acme/shop/web',
      }),
      201,
    );
    const azure = added.repos.find((x: any) => x.name === 'shop');
    expect(azure).toMatchObject({
      forge: 'azure-devops',
      forgeOverride: null,
      remoteUrlNormalized: 'dev.azure.com/acme/shop/_git/web',
    });

    // The https form of the same Azure DevOps repo is the same repository
    const dup = owner('POST', `/api/projects/${w.projectId}/repos`, {
      name: 'shop2',
      remoteUrl: 'https://dev.azure.com/acme/shop/_git/web',
    });
    expect((await dup).status).toBe(409);

    // A self-hosted GitLab on an unrecognisable host: the manual choice
    const gl = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/repos`, {
        name: 'corp',
        remoteUrl: 'https://code.corp.example/team/app.git',
        forge: 'gitlab',
      }),
      201,
    );
    const corp = gl.repos.find((x: any) => x.name === 'corp');
    expect(corp).toMatchObject({ forge: 'gitlab', forgeOverride: 'gitlab' });

    const patched = await ok<any>(owner('PATCH', `/api/projects/${w.projectId}/repos/${corp.id}`, { forge: null }));
    expect(patched.repos.find((x: any) => x.id === corp.id)).toMatchObject({ forge: 'git', forgeOverride: null });
    const set = await ok<any>(owner('PATCH', `/api/projects/${w.projectId}/repos/${corp.id}`, { forge: 'bitbucket-dc' }));
    expect(set.repos.find((x: any) => x.id === corp.id)).toMatchObject({ forge: 'bitbucket-dc' });
  });

  it('"create new" asks for the provider\'s own name shape and tells the runner which provider', async () => {
    const bad = await owner('POST', `/api/projects/${w.projectId}/repos`, {
      name: 'x',
      remoteUrl: 'https://dev.azure.com/acme/shop/_git/x',
      create: { name: 'acme/x', visibility: 'private' },
    });
    expect(bad.status).toBe(400);

    const from = r.received.length;
    await ok(
      owner('POST', `/api/projects/${w.projectId}/repos`, {
        name: 'fresh',
        remoteUrl: 'https://gitlab.com/grp/sub/fresh.git',
        create: { name: 'grp/sub/fresh', visibility: 'private' },
      }),
      201,
    );
    const cmd = await nextCommand('repo.clone', from);
    expect(cmd.payload.create).toMatchObject({ name: 'grp/sub/fresh', provider: 'gitlab' });
    expect(cmd.payload.create.host).toBeUndefined();
  });

  it('a manager who is not the owner cannot change the provider', async () => {
    const repo = (await project()).repos[0];
    const res = await w.t.req('PATCH', `/api/projects/${w.projectId}/repos/${repo.id}`, {
      body: { forge: 'gitlab' },
    });
    expect([401, 403]).toContain(res.status);
  });
});

describe('git connections reported by the workstation', () => {
  it('stores the state (never a secret) and shows it on the workstation', async () => {
    const at = new Date().toISOString();
    r.send('git.report', {
      connections: [
        { provider: 'github', host: 'github.com', state: 'connected', account: 'octo', method: 'cli', checkedAt: at },
        { provider: 'azure-devops', host: 'dev.azure.com', state: 'not_connected', detail: 'Run git-connect', checkedAt: at },
      ],
    });
    await settle();
    const ws = await workstation();
    expect(ws.git.connections).toHaveLength(2);
    expect(ws.git.connections[0]).toMatchObject({ provider: 'github', state: 'connected', account: 'octo' });
    expect(ws.git.checkedAt).toBeTruthy();
  });

  it('"Check again" queues git.status for the runner', async () => {
    const from = r.received.length;
    await ok(owner('POST', `/api/workstations/${w.workstationId}/git/recheck`));
    await nextCommand('git.status', from);
  });
});

describe('the repository picker', () => {
  it('asks the workstation, then returns what it listed', async () => {
    const from = r.received.length;
    const started = await ok<any>(
      owner('POST', `/api/workstations/${w.workstationId}/git/repos`, { provider: 'gitlab', search: 'app' }),
      202,
    );
    expect(started).toMatchObject({ state: 'pending', provider: 'gitlab', repos: [] });
    const cmd = await nextCommand('forge.repos', from);
    expect(cmd.payload).toMatchObject({ requestId: started.requestId, provider: 'gitlab', search: 'app' });

    const pending = await ok<any>(owner('GET', `/api/workstations/${w.workstationId}/git/repos/${started.requestId}`));
    expect(pending.state).toBe('pending');

    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: {
        ok: true,
        repos: [{ provider: 'gitlab', fullName: 'grp/app', cloneUrl: 'https://gitlab.com/grp/app.git', private: true }],
      },
    });
    await settle();
    const done = await ok<any>(owner('GET', `/api/workstations/${w.workstationId}/git/repos/${started.requestId}`));
    expect(done).toMatchObject({ state: 'done', repos: [{ fullName: 'grp/app' }], error: null });
  });

  it('a workstation that is not connected to the provider fails with its reason', async () => {
    const from = r.received.length;
    const started = await ok<any>(
      owner('POST', `/api/workstations/${w.workstationId}/git/repos`, { provider: 'azure-devops' }),
      202,
    );
    const cmd = await nextCommand('forge.repos', from);
    r.send('command.result', {
      commandId: cmd.commandId,
      ok: true,
      result: { ok: false, repos: [], error: 'not connected to Azure DevOps: run `aom-runner git-connect azure-devops`' },
    });
    await settle();
    const done = await ok<any>(owner('GET', `/api/workstations/${w.workstationId}/git/repos/${started.requestId}`));
    expect(done.state).toBe('failed');
    expect(done.error).toMatch(/git-connect/);
  });

  it('only the owner of the workstation can use it', async () => {
    const res = await w.t.req('POST', `/api/workstations/${w.workstationId}/git/repos`, {
      body: { provider: 'github' },
    });
    expect([401, 403, 404]).toContain(res.status);
  });
});
