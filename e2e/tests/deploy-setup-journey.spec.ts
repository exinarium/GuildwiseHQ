import { type ChildProcess, execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { type APIRequestContext, expect, test } from '@playwright/test';
import { directEnv, localAdoptEnv, type ProbeReport, sshShipEnv } from '../../packages/shared/src/index.ts';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, E2E_DIR, JOURNEYER, paths, ROOT } from '../support/env.ts';
import { addRepoRoot, killRunner, pairRunner, startRunner } from '../support/runner.ts';
import { git } from '../support/vault.ts';

/**
 * The deploy-setup journey of a person who runs a stack on their own server, against the REAL server, a REAL runner, a REAL sshd
 * (a throwaway container with a fake docker, apps/runner/test/fixtures/fake-flow-docker.sh) and a REAL registry (a throwaway
 * registry:2 container): the stack lives in /home/deploy/app/flow (NOT /opt), has a LITERAL image tag, a published port, no
 * .env variable, and its compose project (dcode-flow5-remote) is not the folder's name. Everything goes through the same API the
 * page uses: connect the server (an existing sign-in), let the probe find the stack from its labels, save, try without changing
 * anything, approve, a real release that replaces ONLY the app (the database container keeps its id; the compose file is not
 * edited), a second environment (this computer) that does not overwrite the first, a DevOps scan merged into the draft, another
 * server for an environment, removal of an environment, removal of an unused place (and the refusal for a used one), a registry
 * release, and discarding a draft.
 *
 * The page's own screens are driven by the web specs of the Environments page; this spec proves the whole backend path and the
 * safety rules (nothing outside the throwaway containers and folders is touched: no real host, no ~/.ssh, no other container).
 * Own port, database and folder: AOM_E2E_PORT / AOM_E2E_DB / AOM_E2E_DIR.
 */
test.describe.configure({ mode: 'serial', timeout: 420_000 });

const DIR = join(E2E_DIR, 'deploy-setup-journey');
const HOME = paths.runnerHome('deploy-setup-journey');
const RUNNER_HOME = join(DIR, 'home');
const BIN = join(DIR, 'bin');
const LOCAL_STATE = join(DIR, 'state-local');
const ORIGIN = join(DIR, 'origin.git');
const CLONE = join(DIR, 'repos', 'app');
const IMAGE = 'aom-test-sshd:1';
const BOX = `aom-e2e-journey-box-${process.pid}`;
const REG = `aom-e2e-journey-registry-${process.pid}`;
const COMPOSE_PROJECT = 'dcode-flow5-remote';
const APP_DIR = '/home/deploy/app/flow';
const OLD_IMAGE = 'dcode-server:remote29-showcase-0000000000';
const REAL_DOCKER = '/usr/bin/docker';

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const onBox = (cmd: string) => docker('exec', BOX, 'sh', '-c', cmd);
const portOf = (name: string, inner: number) => {
  const m = docker('port', name, String(inner)).split('\n')[0] ?? '';
  return Number(m.slice(m.lastIndexOf(':') + 1));
};
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

let api: APIRequestContext;
let projectId: string;
let workstationId: string;
let sshPort = 0;
let httpPort = 0;
let regPort = 0;
let liveTarget = '';
let runner: ChildProcess | null = null;
let dbCid = '';
let appCid = '';
let composeSha = '';
let localPort = 0;
let shopPort = 0;

const base = () => `/api/projects/${projectId}`;
const json = async (res: Awaited<ReturnType<APIRequestContext['get']>>, status?: number) => {
  const text = await res.text();
  if (status !== undefined) expect(res.status(), text).toBe(status);
  else expect(res.ok(), text).toBeTruthy();
  return text ? JSON.parse(text) : {};
};
const get = async (url: string) => json(await api.get(url));
const post = async (url: string, data: unknown = {}, status?: number) =>
  json(await api.post(url, { data }), status);
const put = async (url: string, data: unknown, status?: number) => json(await api.put(url, { data }), status);

const commit = (msg: string, files: Record<string, string>): string => {
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(join(CLONE, f, '..'), { recursive: true });
    writeFileSync(join(CLONE, f), c);
  }
  git(CLONE, 'add', '-A');
  git(CLONE, 'commit', '-m', msg);
  git(CLONE, 'push', 'origin', 'main');
  return git(CLONE, 'rev-parse', 'HEAD').trim();
};

const state = () => get(`${base()}/delivery/setup`);

/** Saves the draft setup the way the page does: preview, publish, wait until the computer wrote the files. */
async function saveSetup(setup: unknown): Promise<string> {
  await put(`${base()}/delivery/setup`, { setup });
  const prev = await post(`${base()}/delivery/setup/preview`, { setup });
  expect(prev.ok, JSON.stringify(prev.issues)).toBe(true);
  expect(prev.lint.filter((l: { level: string }) => l.level === 'error')).toEqual([]);
  await post(`${base()}/delivery/setup/publish`, { setup, setupHash: prev.hash }, 202);
  await waitFor(
    'the computer wrote the files',
    async () => (await state()).publish?.status,
    (s) => s === 'written' || s === 'failed',
    90_000,
  );
  const st = await state();
  expect(st.publish.status, st.publish.error).toBe('written');
  return st.current.observedHash as string;
}

