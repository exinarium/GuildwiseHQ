import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type GithubApi, GithubError } from '../src/cloud/github.ts';
import { type SshConnectOptions, type SshConnector, SshError } from '../src/cloud/ssh.ts';
import { cloudTick } from '../src/cloud/tick.ts';
import { closeAdminPool, q } from './helpers/db.ts';
import { createWorld, markOnline, ok, pairWorkstation, type World } from './helpers/world.ts';

let w: World;
const sent: Array<{ to: string; subject: string; text: string }> = [];
const cookie = () => w.owner.cookie;
const ssh = { connects: [] as SshConnectOptions[], commands: [] as string[] };

/** A stand-in for a VPS: "runs" the install command by fetching the script from the app and pairing with its code. */
let sshBehavior: 'ok' | 'auth' | 'script-fails' = 'ok';
const fakeSsh: SshConnector = {
  async connect(o) {
    ssh.connects.push(o);
    if (sshBehavior === 'auth') throw new SshError('auth', 'refused');
    return {
      fingerprint: 'SHA256:abc123',
      close() {},
      async exec(command) {
        ssh.commands.push(command);
        if (sshBehavior === 'script-fails') return { code: 7, stdout: 'No space left on device', stderr: '' };
        const url = /'(http[^']+\/install\.sh)'/.exec(command)?.[1] ?? '';
        const script = await w.t.req('GET', new URL(url).pathname);
        const code = /PAIRING_CODE='([^']+)'/.exec(script.body as string)?.[1] ?? '';
        const res = await w.t.req('POST', '/api/runner/pair', {
          body: { code, name: 'VPS', platform: 'linux', hostname: 'vps', runnerVersion: '0.0.0-test' },
        });
        return { code: res.status === 200 ? 0 : 1, stdout: '', stderr: '' };
      },
    };
  },
};

const gh = {
  login: 'octo',
  files: new Set<string>(['.devcontainer/guildwise/devcontainer.json']),
  created: 0,
  started: [] as string[],
  stopped: [] as string[],
  startError: null as GithubError | null,
  state: 'Available',
};
const fakeGithub: GithubApi = {
  async user(token) {
    if (token === 'bad-token-xxxx') throw new GithubError('auth', 'bad', 401);
    return {
      login: token.startsWith('someone-else')
        ? 'mallory'
        : token.startsWith('codespace-')
          ? 'octo'
          : gh.login,
    };
  },
  async machines() {
    return [{ name: 'basicLinux32gb', displayName: '2 cores' }];
  },
  async fileExists(_t, _r, path) {
    return gh.files.has(path);
  },
  async create() {
    gh.created++;
    return { name: 'verbose-fiesta-1', state: 'Queued', machine: 'basicLinux32gb' };
  },
  async get(_t, name) {
    return { name, state: gh.state, machine: null };
  },
  async start(_t, name) {
    if (gh.startError) throw gh.startError;
    gh.started.push(name);
    return { name, state: 'Starting', machine: null };
  },
  async stop(_t, name) {
    gh.stopped.push(name);
    return { name, state: 'ShuttingDown', machine: null };
  },
  async remove() {},
};

beforeAll(async () => {
  w = await createWorld({ listen: false });
  w.t.app.ctx.services.cloud.ssh = fakeSsh;
  w.t.app.ctx.services.cloud.github = fakeGithub;
  w.t.app.ctx.mailer = {
    async send(m) {
      sent.push(m);
    },
    close() {},
  };
});
afterAll(async () => {
  await w.t.close();
  await closeAdminPool();
});

const settle = async () => {
  await Promise.all([...w.t.app.ctx.services.cloud.pending]);
};
const vpsBody = (over: Record<string, unknown> = {}) => ({
  name: 'Studio VPS',
  host: '203.0.113.9',
  port: 22,
  username: 'deploy',
  password: 'hunter2-very-secret',
  monthlyPriceUsd: 12,
  ...over,
});

