import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeAdminPool, q } from './helpers/db.ts';
import type { FakeRunner } from './helpers/fake-runner.ts';
import { freshState } from './helpers/shifts.ts';
import { createWorld, MOCK_RUNTIME, ok, REPO_SSH, until, type World } from './helpers/world.ts';

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

const SECOND = 'https://github.com/acme/second.git';
const SECOND_SSH = 'git@github.com:acme/second.git';

describe('a repository added to a project is cloned', () => {
  it('queues repo.clone for the workstation, shows Cloning, then Cloned', async () => {
    const from = r.received.length;
    const added = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/repos`, { name: 'second', remoteUrl: SECOND }),
      201,
    );
    const repo = added.repos.find((x: any) => x.name === 'second');
    expect(repo.setup).toMatchObject([{ state: 'cloning', workstationName: 'Desk' }]);

    const cmd = await nextCommand('repo.clone', from);
    expect(cmd.payload).toMatchObject({
      repoId: repo.id,
      projectId: w.projectId,
      projectKey: 'TOY',
      remoteUrl: SECOND,
      name: 'second',
    });
    expect(cmd.payload.create).toBeUndefined();

    answer(cmd.commandId, {
      ok: true,
      state: 'cloned',
      localPath: '/tmp/second',
      detail: 'Cloned to /tmp/second',
    });
    await settle();
    const after = (await project()).repos.find((x: any) => x.name === 'second');
    expect(after.setup).toMatchObject([
      { state: 'cloned', detail: 'Cloned to /tmp/second', localPath: '/tmp/second' },
    ]);
  });

  it('a failed clone shows the reason and "Try again" queues it again', async () => {
    const from = r.received.length;
    await ok(
      owner('POST', `/api/projects/${w.projectId}/repos`, {
        name: 'gone',
        remoteUrl: 'https://github.com/acme/gone.git',
      }),
      201,
    );
    const cmd = await nextCommand('repo.clone', from);
    answer(cmd.commandId, { ok: false, state: 'failed', error: 'the repository does not exist' });
    await settle();
    const p = await project();
    const repo = p.repos.find((x: any) => x.name === 'gone');
    expect(repo.setup[0]).toMatchObject({ state: 'failed', detail: 'the repository does not exist' });

    const before = r.received.length;
    await ok(owner('POST', `/api/projects/${w.projectId}/repos/${repo.id}/setup`));
    const again = await nextCommand('repo.clone', before);
    expect(again.commandId).not.toBe(cmd.commandId);
    expect((await project()).repos.find((x: any) => x.name === 'gone').setup[0].state).toBe('cloning');
  });

  it('"create new" is sent to one workstation with the manager\'s choices, and kept for a retry', async () => {
    const from = r.received.length;
    const added = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/repos`, {
        name: 'brandnew',
        remoteUrl: 'https://github.com/acme/brandnew.git',
        workingBranch: 'develop',
        create: { name: 'acme/brandnew', visibility: 'public', description: 'hello' },
      }),
      201,
    );
    const cmd = await nextCommand('repo.clone', from);
    expect(cmd.payload).toMatchObject({
      workingBranch: 'develop',
      create: { name: 'acme/brandnew', visibility: 'public', description: 'hello' },
    });
    answer(cmd.commandId, {
      ok: false,
      state: 'needs_manager',
      error: 'gh is not installed on this workstation',
    });
    await settle();
    const repo = (await project()).repos.find((x: any) => x.name === 'brandnew');
    expect(repo.setup[0]).toMatchObject({ state: 'needs_manager' });
    const before = r.received.length;
    await ok(owner('POST', `/api/projects/${w.projectId}/repos/${repo.id}/setup`));
    const retry = await nextCommand('repo.clone', before);
    expect(retry.payload.create).toMatchObject({ name: 'acme/brandnew', visibility: 'public' });
    expect(added.repos.some((x: any) => x.name === 'brandnew')).toBe(true);
  });

  it('a workstation that already reports the clone is recorded as cloned without a command', async () => {
    await reportRepos(SECOND_SSH, 'git@github.com:acme/known.git');
    const from = r.received.length;
    const added = await ok<any>(
      owner('POST', `/api/projects/${w.projectId}/repos`, {
        name: 'known',
        remoteUrl: 'https://github.com/acme/known.git',
      }),
      201,
    );
    const repo = added.repos.find((x: any) => x.name === 'known');
    // The runner's report predates the project repo: the next report matches it.
    await reportRepos(SECOND_SSH, 'git@github.com:acme/known.git');
    await settle();
    expect(
      r
        .of('command')
        .slice(from)
        .filter((c) => c.command === 'repo.clone').length,
    ).toBeLessThanOrEqual(1);
    expect(repo.id).toBeTruthy();
  });
});