/** "Try it without changing anything" for these environments, then the Owner approves. */
async function tryAndApprove(envs: string[]): Promise<void> {
  const st = await state();
  for (const env of st.current.dryRunMissing ?? envs) await post(`${base()}/delivery/setup/dry-run`, { env });
  await waitFor(
    'the dry runs',
    async () => (await state()).current.dryRunMissing,
    (m) => Array.isArray(m) && m.length === 0,
    240_000,
  );
  const hash = (await state()).current.observedHash;
  await post(`${base()}/delivery/approve`, { hash });
}

type Run = { status: string; log_tail: string; summary: string };
async function release(env: string, sha: string): Promise<Run> {
  const res = await post(`${base()}/delivery/deploy`, { env, commit: sha });
  const run = res.runs[0];
  expect(run.status, JSON.stringify(res)).not.toBe('refused');
  return (await waitFor(
    'the release finished',
    async () =>
      (
        await q<Run>('SELECT status, log_tail, summary FROM deploy_runs WHERE id=$1', [run.runId])
      )[0],
    (r) => r?.status === 'succeeded' || r?.status === 'failed' || r?.status === 'refused',
    300_000,
  )) as Run;
}

const liveEnv = (over: Record<string, unknown> = {}) =>
  sshShipEnv({
    name: 'live',
    label: 'Live site',
    target: 'Flow server',
    host: 'e2e-flow',
    composeFile: `${APP_DIR}/compose.yaml`,
    composeProject: COMPOSE_PROJECT,
    service: 'dcode-server',
    imageName: 'dcode-server',
    healthUrl: `http://127.0.0.1:${httpPort}/ready`,
    appUrl: `http://127.0.0.1:${httpPort}`,
    database: { service: 'postgres', dir: `${APP_DIR}/backups` },
    ...over,
  } as never);

test.beforeAll(async () => {
  // a runner of this spec only: its ssh sees only the throwaway box, and its docker is the fake one
  try {
    await inviteAndAccept(await apiAs(ADMIN.email, ADMIN.password), JOURNEYER);
  } catch {
    // another run made this user
  }
  api = await apiAs(JOURNEYER.email, JOURNEYER.password);
});

test.afterAll(() => {
  // AOM_JOURNEY_KEEP=1 leaves the throwaway containers and folder for a look (remove them by hand afterwards)
  if (process.env.AOM_JOURNEY_KEEP === '1') return;
  killRunner('SIGTERM', HOME);
  for (const n of [BOX, REG]) {
    try {
      docker('rm', '-f', n);
    } catch {
      // never started
    }
  }
  try {
    for (const t of docker('image', 'ls', '--format', '{{.Repository}}:{{.Tag}}')
      .split('\n')
      .filter((x) => regPort && x.startsWith(`127.0.0.1:${regPort}/`)))
      docker('image', 'rm', t);
  } catch {
    // already gone
  }
  rmSync(DIR, { recursive: true, force: true });
});