describe('VPS over SSH', () => {
  it('installs the runner non-interactively, pairs it, and keeps no credential', async () => {
    const created = await ok<any>(
      w.t.req('POST', '/api/cloud-workstations/vps', { cookie: cookie(), body: vpsBody() }),
      201,
    );
    expect(created).toMatchObject({
      provider: 'ssh',
      state: 'installing',
      manualPower: true,
      canDeployDocker: true,
    });
    expect(JSON.stringify(created)).not.toContain('hunter2');
    await settle();
    const done = await ok<any>(w.t.req('GET', `/api/cloud-workstations/${created.id}`, { cookie: cookie() }));
    expect(done.state).toBe('running');
    expect(done.workstationId).toBeTruthy();
    expect(done.location).toBe('deploy@203.0.113.9:22');
    expect(done.monthlyEstimateUsd).toBe(12);
    expect(done.authMode).toBe('api_key');
    // the install command is unattended and never carries a Claude credential
    const cmd = ssh.commands[0] ?? '';
    expect(cmd).toContain('GUILDWISE_YES=1');
    expect(cmd).toContain('GUILDWISE_SKIP_CLAUDE=1');
    expect(cmd).not.toContain('hunter2');
    expect(ssh.connects[0]).toMatchObject({ password: 'hunter2-very-secret', username: 'deploy' });
    // nothing secret stored: the row has the host key fingerprint but no password
    const rows = await q('SELECT * FROM cloud_workstations');
    expect(JSON.stringify(rows)).not.toContain('hunter2');
    expect((rows[0] as any).config.hostFingerprint).toBe('SHA256:abc123');
    // the paired workstation exists and belongs to the user
    const ws = await q('SELECT user_id FROM workstations WHERE id=$1', [done.workstationId]);
    expect(ws[0]?.user_id).toBe(w.owner.id);
  });

  it('allows one cloud workstation per organization', async () => {
    const r = await w.t.req('POST', '/api/cloud-workstations/vps', { cookie: cookie(), body: vpsBody() });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('cloud_workstation_exists');
  });

  it('wake and stop are manual for a VPS', async () => {
    const [cw] = (await ok<any>(w.t.req('GET', '/api/cloud-workstations', { cookie: cookie() })))
      .cloudWorkstations;
    expect(
      (await w.t.req('POST', `/api/cloud-workstations/${cw.id}/stop`, { cookie: cookie() })).body.error.code,
    ).toBe('manual_power');
    expect(
      (await w.t.req('POST', `/api/cloud-workstations/${cw.id}/wake`, { cookie: cookie() })).status,
    ).toBe(409);
  });

  it('removing it frees the slot; a refused login and a failing installer are reported', async () => {
    const [cw] = (await ok<any>(w.t.req('GET', '/api/cloud-workstations', { cookie: cookie() })))
      .cloudWorkstations;
    await ok(w.t.req('DELETE', `/api/cloud-workstations/${cw.id}`, { cookie: cookie() }));
    sshBehavior = 'auth';
    const a = await ok<any>(
      w.t.req('POST', '/api/cloud-workstations/vps', { cookie: cookie(), body: vpsBody() }),
      201,
    );
    await settle();
    const failed = await ok<any>(w.t.req('GET', `/api/cloud-workstations/${a.id}`, { cookie: cookie() }));
    expect(failed.state).toBe('failed');
    expect(failed.stateDetail).toMatch(/refused the login/);
    await ok(w.t.req('DELETE', `/api/cloud-workstations/${a.id}`, { cookie: cookie() }));
    sshBehavior = 'script-fails';
    const b = await ok<any>(
      w.t.req('POST', '/api/cloud-workstations/vps', {
        cookie: cookie(),
        body: vpsBody({ password: undefined, privateKey: '-----BEGIN KEY-----x' }),
      }),
      201,
    );
    await settle();
    const bad = await ok<any>(w.t.req('GET', `/api/cloud-workstations/${b.id}`, { cookie: cookie() }));
    expect(bad).toMatchObject({ state: 'failed' });
    expect(bad.stateDetail).toContain('No space left on device');
    await ok(w.t.req('DELETE', `/api/cloud-workstations/${b.id}`, { cookie: cookie() }));
    sshBehavior = 'ok';
  });

  it('needs either a password or a key, and only org admins may add one', async () => {
    expect(
      (
        await w.t.req('POST', '/api/cloud-workstations/vps', {
          cookie: cookie(),
          body: vpsBody({ password: undefined }),
        })
      ).status,
    ).toBe(400);
    const member = await w.t.userSession(`m-${Date.now()}@example.com`);
    await w.t.addOrgMember(w.owner.id, member.id, 'member');
    const r = await w.t.req('POST', '/api/cloud-workstations/vps', {
      cookie: member.cookie,
      headers: { 'x-aom-org': w.owner.id },
      body: vpsBody(),
    });
    expect(r.status).toBe(403);
  });
});