describe('rights and the sudo password', () => {
  it('ticking a right queues a check; the result shows as verified or failed, stale after the next change', async () => {
    const from = r.received.length;
    await ok(
      owner('PATCH', `/api/workstations/${w.workstationId}/devops-access`, { allowDocker: true, sudo: true }),
    );
    const cmd = await nextCommand('rights.verify', from);
    expect(cmd.payload.access).toMatchObject({ allowDocker: true, sudo: true });
    answer(cmd.commandId, {
      checkedAt: new Date().toISOString(),
      platform: 'linux',
      checks: {
        docker: { status: 'failed', reason: 'permission denied', fix: 'usermod -aG docker $USER' },
        sudo: { status: 'verified', reason: 'sudo works without a password for this user' },
      },
      sudoPasswordStored: false,
    });
    await settle();
    let ws = await workstation();
    expect(ws.rights.checks.docker).toMatchObject({ status: 'failed', fix: 'usermod -aG docker $USER' });
    expect(ws.rights.checks.sudo.status).toBe('verified');
    expect(ws.rights.stale).toBe(false);
    await ok(owner('PATCH', `/api/workstations/${w.workstationId}/devops-access`, { allowDocker: false }));
    ws = await workstation();
    expect(ws.rights.stale).toBe(true);
  });

  it('the sudo password travels as ciphertext only: relayed, forgotten, never an event', async () => {
    r.hello({ repos: [], runtimes: MOCK_RUNTIME, sudoKey: { keyId: 'abcd1234abcd1234', publicKey: 'AAAA' } });
    await settle();
    await until(async () => (await q('SELECT 1 FROM workstation_keys'))[0], 5000, 'key stored');
    expect(await ok(owner('GET', `/api/workstations/${w.workstationId}/sudo-key`))).toEqual({
      keyId: 'abcd1234abcd1234',
      publicKey: 'AAAA',
    });

    // a stale key is refused
    const stale = await owner('PUT', `/api/workstations/${w.workstationId}/sudo-password`, {
      ciphertext: 'Zm9v',
      keyId: 'old',
    });
    expect(stale.status).toBe(409);

    const from = r.received.length;
    const res = await owner('PUT', `/api/workstations/${w.workstationId}/sudo-password`, {
      ciphertext: 'U0VDUkVULUNJUEhFUlRFWFQ=',
      keyId: 'abcd1234abcd1234',
    });
    expect(res.status).toBe(202);
    const cmd = await nextCommand('sudo.set', from);
    expect(cmd.payload).toEqual({ ciphertext: 'U0VDUkVULUNJUEhFUlRFWFQ=', keyId: 'abcd1234abcd1234' });

    answer(cmd.commandId, { stored: true, works: true });
    await settle();
    // the ciphertext is gone from the queue and was never in an event
    const queued = await q('SELECT payload FROM runner_commands WHERE id=$1', [cmd.commandId]);
    expect(queued[0]?.payload).toEqual({});
    const leaked = await q(`SELECT 1 FROM events WHERE payload::text LIKE '%U0VDUkVULUNJUEhFUlRFWFQ%'`);
    expect(leaked).toEqual([]);
    const ev = await q(
      `SELECT payload FROM events WHERE type='DevOpsSudoPasswordSet' ORDER BY seq DESC LIMIT 1`,
    );
    expect(ev[0]?.payload).toMatchObject({
      workstationId: w.workstationId,
      keyId: 'abcd1234abcd1234',
      works: true,
    });
    const ws = await workstation();
    expect(ws.sudo).toMatchObject({ keyId: 'abcd1234abcd1234', passwordSet: true, works: true });
    expect(JSON.stringify(ws)).not.toContain('U0VDUkVU');
    // a check follows
    await nextCommand('rights.verify', from);

    const before = r.received.length;
    expect((await owner('DELETE', `/api/workstations/${w.workstationId}/sudo-password`)).status).toBe(202);
    await nextCommand('sudo.clear', before);
    expect((await workstation()).sudo.passwordSet).toBe(false);
    expect(commands('sudo.set').length).toBe(1);
  });

  it('only the workstation owner can use these routes', async () => {
    const other = await w.t.userSession(`other-${Date.now()}@example.test`);
    const res = await w.t.req('GET', `/api/workstations/${w.workstationId}/sudo-key`, {
      cookie: other.cookie,
    });
    expect(res.status).toBe(404);
    const put = await w.t.req('PUT', `/api/workstations/${w.workstationId}/sudo-password`, {
      cookie: other.cookie,
      body: { ciphertext: 'Zm9v', keyId: 'abcd1234abcd1234' },
    });
    expect(put.status).toBe(404);
  });
});