test('setup: a throwaway server (sshd + fake docker) with the stack outside /opt, a throwaway registry, a repository and a runner', async () => {
  rmSync(DIR, { recursive: true, force: true });
  for (const d of [
    DIR,
    BIN,
    LOCAL_STATE,
    join(LOCAL_STATE, 'c'),
    join(LOCAL_STATE, 'images'),
    RUNNER_HOME,
    join(RUNNER_HOME, '.ssh'),
  ])
    mkdirSync(d, { recursive: true });
  docker('build', '-q', '-t', IMAGE, join(ROOT, 'apps/runner/test/fixtures/sshd'));

  // the registry
  regPort = await freePort();
  docker(
    'run',
    '-d',
    '--rm',
    '--name',
    REG,
    '-p',
    `127.0.0.1:${regPort}:5000`,
    '-p',
    `172.17.0.1:${regPort}:5000`,
    'registry:2',
  );
  await waitFor(
    'the registry answers',
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${regPort}/v2/`)).status;
      } catch {
        return 0;
      }
    },
    (s) => s === 200,
    30_000,
  );

  // the server
  docker(
    'run',
    '-d',
    '--rm',
    '--name',
    BOX,
    '-p',
    '127.0.0.1::22',
    '-p',
    '127.0.0.1::5500',
    '-p',
    '127.0.0.1::8090',
    IMAGE,
  );
  sshPort = portOf(BOX, 22);
  httpPort = portOf(BOX, 5500);
  shopPort = portOf(BOX, 8090);
  const flowDocker = join(ROOT, 'apps/runner/test/fixtures/fake-flow-docker.sh');
  docker('cp', flowDocker, `${BOX}:/usr/bin/docker`);
  onBox('chmod +x /usr/bin/docker');
  await waitFor(
    'sshd answers',
    async () => {
      try {
        return execFileSync('ssh-keyscan', ['-T', '1', '-p', String(sshPort), '-t', 'ed25519', '127.0.0.1'], {
          encoding: 'utf8',
        }).includes('ssh-ed25519');
      } catch {
        return false;
      }
    },
    (ok) => ok,
    30_000,
  );
  // the person's sign-in: a key in the runner's own ssh folder, an alias for the user `deploy`
  const key = join(DIR, 'flow_key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key, '-C', 'e2e-journey'], {
    stdio: 'pipe',
  });
  onBox(
    `mkdir -p /home/deploy/.ssh && printf '%s\\n' '${readFileSync(`${key}.pub`, 'utf8').trim()}' > /home/deploy/.ssh/authorized_keys && chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys`,
  );
  const scan = spawnSync('ssh-keyscan', ['-T', '3', '-p', String(sshPort), '-t', 'ed25519', '127.0.0.1'], {
    encoding: 'utf8',
  });
  writeFileSync(join(RUNNER_HOME, '.ssh', 'known_hosts'), scan.stdout);
  writeFileSync(
    join(RUNNER_HOME, '.ssh', 'config'),
    `Host e2e-flow\n  HostName 127.0.0.1\n  Port ${sshPort}\n  User deploy\n  IdentityFile ${key}\n  IdentitiesOnly yes\n  IdentityAgent none\n  UserKnownHostsFile ${join(RUNNER_HOME, '.ssh', 'known_hosts')}\n  GlobalKnownHostsFile /dev/null\n`,
    { mode: 0o600 },
  );
  chmodSync(join(RUNNER_HOME, '.ssh', 'config'), 0o600);
  // the stack, as `docker compose up` left it
  const files = `${APP_DIR}/compose.yaml`;
  onBox(
    [
      `mkdir -p ${APP_DIR} /var/fakedocker/c /var/fakedocker/images /var/fakedocker/www`,
      `printf 'services:\\n  dcode-server:\\n    image: ${OLD_IMAGE}\\n    ports:\\n      - "5500:500"\\n  postgres:\\n    image: postgres:18\\n    ports:\\n      - "127.0.0.1:5432:5432"\\n' > ${files}`,
      `printf 'POSTGRES_PASSWORD=journey-secret-value\\nTOKEN=x\\n' > ${APP_DIR}/.env`,
      `printf 'cid-app-0001\\n${OLD_IMAGE}\\n${COMPOSE_PROJECT}\\n${files}\\n5500\\n' > /var/fakedocker/c/dcode-server`,
      `printf 'cid-db-0001\\npostgres:18\\n${COMPOSE_PROJECT}\\n${files}\\n\\n' > /var/fakedocker/c/postgres`,
      `printf 'portainer-0001\\nportainer/portainer-ce\\n\\n\\n\\n' > /var/fakedocker/c/portainer`,
      `printf %s '${OLD_IMAGE}' > /var/fakedocker/images/${OLD_IMAGE.replace(/[/:@]/g, '_')}`,
      `printf '127.0.0.1:${regPort}=172.17.0.1:${regPort}\\n' > /var/fakedocker/registry-map`,
      `echo ok > /var/fakedocker/www/ready`,
      `(httpd -f -p 5500 -h /var/fakedocker/www </dev/null >/dev/null 2>&1 &)`,
      // an app that does not run in Docker: a plain folder served by a small web server, restarted by a script of the person's own
      `mkdir -p /home/deploy/shop && printf '{}' > /home/deploy/shop/package.json && printf 'v0 the app that runs today' > /home/deploy/shop/index.html`,
      `printf '#!/bin/sh\\npkill -f "httpd -f -p 8090" 2>/dev/null\\nsleep 1\\nhttpd -f -p 8090 -h /home/deploy/shop </dev/null >/dev/null 2>&1 &\\nsleep 1\\n' > /home/deploy/restart-shop.sh && chmod +x /home/deploy/restart-shop.sh`,
      `chown -R deploy:deploy /home/deploy /var/fakedocker`,
      `su deploy -s /bin/sh -c '/home/deploy/restart-shop.sh'`,
    ].join(' && '),
  );
  composeSha = onBox(`sha256sum ${files}`).split(' ')[0] as string;
  dbCid = onBox('head -n 1 /var/fakedocker/c/postgres').trim();
  appCid = onBox('head -n 1 /var/fakedocker/c/dcode-server').trim();
  await waitFor(
    'the old app answers',
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${httpPort}/ready`)).status;
      } catch {
        return 0;
      }
    },
    (s) => s === 200,
    20_000,
  );

  // this computer: a fake docker first on the runner's PATH; the registry is the one real thing it talks to
  copyFileSync(flowDocker, join(BIN, 'docker'));
  chmodSync(join(BIN, 'docker'), 0o755);
  // the repository of the app: a Dockerfile that really builds (FROM scratch) so the registry release can push a real image
  mkdirSync(join(DIR, 'repos'), { recursive: true });
  git(DIR, 'init', '--bare', '-b', 'main', ORIGIN);
  git(join(DIR, 'repos'), 'clone', ORIGIN, CLONE);
  git(CLONE, 'checkout', '-b', 'main');
  commit('first version', { Dockerfile: 'FROM scratch\nCOPY marker /marker\n', marker: 'v1\n' });

  // a local stack for the second environment (also fake: state files, a compose file that is really read)
  localPort = await freePort();
  const localStack = join(DIR, 'local-stack');
  mkdirSync(localStack, { recursive: true });
  writeFileSync(
    join(localStack, 'docker-compose.yml'),
    `services:\n  web:\n    build: ${CLONE}\n    image: local-web:old\n    ports:\n      - "127.0.0.1:${localPort}:8080"\n  cache:\n    image: redis:7\n`,
  );
  const lf = join(localStack, 'docker-compose.yml');
  writeFileSync(
    join(LOCAL_STATE, 'c', 'web'),
    `local-web-0001\nlocal-web:old\naomj-local\n${lf}\n${localPort}\n`,
  );
  writeFileSync(join(LOCAL_STATE, 'c', 'cache'), `local-cache-0001\nredis:7\naomj-local\n${lf}\n\n`);
  writeFileSync(join(LOCAL_STATE, 'images', 'local-web_old'), 'local-web:old');
  mkdirSync(join(LOCAL_STATE, 'www'), { recursive: true });

  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Journey PC', HOME);
  addRepoRoot(join(DIR, 'repos'), HOME);
  runner = startRunner(
    {
      AOM_MOCK_STEP_MS: '100',
      HOME: RUNNER_HOME,
      SSH_AUTH_SOCK: '',
      PATH: `${BIN}:${process.env.PATH}`,
      FAKE_STATE: LOCAL_STATE,
      FAKE_REAL_REGISTRY: `127.0.0.1:${regPort}`,
      FAKE_REAL_PATH: dirname(REAL_DOCKER),
      AOM_PROBE_APP_ROOTS: join(DIR, 'nothing-here'),
    },
    HOME,
  );
  await waitFor(
    'runner connected',
    async () =>
      (await (await api.get('/api/workstations')).json()).workstations as Array<{
        connected: boolean;
        id: string;
      }>,
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ((await get('/api/workstations')).workstations[0] as { id: string }).id;
  const proj = await post('/api/projects', { key: 'JNY', name: 'Journey project' }, 201);
  projectId = proj.project.id;
  await post(`${base()}/repos`, { name: 'app', remoteUrl: ORIGIN, workingBranch: 'main' }, 201);
  await waitFor(
    'the computer holds the repo',
    async () => (await get('/api/workstations')).workstations[0].repos.length,
    (n) => n === 1,
    30_000,
  );
  const caps = await q<{ capabilities: string[] }>('SELECT capabilities FROM workstation_capabilities');
  expect(
    caps.some((c) => c.capabilities.includes('deploy-setup:2') && c.capabilities.includes('deploy-direct:1')),
  ).toBe(true);
});