describe('GitHub Codespaces', () => {
  let id = '';
  const codespace = { name: 'Cloud', repo: 'acme/toy', machine: 'basicLinux32gb' };

  it('needs a GitHub connection, then checks the devcontainer file exists', async () => {
    expect(
      (await w.t.req('POST', '/api/cloud-workstations/codespaces', { cookie: cookie(), body: codespace }))
        .body.error.code,
    ).toBe('github_not_connected');
    expect(
      (
        await w.t.req('POST', '/api/cloud-workstations/github/connect', {
          cookie: cookie(),
          body: { token: 'bad-token-xxxx' },
        })
      ).status,
    ).toBe(422);
    const c = await ok<any>(
      w.t.req('POST', '/api/cloud-workstations/github/connect', {
        cookie: cookie(),
        body: { token: 'ghp_realtoken1234' },
      }),
    );
    expect(c).toEqual({ connected: true, login: 'octo' });
    // the token is stored encrypted, not in clear
    const stored = await q('SELECT token_enc FROM cloud_github_connections');
    expect(stored[0]?.token_enc).not.toContain('ghp_realtoken1234');
    gh.files.delete('.devcontainer/guildwise/devcontainer.json');
    const missing = await w.t.req('POST', '/api/cloud-workstations/codespaces', {
      cookie: cookie(),
      body: codespace,
    });
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('devcontainer_missing');
    gh.files.add('.devcontainer/guildwise/devcontainer.json');
    const made = await ok<any>(
      w.t.req('POST', '/api/cloud-workstations/codespaces', { cookie: cookie(), body: codespace }),
      201,
    );
    id = made.id;
    expect(made).toMatchObject({ provider: 'codespaces', state: 'starting', canDeployDocker: false });
    expect(made.monthlyEstimateUsd).toBeGreaterThan(0);
  });

  it('generates a devcontainer.json without secrets', async () => {
    const r = await ok<any>(
      w.t.req('GET', '/api/cloud-workstations/devcontainer?stacks=node,dotnet', { cookie: cookie() }),
    );
    expect(r.path).toBe('.devcontainer/guildwise/devcontainer.json');
    const j = JSON.parse(r.content);
    expect(j.postStartCommand).toContain('/api/runner/codespaces-bootstrap.sh');
    expect(Object.keys(j.features).some((k: string) => k.includes('dotnet'))).toBe(true);
    expect(r.content).not.toMatch(/aomr_|PAIR/);
  });

  it('serves the bootstrap script', async () => {
    const r = await w.t.req('GET', '/api/runner/codespaces-bootstrap.sh');
    expect(r.status).toBe(200);
    expect(r.body).toContain('aom-runner" up --server');
    expect(r.body).toContain('sha256sum');
  });

  it('enrolls the codespace once its own token proves it belongs to the same GitHub account', async () => {
    const enroll = (token: string, name = 'verbose-fiesta-1') =>
      w.t.req('POST', '/api/runner/enroll', {
        body: {
          codespaceName: name,
          githubToken: token,
          name: 'Codespace',
          platform: 'linux',
          hostname: 'cs',
          runnerVersion: '0.0.0-test',
        },
      });
    expect((await enroll('someone-else-token')).status).toBe(401);
    expect((await enroll('codespace-token-ok', 'unknown-name')).status).toBe(401);
    const r = await enroll('codespace-token-ok');
    expect(r.status).toBe(200);
    expect(r.body.runnerToken).toMatch(/^aomr_/);
    const dto = await ok<any>(w.t.req('GET', `/api/cloud-workstations/${id}`, { cookie: cookie() }));
    expect(dto.state).toBe('running');
    expect(dto.workstationId).toBe(r.body.workstationId);
  });

  it('stops after the idle time with no shifts, and not before', async () => {
    const [row] = await q('SELECT workstation_id FROM cloud_workstations WHERE id=$1', [id]);
    await markOnline(w.t, row?.workstation_id);
    w.t.clock.advance(20 * 60_000);
    expect((await cloudTick(w.t.app.ctx)).stopped).toEqual([]);
    w.t.clock.advance(11 * 60_000);
    expect((await cloudTick(w.t.app.ctx)).stopped).toEqual([id]);
    expect(gh.stopped).toEqual(['verbose-fiesta-1']);
    const dto = await ok<any>(w.t.req('GET', `/api/cloud-workstations/${id}`, { cookie: cookie() }));
    expect(dto.state).toBe('stopped');
  });

  it('wakes when a card is queued for an agent on it, and not outside the office hours', async () => {
    const [row] = await q('SELECT workstation_id FROM cloud_workstations WHERE id=$1', [id]);
    const wsId = row?.workstation_id as string;
    await markOnline(w.t, wsId, { repoIds: [w.repoId] });
    await q('UPDATE workstations SET connected=false WHERE id=$1', [wsId]);
    // nothing queued: stays stopped
    expect((await cloudTick(w.t.app.ctx)).woke).toEqual([]);
    await q(`UPDATE workstations SET user_id=$2 WHERE id=$1`, [wsId, w.owner.id]);
    await w.hire('Bo', 'builder', 'junior').catch(() => undefined);
    await q(`UPDATE agents SET workstation_id=$1 WHERE name='Bo'`, [wsId]);
    await w.card();
    // office hours that never contain "now": no wake
    await ok(
      w.t.req('PATCH', `/api/cloud-workstations/${id}`, {
        cookie: cookie(),
        body: {
          officeHours: {
            days: [(new Date(w.t.clock.now()).getUTCDay() + 3) % 7],
            from: '09:00',
            to: '10:00',
            timezone: 'UTC',
          },
        },
      }),
    );
    expect((await cloudTick(w.t.app.ctx)).woke).toEqual([]);
    await ok(
      w.t.req('PATCH', `/api/cloud-workstations/${id}`, { cookie: cookie(), body: { officeHours: null } }),
    );
    expect((await cloudTick(w.t.app.ctx)).woke).toEqual([id]);
    expect(gh.started).toEqual(['verbose-fiesta-1']);
    expect((await ok<any>(w.t.req('GET', `/api/cloud-workstations/${id}`, { cookie: cookie() }))).state).toBe(
      'starting',
    );
  });

  it('tells the user (desk notice and email) once when the credits ran out', async () => {
    await q(`UPDATE cloud_workstations SET state='stopped' WHERE id=$1`, [id]);
    gh.startError = new GithubError('billing', 'Codespaces spending limit reached', 402);
    const r = await w.t.req('POST', `/api/cloud-workstations/${id}/wake`, { cookie: cookie() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: 'needs_attention' });
    expect(r.body.stateDetail).toMatch(/spending limit/);
    // a second failed attempt does not notify again
    await w.t.req('POST', `/api/cloud-workstations/${id}/wake`, { cookie: cookie() });
    const items = await q(`SELECT title FROM desk_items WHERE data->>'cloudWorkstationId' = $1`, [id]);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toMatch(/credits ran out/);
    expect(sent.filter((m) => /credits ran out/.test(m.subject))).toHaveLength(1);
    gh.startError = null;
  });

  it('lists whether a Docker-capable workstation exists, and removes the cloud workstation', async () => {
    const list = await ok<any>(w.t.req('GET', '/api/cloud-workstations', { cookie: cookie() }));
    // the world's own desk workstation is a normal one
    expect(list.hasDockerCapableWorkstation).toBe(true);
    await ok(w.t.req('DELETE', `/api/cloud-workstations/${id}`, { cookie: cookie() }));
    expect(
      (await ok<any>(w.t.req('GET', '/api/cloud-workstations', { cookie: cookie() }))).cloudWorkstations,
    ).toEqual([]);
  });
});

describe('a Codespace only world', () => {
  it('has no Docker-capable workstation when only Codespaces are paired', async () => {
    const ws = await pairWorkstation(w.t, w.owner, 'OnlyCloud');
    await q(`UPDATE workstations SET status='unlinked' WHERE id <> $1`, [ws.workstationId]);
    await q(
      `INSERT INTO cloud_workstations (org_id, user_id, provider, name, state, workstation_id, config, created_at, updated_at)
       VALUES ($1,$1,'codespaces','C','running',$2,'{"codespaceName":"x1","repo":"a/b","machine":"basicLinux32gb"}',now(),now())`,
      [w.owner.id, ws.workstationId],
    );
    const list = await ok<any>(w.t.req('GET', '/api/cloud-workstations', { cookie: cookie() }));
    expect(list.hasDockerCapableWorkstation).toBe(false);
  });
});