describe('Verify now (POST verify-rights) never fails silently', () => {
  const verify = () => owner('POST', `/api/workstations/${w.workstationId}/verify-rights`, {});
  const report = () => ({
    checkedAt: new Date().toISOString(),
    platform: 'linux',
    checks: { docker: { status: 'verified', reason: 'docker info works' } },
    sudoPasswordStored: false,
  });

  it('shows checking, then the result; a runner error and a missing answer are reported', async () => {
    let from = r.received.length;
    expect((await verify()).status).toBe(202);
    let cmd = await nextCommand('rights.verify', from);
    expect((await workstation()).rightsCheck.state).toBe('checking');
    answer(cmd.commandId, report());
    await settle();
    expect((await workstation()).rightsCheck.state).toBe('idle');
    expect((await workstation()).rights.checks.docker.status).toBe('verified');

    // the runner answers with an error: shown, not dropped
    from = r.received.length;
    await verify();
    cmd = await nextCommand('rights.verify', from);
    answer(cmd.commandId, 'docker binary vanished', false);
    await settle();
    expect((await workstation()).rightsCheck).toMatchObject({
      state: 'failed',
      message: 'docker binary vanished',
    });

    // no answer within a minute: timed out, and a new click replaces the unanswered check
    from = r.received.length;
    await verify();
    await nextCommand('rights.verify', from);
    await q(
      `UPDATE runner_commands SET created_at = now() - (CASE WHEN status='sent' THEN interval '5 minutes' ELSE interval '1 day' END) WHERE type='rights.verify'`,
    );
    expect((await workstation()).rightsCheck.state).toBe('timed_out');
    from = r.received.length;
    expect((await verify()).status).toBe(202);
    cmd = await nextCommand('rights.verify', from);
    expect((await workstation()).rightsCheck.state).toBe('checking');
    answer(cmd.commandId, report());
    await settle();
    expect((await workstation()).rightsCheck.state).toBe('idle');
  });

  it('a runner that never announced its key is too old: 409 runner_outdated, state unsupported', async () => {
    const saved = await q('SELECT * FROM workstation_keys');
    await q('DELETE FROM workstation_keys');
    try {
      const before = (await q(`SELECT 1 FROM runner_commands WHERE type='rights.verify'`)).length;
      const res = await verify();
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ error: { code: 'runner_outdated' } });
      expect((await workstation()).rightsCheck.state).toBe('unsupported');
      expect((await q(`SELECT 1 FROM runner_commands WHERE type='rights.verify'`)).length).toBe(before);
    } finally {
      for (const k of saved)
        await q(
          'INSERT INTO workstation_keys (workstation_id, key_id, public_key, updated_at) VALUES ($1,$2,$3,$4)',
          [k.workstation_id, k.key_id, k.public_key, k.updated_at],
        );
    }
  });
});