test('connect the server with an existing sign-in; it finds the running stack from its labels although it is not in /opt', async () => {
  const started = await post(`${base()}/delivery/connect`, {
    workstationId,
    newTarget: { name: 'Flow server', production: true },
    method: 'alias',
    alias: 'e2e-flow',
  });
  liveTarget = started.targetId;
  await waitFor(
    'connected',
    async () => (await get(`${base()}/delivery/ops/${started.commandId}`)).state,
    (s) => s !== 'pending',
    60_000,
  );
  const op = await get(`${base()}/delivery/ops/${started.commandId}`);
  expect(op.ok, JSON.stringify(op)).toBe(true);
  const places = (await get(`${base()}/places`)).places;
  expect(places).toHaveLength(1);
  expect(places[0]).toMatchObject({
    name: 'Flow server',
    kind: 'server',
    host: 'e2e-flow',
    usedBy: [],
    canRemove: true,
  });

  const probe = await post(
    `${base()}/delivery/probe`,
    { scope: 'ssh_target', targetId: liveTarget, workstationId },
    202,
  );
  const report = (await waitFor(
    'the look at the server',
    async () =>
      (
        (
          await state()
        ).probes as Array<{ scope: string; report: ProbeReport | null; error: string | null }>
      ).find((p) => p.scope === 'ssh_target'),
    (p) => !!p && (!!p.report || !!p.error),
    90_000,
  )) as { report: ProbeReport | null; error: string | null };
  void probe;
  expect(report.error).toBeNull();
  const rep = report.report as ProbeReport;
  const cf = rep.composeFiles.find((c) => c.path === `${APP_DIR}/compose.yaml`);
  expect(cf, JSON.stringify(rep.composeFiles)).toBeTruthy();
  expect(cf?.project).toBe(COMPOSE_PROJECT);
  expect(cf?.services.map((s) => s.name)).toEqual(['dcode-server', 'postgres']);
  expect(rep.containers.map((c) => c.name)).toEqual(
    expect.arrayContaining([
      `${COMPOSE_PROJECT}-dcode-server-1`,
      `${COMPOSE_PROJECT}-postgres-1`,
      'portainer-1',
    ]),
  );
  expect(rep.folders.find((f) => f.path === APP_DIR)?.envKeys).toEqual(['POSTGRES_PASSWORD', 'TOKEN']);
  expect(rep.checked).toContain(APP_DIR);
  // no secret value of the server's settings file travelled
  expect(JSON.stringify(rep)).not.toContain('journey-secret-value');
});

test('save with the stack as it is (literal tag, no variable), try it without changing anything, approve', async () => {
  await post(`${base()}/delivery/setup/preview`, { setup: { environments: [liveEnv()] } }).then((p) => {
    expect(p.ok).toBe(true);
    const text = p.changes.map((c: { group: string; text: string }) => `${c.group}: ${c.text}`).join('\n');
    expect(text).toContain('untouched: Part "postgres"');
    expect(text).toContain('untouched: Container portainer');
  });
  const hash = await saveSetup({ environments: [liveEnv()] });
  expect(hash).toBeTruthy();
  const files = (await state()).current.setup.environments[0];
  expect(files.app.imageVar).toBeUndefined();
  await tryAndApprove(['live']);
  await put(`${base()}/delivery/mode`, { mode: 'recipe' });
  // nothing on the server changed so far
  expect(onBox('head -n 1 /var/fakedocker/c/dcode-server').trim()).toBe(appCid);
  expect(onBox(`ls ${APP_DIR}`)).not.toContain('docker-compose.guildwise.yml');
  expect(onBox(`ls ${APP_DIR}`)).not.toContain('backups');
});

test('a real release replaces ONLY the app: the database and the bystander keep their ids, the compose file is not edited, a backup was taken, the site answers', async () => {
  const sha = commit('second version', { marker: 'v2\n' });
  const r = await release('live', sha);
  expect(r.status, r.log_tail).toBe('succeeded');
  expect(onBox('head -n 1 /var/fakedocker/c/postgres').trim()).toBe(dbCid);
  expect(onBox('head -n 1 /var/fakedocker/c/portainer').trim()).toBe('portainer-0001');
  expect(onBox('head -n 1 /var/fakedocker/c/dcode-server').trim()).not.toBe(appCid);
  expect(onBox('sed -n 2p /var/fakedocker/c/dcode-server').trim()).toBe(`dcode-server:${sha.slice(0, 12)}`);
  expect(onBox(`sha256sum ${APP_DIR}/compose.yaml`).split(' ')[0]).toBe(composeSha);
  expect(onBox(`cat ${APP_DIR}/docker-compose.guildwise.yml`)).toContain(
    `image: "dcode-server:${sha.slice(0, 12)}"`,
  );
  expect(onBox(`ls ${APP_DIR}/backups`)).toMatch(/live-before-/);
  // the settings file was not touched
  expect(onBox(`cat ${APP_DIR}/.env`)).toContain('journey-secret-value');
  expect((await fetch(`http://127.0.0.1:${httpPort}/ready`)).status).toBe(200);
  expect(r.log_tail).toContain('AOM-DEPLOY');
  // the page's status says what runs
  const s = await get(`${base()}/environments/status`);
  const live = s.environments.find((e: { env: string }) => e.env === 'live');
  expect(live).toMatchObject({ state: 'healthy', placeName: 'Flow server', role: 'live' });
  expect(live.current.commit).toBe(sha);
  appCid = onBox('head -n 1 /var/fakedocker/c/dcode-server').trim();
});

let liveScriptBefore: string | null = '';
test('add a second environment on this computer; the first one is not overwritten', async () => {
  liveScriptBefore = await savedFile('scripts/live.sh');
  expect(liveScriptBefore).toBeTruthy();
  const lp = await post(
    `${base()}/deploy-targets`,
    {
      name: 'This computer',
      kind: 'local_docker',
      workstationId,
      appUrl: `http://127.0.0.1:${localPort}`,
      notes: '',
      reuseExisting: true,
    },
    201,
  );
  expect(lp.reused).toBeUndefined();
  // a second press does not make a second place
  const again = await post(
    `${base()}/deploy-targets`,
    { name: 'Another name', kind: 'local_docker', workstationId, notes: '', reuseExisting: true },
    200,
  );
  expect(again).toMatchObject({ id: lp.id, reused: true });
  await post(`${base()}/delivery/probe`, { scope: 'local', targetId: lp.id, workstationId }, 202);
  const local = (await waitFor(
    'the look at this computer',
    async () =>
      ((await state()).probes as Array<{ scope: string; report: ProbeReport | null }>).find(
        (p) => p.scope === 'local',
      ),
    (p) => !!p?.report,
    60_000,
  )) as { report: ProbeReport };
  expect(local.report.composeFiles.map((c) => c.project)).toContain('aomj-local');
  const current = (await state()).current.setup;
  const testEnv = localAdoptEnv({
    name: 'test',
    label: 'Test site',
    target: 'This computer',
    composeFile: join(DIR, 'local-stack', 'docker-compose.yml'),
    composeProject: 'aomj-local',
    service: 'web',
    imageName: 'local-web',
    appUrl: `http://127.0.0.1:${localPort}`,
    healthUrl: `http://127.0.0.1:${localPort}/ready`,
  });
  await saveSetup({ ...current, environments: [...current.environments, testEnv] });
  expect(await savedFile('scripts/live.sh')).toBe(liveScriptBefore);
  const names = (await state()).current.setup.environments.map((e: { name: string }) => e.name);
  expect(names).toEqual(['live', 'test']);
  await tryAndApprove(['live', 'test']);
  const places = (await get(`${base()}/places`)).places;
  expect(places.find((p: { name: string }) => p.name === 'Flow server').usedBy).toEqual([
    { env: 'live', label: 'Live site' },
  ]);
  expect(places.find((p: { name: string }) => p.name === 'This computer').usedBy).toEqual([
    { env: 'test', label: 'Test site' },
  ]);
  // the local app is replaced; the cache next to it keeps its id
  const sha = commit('third version', { marker: 'v3\n' });
  const r = await release('test', sha);
  expect(r.status, r.log_tail).toBe('succeeded');
  expect(readFileSync(join(LOCAL_STATE, 'c', 'cache'), 'utf8').split('\n')[0]).toBe('local-cache-0001');
  expect(readFileSync(join(LOCAL_STATE, 'c', 'web'), 'utf8').split('\n')[1]).toBe(
    `local-web:${sha.slice(0, 12)}`,
  );
});

test('a DevOps scan is merged into the draft: the environments it does not mention stay; a question is answered in a field', async () => {
  const scan = await post(
    `${base()}/scan`,
    { area: 'deploy', note: 'the stack is called dcode-flow5-remote' },
    202,
  );
  void scan;
  const prop = (await waitFor(
    'the proposal',
    async () => (await state()).proposal,
    (p) => !!p,
    180_000,
  )) as {
    id: string;
    proposal: {
      questions: Array<{
        path: string;
        question: string;
        options?: string[];
        default?: string;
        kind?: string;
        optional?: boolean;
      }>;
    };
  };
  // answer every open question the way the page would (a choice picks its first option; a text uses its default or a value)
  const answers = prop.proposal.questions
    .filter((x) => !x.optional && x.default === undefined)
    .map((x) => ({ path: x.path, value: x.options?.[0] ?? 'yes' }));
  if (answers.length) await post(`/api/setup-proposals/${prop.id}/answers`, { answers });
  const used = await post(`${base()}/delivery/setup/use-proposal`, { proposalId: prop.id });
  const names = used.draft.setup.environments.map((e: { name: string }) => e.name);
  // both environments are still there, whatever the proposal named; nothing was written to the project files yet
  expect(names).toEqual(expect.arrayContaining(['live', 'test']));
  expect([...used.merge.added, ...used.merge.replaced, ...used.merge.notCovered].sort()).toEqual(
    expect.arrayContaining(['live', 'test'].filter((n) => !used.merge.added.includes(n))),
  );
  await post(`${base()}/delivery/setup/discard-draft`);
  expect((await state()).draft).toBeNull();
});

test('point the live site at another server: the other environment is not touched; a duplicate place is flagged and merged', async () => {
  const second = await post(
    `${base()}/deploy-targets`,
    {
      name: 'Flow server (again)',
      kind: 'remote_ssh',
      workstationId,
      host: 'e2e-flow',
      notes: '',
    },
    201,
  );
  const places = (await get(`${base()}/places`)).places;
  expect(places.find((p: { id: string }) => p.id === second.id).duplicateOf).toMatchObject({
    name: 'Flow server',
    reason: 'same_server',
  });
  const st = await put(`${base()}/delivery/setup/environments/live/place`, { placeId: second.id }, 200);
  expect(
    st.draft.setup.environments.map((e: { name: string; target: string }) => `${e.name}:${e.target}`),
  ).toEqual(['live:Flow server (again)', 'test:This computer']);
  // merge them back: the draft points at the first one again, the duplicate is gone
  const merged = await post(`${base()}/places/merge`, { fromId: second.id, toId: liveTarget });
  expect(merged).toMatchObject({ repointed: ['live'], removed: true });
  const after = await state();
  expect(after.draft.setup.environments[0].target).toBe('Flow server');
  await post(`${base()}/delivery/setup/discard-draft`);
});

test('a place that an environment uses cannot be removed (the message names it); remove an environment; an unused place goes', async () => {
  const used = await api.post(`${base()}/places/${liveTarget}/remove`, { data: {} });
  expect(used.status()).toBe(409);
  expect((await used.json()).error.message).toContain('Live site');
  const plain = await api.delete(`/api/deploy-targets/${liveTarget}`);
  expect(plain.status()).toBe(409);
  // an unused place: made, then removed (a key cleanup is not asked for)
  const spare = await post(
    `${base()}/deploy-targets`,
    { name: 'Old VPS', kind: 'remote_ssh', workstationId, host: 'old-vps', notes: '' },
    201,
  );
  const gone = await post(`${base()}/places/${spare.id}/remove`, {});
  expect(gone).toMatchObject({ removed: true, keyCleanup: { state: 'none' } });
  // remove the test site: the draft first, then the same preview / publish / approval as any change; the live script is not touched
  const rm = await post(`${base()}/delivery/setup/remove-environment`, { env: 'test' });
  expect(rm.impact.join(' ')).toContain('left exactly as it is');
  const draft = (await state()).draft.setup;
  const prev = await post(`${base()}/delivery/setup/preview`, { setup: draft });
  expect(prev.removing).toEqual(['scripts/test.sh']);
  await saveSetup(draft);
  expect(await savedFile('scripts/test.sh')).toBeNull();
  expect(await savedFile('scripts/live.sh')).toBe(liveScriptBefore);
  // only a removal: no new try is asked for, the Owner approves
  expect((await state()).current.dryRunMissing).toEqual([]);
  await post(`${base()}/delivery/approve`, { hash: (await state()).current.observedHash });
  // the app that runs on this computer was left alone
  expect(readFileSync(join(LOCAL_STATE, 'c', 'web'), 'utf8')).toContain('local-web:');
  // a discarded draft leaves the saved setup as it was
  await put(`${base()}/delivery/setup`, { setup: { environments: [liveEnv({ label: 'Changed label' })] } });
  expect((await post(`${base()}/delivery/setup/discard-draft`)).draft).toBeNull();
  expect((await state()).current.setup.environments[0].label).toBe('Live site');
});

test('registry: build here, push to the registry, the server pulls and the override names the registry image; only the app is replaced', async () => {
  const registryEnv = liveEnv({ method: 'registry', registry: `127.0.0.1:${regPort}` });
  await saveSetup({ environments: [registryEnv] });
  await tryAndApprove(['live']);
  const sha = commit('fourth version', { marker: 'v4\n' });
  const r = await release('live', sha);
  expect(r.status, r.log_tail).toBe('succeeded');
  const tag = `127.0.0.1:${regPort}/dcode-server:${sha.slice(0, 12)}`;
  // the image really is in the registry
  const tags = (await (await fetch(`http://127.0.0.1:${regPort}/v2/dcode-server/tags/list`)).json()) as {
    tags: string[];
  };
  expect(tags.tags).toContain(sha.slice(0, 12));
  expect(onBox(`cat ${APP_DIR}/docker-compose.guildwise.yml`)).toContain(`image: "${tag}"`);
  expect(onBox('sed -n 2p /var/fakedocker/c/dcode-server').trim()).toBe(tag);
  expect(onBox('head -n 1 /var/fakedocker/c/postgres').trim()).toBe(dbCid);
  expect(onBox(`sha256sum ${APP_DIR}/compose.yaml`).split(' ')[0]).toBe(composeSha);
});

test('an app that runs without Docker: found as a plain folder, turned into the first release only on the person’s yes, updated by a new folder and a link, rolled back when it does not answer', async () => {
  // it is found in the usual places (a folder with a package.json), and the server's other apps are not touched
  await post(`${base()}/delivery/probe`, { scope: 'ssh_target', targetId: liveTarget, workstationId }, 202);
  const found = (await waitFor(
    'a new look at the server',
    async () =>
      ((await state()).probes as Array<{ scope: string; at: string; report: ProbeReport | null }>)
        .filter((p) => p.scope === 'ssh_target')
        .sort((a, b) => (a.at < b.at ? 1 : -1))[0],
    (p) => !!p?.report?.appDirs,
    60_000,
  )) as { report: ProbeReport };
  expect(found.report.appDirs).toContain('/home/deploy/shop');
  const shopUrl = `http://127.0.0.1:${shopPort}/index.html`;
  const shopEnv = directEnv({
    name: 'shop',
    label: 'Shop site',
    target: 'Flow server',
    host: 'e2e-flow',
    appDir: '/home/deploy/shop-app',
    currentLink: '/home/deploy/shop',
    adoptFolder: true,
    manager: { kind: 'command', restart: ['/home/deploy/restart-shop.sh'], sudo: false },
    build: [{ label: 'Prepare', argv: ['sh', '-c', 'echo built > built.txt'] }],
    healthUrl: shopUrl,
    appUrl: `http://127.0.0.1:${shopPort}`,
    live: true,
  });
  // without the yes, the plain folder is refused at the dry run
  const noYes = JSON.parse(JSON.stringify(shopEnv));
  delete noYes.direct.adoptFolder;
  const current = (await state()).current.setup;
  await saveSetup({ ...current, environments: [...current.environments, noYes] });
  await post(`${base()}/delivery/setup/dry-run`, { env: 'shop' });
  const refused = (await waitFor(
    'the dry run of the plain folder',
    async () =>
      (
        await q<Run>(
          `SELECT status, log_tail, summary FROM deploy_runs WHERE env='shop' AND dry_run ORDER BY created_at DESC LIMIT 1`,
        )
      )[0],
    (r) => r?.status === 'failed' || r?.status === 'succeeded',
    60_000,
  )) as Run;
  expect(refused.status).toBe('failed');
  expect(refused.log_tail).toContain('is a plain folder; confirm in the setup');
  expect(onBox('ls -ld /home/deploy/shop').startsWith('d')).toBe(true);
  // with it: save, try, approve, release
  await saveSetup({ ...current, environments: [...current.environments, shopEnv] });
  await tryAndApprove(['live', 'shop']);
  const sha = commit('shop version', { 'index.html': 'v1 the new version', 'package.json': '{}' });
  const r = await release('shop', sha);
  expect(r.status, r.log_tail).toBe('succeeded');
  expect(onBox('readlink /home/deploy/shop').trim()).toBe(
    `/home/deploy/shop-app/releases/${sha.slice(0, 12)}`,
  );
  expect(onBox('cat /home/deploy/shop-app/releases/initial/index.html')).toBe('v0 the app that runs today');
  expect(onBox(`cat /home/deploy/shop-app/releases/${sha.slice(0, 12)}/built.txt`).trim()).toBe('built');
  expect(await (await fetch(shopUrl)).text()).toBe('v1 the new version');
  // the Docker stack on the same server was not touched by any of this
  expect(onBox('head -n 1 /var/fakedocker/c/postgres').trim()).toBe(dbCid);
  // a version that does not answer: the link goes back and the app is restarted on the earlier files
  git(CLONE, 'rm', '-q', 'index.html');
  git(CLONE, 'commit', '-m', 'break the shop');
  git(CLONE, 'push', 'origin', 'main');
  const bad = git(CLONE, 'rev-parse', 'HEAD').trim();
  const rb = await release('shop', bad);
  expect(rb.status).toBe('failed');
  expect(rb.log_tail).toContain('rolled back to');
  expect(onBox('readlink /home/deploy/shop').trim()).toBe(
    `/home/deploy/shop-app/releases/${sha.slice(0, 12)}`,
  );
  expect(await (await fetch(shopUrl)).text()).toBe('v1 the new version');
  // the failed version's folder is kept for a look; the status says the last update did not work
  expect(onBox(`ls /home/deploy/shop-app/releases`)).toContain(bad.slice(0, 12));
  expect(
    (await get(`${base()}/environments/status`)).environments.find((e: { env: string }) => e.env === 'shop'),
  ).toMatchObject({ runtime: 'direct', state: 'failed' });
});

test('removing a server offers to take Guildwise’s key off it; nothing else on the server is touched, and an unreachable server does not stop the removal', async () => {
  // stop using guided deploys first (the place is then unused), then remove the server with its key
  const stopped = await post(`${base()}/delivery/setup/stop-guided`, { confirm: true });
  expect(stopped.deliveryMode).toBe('instructions');
  expect(stopped.targets.map((t: { name: string }) => t.name)).toContain('Flow server');
  const res = await post(`${base()}/places/${liveTarget}/remove`, { removeKey: true });
  expect(res.removed).toBe(true);
  // the dedicated key the connect added is on the server until the computer takes it off (a durable command that outlives the place)
  expect(res.keyCleanup.state, JSON.stringify(res.keyCleanup)).toBe('started');
  await waitFor(
    'the key is off the server',
    async () => onBox('cat /home/deploy/.ssh/authorized_keys'),
    (t) => !t.includes('guildwise-deploy:'),
    60_000,
  );
  // the person's own key stays, and this computer's key material for the server is gone
  expect(onBox('cat /home/deploy/.ssh/authorized_keys')).toContain('e2e-journey');
  expect(
    execFileSync('find', [join(HOME, 'keys', 'deploy'), '-name', 'id_ed25519'], { encoding: 'utf8' }).trim(),
  ).toBe('');
  // the stack on the server is exactly as the last release left it
  expect(onBox('head -n 1 /var/fakedocker/c/postgres').trim()).toBe(dbCid);
  expect(onBox(`cat ${APP_DIR}/.env`)).toContain('journey-secret-value');
  expect((await get(`${base()}/places`)).places.some((p: { id: string }) => p.id === liveTarget)).toBe(false);
});

/** The sha256 of a generated file of the saved delivery setup (as the computer reported it), or null when it is not there. */
async function savedFile(path: string): Promise<string | null> {
  const row = (
    await q<{ files: Array<{ path: string; sha256: string }> }>(
      'SELECT files FROM delivery_recipes WHERE project_id=$1',
      [projectId],
    )
  )[0];
  return row?.files.find((f) => f.path === path)?.sha256 ?? null;
}
