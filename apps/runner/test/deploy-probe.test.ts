import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DeployProbePayload, ProbeReportSchema, STATE_PATHS_FN } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
  buildServices,
  markUnsupportedStacks,
  parseContainerLine,
  parsePorts,
  parseSshConfigHosts,
  runDeployProbe,
} from '../src/delivery/probe.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

const PROJECT = '019da000-0000-7000-8000-000000000003';
const SECRET = 's3cr3t-db-password-VALUE';

/** A folder of fake executables. Each one logs its arguments to $FAKE_LOG, then behaves like the script says. */
function fakeBin(scripts: Record<string, string>): {
  dir: string;
  env: NodeJS.ProcessEnv;
  log: () => string[];
} {
  const dir = tmp('aom-fakebin-');
  const logFile = join(dir, 'calls.log');
  writeFileSync(logFile, '');
  // nothing of the machine that runs the tests is seen: no systemd units, no listening programs, no app folders
  const quiet = { systemctl: 'exit 1', ss: 'exit 1', pm2: 'exit 1' };
  for (const [name, body] of Object.entries({ ...quiet, ...scripts })) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/bash\necho "${name} $*" >> "${logFile}"\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return {
    dir,
    // only the fake folder and the basic tools: a binary that is not faked is missing
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, FAKE_LOG: logFile, AOM_PROBE_APP_ROOTS: dir },
    log: () => readFileSync(logFile, 'utf8').split('\n').filter(Boolean),
  };
}

const TAB = '\t';
const container = (
  name: string,
  image: string,
  state: string,
  ports: string,
  project = '',
  service = '',
  files = '',
  wd = '',
) =>
  [
    'CONTAINER',
    name,
    image,
    state,
    `${state === 'running' ? 'Up 3 days' : 'Exited'}`,
    ports,
    project,
    service,
    files,
    wd,
  ].join(TAB);

const DOCKER_OK = (composeFile: string) => `
case "$1 $2" in
  "version --format") echo "29.1.2" ;;
  "compose version") echo "2.40.0" ;;
  "compose ls") echo '[{"Name":"aom-uat","Status":"running(3)","ConfigFiles":"${composeFile}"}]' ;;
  "volume ls") printf 'aom-uat_pgdata\\nother_data\\n' ;;
  "ps --all")
    printf '%s\\n' "${container('aom-uat-app-1', 'aom-uat-app', 'running', '0.0.0.0:4700->4600/tcp, [::]:4700->4600/tcp', 'aom-uat', 'app', composeFile, '/x')}"
    printf '%s\\n' "${container('aom-uat-postgres-1', 'postgres:18', 'running', '5432/tcp', 'aom-uat', 'postgres', composeFile, '/x')}"
    printf '%s\\n' "${container('lonely', 'redis:7', 'exited', '', '', '', '', '')}" ;;
  *) echo "fake docker: unexpected $*" >&2; exit 2 ;;
esac`;

const COMPOSE_TEXT = `name: aom-uat
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD: ${SECRET}
      POSTGRES_USER: aom
    volumes:
      - pgdata:/var/lib/postgresql
  app:
    build: /home/user/src/app
    environment:
      DATABASE_URL: postgres://aom:${SECRET}@postgres:5432/aom
      PUBLIC_ORIGIN: \${AOM_ORIGIN:-http://localhost:4700}
    env_file: secret.env
    ports:
      - "0.0.0.0:4700:4600"
volumes:
  pgdata:
`;

const payload = (over: Partial<DeployProbePayload> = {}): DeployProbePayload => ({
  projectId: PROJECT,
  scope: 'local',
  ...over,
});

describe('deploy.probe: apps that run without Docker', () => {
  const FAKE_SYSTEMCTL = `
case "$*" in
  *"--user"*) exit 1 ;;
  *"list-units"*) printf 'shop.service loaded active running Shop\\nnginx.service loaded active running nginx\\n' ;;
  *"show shop.service"*) printf 'MainPID=4242\\nUser=shop\\nWorkingDirectory=%s\\nExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node server.js --token=abc123 --port 3000 ; ignore_errors=no }\\n' "$FAKE_APP/current" ;;
  *"show nginx.service"*) printf 'MainPID=1\\nUser=root\\nWorkingDirectory=\\nExecStart={ path=/usr/sbin/nginx ; argv[]=/usr/sbin/nginx ; }\\n' ;;
  *) exit 1 ;;
esac`;
  const FAKE_SS = `printf 'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("node",pid=4242,fd=19))\\nLISTEN 0 511 0.0.0.0:9100 0.0.0.0:* users:(("worker",pid=777,fd=3))\\n'`;
  const FAKE_PM2 = `printf '[{"name":"api","pm2_env":{"status":"online","pm_cwd":"%s","pm_exec_path":"%s/index.js","username":"shop"}}]' "$FAKE_APP2" "$FAKE_APP2"`;

  it('lists systemd units, pm2 processes and listening programs of the usual places, and app folders, without any secret', async () => {
    const root = tmp('aom-probe-direct-');
    const app = join(root, 'app');
    const app2 = join(root, 'apps', 'api');
    mkdirSync(join(app, 'releases', 'abc'), { recursive: true });
    mkdirSync(app2, { recursive: true });
    writeFileSync(join(app2, 'package.json'), '{}');
    const fake = fakeBin({
      docker: 'exit 127',
      systemctl: FAKE_SYSTEMCTL,
      ss: FAKE_SS,
      pm2: FAKE_PM2,
      readlink:
        'case "$1" in /proc/777/cwd) echo "$FAKE_ROOT_HOME/worker-dir" ;; /proc/4242/cwd) echo "$FAKE_APP/current" ;; *) /usr/bin/readlink "$@" ;; esac',
    });
    mkdirSync(join(root, 'worker-dir'), { recursive: true });
    const env = {
      ...fake.env,
      HOME: root,
      FAKE_APP: app,
      FAKE_APP2: app2,
      FAKE_ROOT_HOME: root,
      AOM_PROBE_APP_ROOTS: `${root} ${join(root, 'apps')}`,
    };
    const r = await runDeployProbe(payload(), { env, home: root, hintRoots: [] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const svc = r.report.services ?? [];
    expect(svc.map((s) => `${s.manager}:${s.name}`)).toEqual(
      expect.arrayContaining(['systemd:shop.service', 'pm2:api', 'process:worker']),
    );
    const shop = svc.find((s) => s.name === 'shop.service');
    expect(shop).toMatchObject({
      workingDir: `${app}/current`,
      user: 'shop',
      ports: [3000],
      releaseLayout: true,
    });
    // the command is shortened and nothing that looks like a value survives
    expect(shop?.command).toBe('/usr/bin/node server.js --port 3000');
    expect(JSON.stringify(r)).not.toContain('abc123');
    // a unit that runs elsewhere (nginx, no working folder) is not offered
    expect(svc.some((s) => s.name === 'nginx.service')).toBe(false);
    expect(r.report.appDirs).toEqual(expect.arrayContaining([app, app2]));
    // Docker is not installed here, and the report still comes because there are apps
    expect(r.report.docker).toMatchObject({ installed: true, usable: false });
  });

  it('a machine with no Docker and no apps is still "Docker is missing"', async () => {
    const root = tmp('aom-probe-direct-');
    const r = await runDeployProbe(payload(), {
      env: { PATH: '/nonexistent-bin', HOME: root, AOM_PROBE_APP_ROOTS: root },
      home: root,
      hintRoots: [],
    });
    expect(r).toEqual({ ok: false, error: 'docker_missing' });
  });
});

describe('deploy.probe: local Docker', () => {
  it('finds a stack in a folder under the home folder without labels, and lists where it looked', async () => {
    const root = tmp('aom-probe-home-');
    const mine = join(root, 'projects', 'shop');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'compose.yaml'), 'services:\n  web:\n    image: nginx:1\n');
    mkdirSync(join(root, '.ssh'), { recursive: true });
    writeFileSync(join(root, '.ssh', 'compose.yaml'), 'services: {}\n');
    const fake = fakeBin({ docker: 'case "$1" in version) echo 29;; info) exit 0;; esac' });
    const r = await runDeployProbe(payload(), { env: fake.env, home: root, hintRoots: [] });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.report.composeFiles.map((c) => c.path)).toEqual([join(mine, 'compose.yaml')]);
    expect(r.report.checked).toContain(`${root}/*/*`);
    // a folder the person typed is looked at as well
    const typed = join(root, 'elsewhere');
    mkdirSync(typed, { recursive: true });
    writeFileSync(join(typed, 'docker-compose.yml'), 'services:\n  api:\n    image: api:1\n');
    const r2 = await runDeployProbe(payload({ hints: { dirs: [typed] } }), {
      env: fake.env,
      home: root,
      hintRoots: [],
    });
    expect(r2.ok && r2.report.composeFiles.map((c) => c.path)).toContain(join(typed, 'docker-compose.yml'));
    expect(r2.ok && r2.report.checked).toContain(typed);
  });

  it('reports containers, volumes, compose structure and backups, and never a secret value', async () => {
    const root = tmp('aom-probe-home-');
    const dir = join(root, 'uat');
    mkdirSync(join(dir, 'backups'), { recursive: true });
    writeFileSync(join(dir, 'docker-compose.yml'), COMPOSE_TEXT);
    writeFileSync(join(dir, 'secret.env'), `API_KEY=${SECRET}\n`);
    writeFileSync(join(dir, 'backups', 'uat-before-abc.sql.gz'), 'x');
    const fake = fakeBin({ docker: DOCKER_OK(join(dir, 'docker-compose.yml')) });
    const statusAt: string[] = [];
    const r = await runDeployProbe(
      payload({ hints: { dirs: [dir], urls: ['http://localhost:4700/api/health'] } }),
      {
        env: fake.env,
        home: root,
        fetchImpl: (async (u: string) => {
          statusAt.push(u);
          return new Response('ok', { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rep = ProbeReportSchema.parse(r.report);
    expect(rep.docker).toMatchObject({
      installed: true,
      usable: true,
      version: '29.1.2',
      composeVersion: '2.40.0',
    });
    expect(rep.containers.map((c) => c.name)).toEqual(['aom-uat-app-1', 'aom-uat-postgres-1', 'lonely']);
    expect(rep.containers[0]).toMatchObject({
      project: 'aom-uat',
      service: 'app',
      ports: [{ host: 4700, container: 4600, bind: '0.0.0.0' }],
    });
    expect(rep.volumes).toEqual(['aom-uat_pgdata', 'other_data']);
    const cf = rep.composeFiles[0];
    expect(cf).toMatchObject({ project: 'aom-uat', volumes: ['pgdata'] });
    expect(cf?.services.map((s) => s.name)).toEqual(['postgres', 'app']);
    expect(cf?.services[0]).toMatchObject({
      image: 'postgres:18',
      database: 'postgres',
      volumes: ['pgdata'],
    });
    expect(cf?.services[1]).toMatchObject({
      build: '/home/user/src/app',
      envFiles: ['secret.env'],
      vars: ['AOM_ORIGIN'],
    });
    expect(rep.backups).toEqual([
      expect.objectContaining({ dir: join(dir, 'backups'), count: 1, newestName: 'uat-before-abc.sql.gz' }),
    ]);
    expect(rep.urls).toEqual([{ url: 'http://localhost:4700/api/health', status: 200 }]);
    // nothing secret in the whole report, and nothing was started or changed
    const text = JSON.stringify(r);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('POSTGRES_PASSWORD');
    for (const c of fake.log().filter((x) => x.startsWith('docker ')))
      expect(c).toMatch(/^docker (version|compose version|compose ls|ps|volume ls)/);
  });

  it('Docker missing and Docker not allowed are separate answers', async () => {
    const none = await runDeployProbe(payload(), { env: { PATH: '/nonexistent-bin' }, home: tmp() });
    expect(none).toEqual({ ok: false, error: 'docker_missing' });
    const denied = fakeBin({
      docker: 'echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1',
    });
    expect(await runDeployProbe(payload(), { env: denied.env, home: tmp() })).toEqual({
      ok: false,
      error: 'docker_permission',
    });
    const down = fakeBin({ docker: 'echo "Cannot connect to the Docker daemon" >&2; exit 1' });
    const r = await runDeployProbe(payload(), { env: down.env, home: tmp() });
    expect(r.ok && r.report.docker).toMatchObject({ installed: true, usable: false });
  });

  it('a hostile compose file is reduced to structure or marked unreadable', async () => {
    const root = tmp('aom-probe-home-');
    const bomb = join(root, 'bomb.yml');
    writeFileSync(bomb, `a: &a ["x"]\n${Array.from({ length: 80 }, (_, i) => `b${i}: *a`).join('\n')}\n`);
    const big = join(root, 'big.yml');
    writeFileSync(big, `services:\n  a:\n    image: ${'x'.repeat(1_100_000)}\n`);
    const fake = fakeBin({
      docker: `
case "$1 $2" in
  "version --format") echo 29 ;;
  "compose version") echo 2 ;;
  "compose ls") echo '[{"Name":"p","ConfigFiles":"${bomb},${big}"}]' ;;
  *) ;;
esac`,
    });
    const r = await runDeployProbe(payload(), { env: fake.env, home: root });
    expect(r.ok && r.report.composeFiles.map((c) => c.unreadable)).toEqual([
      expect.any(String),
      'the file is too big to read',
    ]);
  });
});

describe('deploy.probe: ssh hosts', () => {
  const CONFIG = `Host prod-server
  HostName 192.0.2.10
  User root
  IdentitiesOnly yes
  IdentityFile ~/.ssh/guildwise_ed25519
Host *.internal
  User nobody
Host newbox
Host changed asks timeout down
Host *
  ServerAliveInterval 30
`;
  const SSH = `
# OpenSSH reads ~/.ssh/config through the account database, not $HOME: every call must name its config with -F
[ "$1" = "-F" ] || { echo "ssh called without an explicit -F" >&2; exit 99; }
g=""; for a in "$@"; do [ "$a" = "-G" ] && g=1; done
if [ -n "$g" ]; then
  last=""; for a in "$@"; do last="$a"; done
  echo "hostname host-$last.example.net"; echo "user deploy"; echo "port 22"; echo "identityfile ~/.ssh/id_ed25519"
  exit 0
fi
# the connect test: ssh <opts> -- <alias> true
alias=""
for a in "$@"; do alias="$a"; done
prev=""; for a in "$@"; do [ "$a" = "true" ] && break; prev="$a"; done
case "$prev" in
  prod-server|newbox) exit 0 ;;
  changed) echo "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@
@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @" >&2; exit 255 ;;
  asks) echo "deploy@asks: Permission denied (publickey,password)." >&2; exit 255 ;;
  timeout) echo "ssh: connect to host timeout port 22: Connection timed out" >&2; exit 255 ;;
  down) echo "ssh: Could not resolve hostname down: Name or service not known" >&2; exit 255 ;;
esac
exit 255`;

  it('lists the aliases of ~/.ssh/config, tests each without a prompt, and classifies the answers', async () => {
    const home = tmp('aom-probe-home-');
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'config'), CONFIG);
    const keyFile = join(home, '.ssh', 'guildwise_ed25519');
    writeFileSync(keyFile, 'PRIVATE-KEY-MATERIAL', { mode: 0o600 });
    const before = statSync(keyFile).atimeMs;
    const fake = fakeBin({ ssh: SSH });
    const r = await runDeployProbe(payload({ scope: 'ssh_hosts' }), {
      env: { ...fake.env, HOME: home },
      home,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byAlias = Object.fromEntries((r.report.sshHosts ?? []).map((h) => [h.alias, h]));
    expect(Object.keys(byAlias).sort()).toEqual([
      'asks',
      'changed',
      'down',
      'prod-server',
      'newbox',
      'timeout',
    ]);
    expect(byAlias['prod-server']).toMatchObject({
      state: 'reachable',
      hostname: 'host-prod-server.example.net',
      user: 'deploy',
      port: 22,
      hasIdentity: true,
    });
    expect(byAlias.newbox).toMatchObject({ state: 'reachable', hasIdentity: false });
    expect(byAlias.changed?.state).toBe('host_key_changed');
    expect(byAlias.asks?.state).toBe('asks_password');
    expect(byAlias.timeout?.state).toBe('unreachable');
    expect(byAlias.down?.state).toBe('unreachable');
    // the safety rules: never a prompt, strict host keys, nothing forwarded, the key file untouched
    const connects = fake.log().filter((c) => c.endsWith(' true'));
    expect(connects.length).toBe(6);
    for (const c of connects) {
      expect(c).toContain('BatchMode=yes');
      expect(c).toContain('StrictHostKeyChecking=yes');
      expect(c).toContain('ForwardAgent=no');
    }
    expect(JSON.stringify(r)).not.toContain('PRIVATE-KEY-MATERIAL');
    expect(statSync(keyFile).atimeMs).toBe(before);
    expect(readFileSync(join(home, '.ssh', 'config'), 'utf8')).toBe(CONFIG);
  });

  it('no config means no aliases, not an error', async () => {
    const home = tmp('aom-probe-home-');
    const r = await runDeployProbe(payload({ scope: 'ssh_hosts' }), { env: fakeBin({ ssh: SSH }).env, home });
    expect(r.ok && r.report.sshHosts).toEqual([]);
  });

  it('parses aliases and skips wildcards, negations and Match blocks', () => {
    expect(parseSshConfigHosts(CONFIG)).toEqual([
      { alias: 'prod-server', hasIdentity: true },
      { alias: 'newbox', hasIdentity: false },
      { alias: 'changed', hasIdentity: false },
      { alias: 'asks', hasIdentity: false },
      { alias: 'timeout', hasIdentity: false },
      { alias: 'down', hasIdentity: false },
    ]);
    expect(
      parseSshConfigHosts('Host a !b c*\nMatch host x\n  IdentityFile k\nHost d\n').map((h) => h.alias),
    ).toEqual(['a', 'd']);
  });
});

describe('deploy.probe: a server over ssh', () => {
  // The fake ssh runs the remote command locally: the probe script really runs, against a temp "server" folder.
  const SSH_LOCAL = `
cmd=""; for a in "$@"; do cmd="$a"; done
case "$cmd" in
  "sh -s --"*) exec sh -c "$cmd" ;;
esac
exit 255`;

  it('hinted folders and compose files outside where apps live are ignored; only an image variable a compose file uses is reported', async () => {
    const server = tmp('aom-server-');
    const app = join(server, 'guildwise');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'docker-compose.yml'), 'services:\n  app:\n    image: ${GUILDWISE_IMAGE}\n');
    writeFileSync(
      join(app, '.env'),
      'GUILDWISE_IMAGE=guildwise-hq:1\nSECRET_IMAGE_TOKEN=hunter2hunter2\nOTHER_IMAGE=x\n',
    );
    const fake = fakeBin({ ssh: SSH_LOCAL, docker: 'case "$1" in version) echo 29;; info) exit 0;; esac' });
    const r = await runDeployProbe(
      payload({
        scope: 'ssh_target',
        host: 'prod',
        hints: {
          dirs: [app, '/etc', '/home/other', '/root/.ssh'],
          composeFiles: ['/etc/shadow', '/home/other/docker-compose.yml', `${app}/docker-compose.yml`],
        },
      }),
      { env: fake.env, home: server, hintRoots: [server] },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const ssh = fake.log().find((c) => c.startsWith('ssh ')) ?? '';
    expect(ssh).toContain(app);
    for (const bad of ['/etc', '/home/other', '/root/.ssh', 'shadow']) expect(ssh).not.toContain(bad);
    if (!r.ok) return;
    const folder = r.report.folders.find((f) => f.path === app);
    expect(folder?.imageVars).toEqual([{ name: 'GUILDWISE_IMAGE', value: 'guildwise-hq:1' }]);
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });

  it('runs the read-only probe script and builds the report from its output', async () => {
    const server = tmp('aom-server-');
    const app = join(server, 'guildwise');
    mkdirSync(join(app, 'backups'), { recursive: true });
    writeFileSync(
      join(app, 'docker-compose.yml'),
      COMPOSE_TEXT.replaceAll('/home/user/src/app', '/srv/app').replace(
        'build:',
        'image: ${GUILDWISE_IMAGE}\n    #',
      ),
    );
    writeFileSync(
      join(app, '.env'),
      `GUILDWISE_IMAGE=guildwise-hq:4f2c1ab\nDATABASE_PASSWORD=${SECRET}\nexport OTHER=1\n`,
    );
    writeFileSync(join(app, 'backups', 'production-before-4f2c1ab.sql.gz'), 'x');
    writeFileSync(join(app, 'Caddyfile'), 'hq.example.com {\n  reverse_proxy app:4600\n}\n');
    const fake = fakeBin({
      ssh: SSH_LOCAL,
      docker: `
case "$1" in
  version) echo 29.1.2 ;;
  info) exit 0 ;;
  compose) [ "$2" = version ] && echo 2.40.0 ;;
  ps) printf '%s\\n' "${container('guildwise-app-1', 'guildwise-hq:4f2c1ab', 'running', '4600/tcp', 'guildwise', 'app', join(app, 'docker-compose.yml'), app)}" "${container('caddy', 'caddy:2', 'running', '0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp')}" ;;
  volume) echo 'VOLUME guildwise_pgdata' ;;
esac`,
    });
    const before = readFileSync(join(app, '.env'), 'utf8');
    const asked: string[] = [];
    const r = await runDeployProbe(
      payload({
        scope: 'ssh_target',
        host: 'prod-server',
        hints: { dirs: [app], urls: ['https://hq.example.com/ready'] },
      }),
      {
        env: fake.env,
        home: server,
        hintRoots: [server],
        fetchImpl: (async (u: string) => {
          asked.push(u);
          return new Response('ok', { status: 200 });
        }) as unknown as typeof fetch,
      },
    );
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const rep = r.report;
    expect(rep).toMatchObject({
      scope: 'ssh_target',
      host: 'prod-server',
      docker: { installed: true, usable: true, version: '29.1.2' },
    });
    expect(rep.containers.map((c) => c.name)).toEqual(['guildwise-app-1', 'caddy']);
    expect(rep.volumes).toEqual(['guildwise_pgdata']);
    const folder = rep.folders.find((f) => f.path === app);
    expect(folder).toMatchObject({
      exists: true,
      imageVars: [{ name: 'GUILDWISE_IMAGE', value: 'guildwise-hq:4f2c1ab' }],
    });
    expect(folder?.envKeys).toEqual(['GUILDWISE_IMAGE', 'DATABASE_PASSWORD', 'OTHER']);
    expect(folder?.entries).toContain('docker-compose.yml');
    expect(rep.backups).toEqual([expect.objectContaining({ dir: join(app, 'backups'), count: 1 })]);
    expect(rep.composeFiles[0]?.project).toBe('guildwise');
    expect(rep.composeFiles[0]?.services.map((s) => s.name)).toEqual(['postgres', 'app']);
    expect(rep.proxies).toEqual([
      expect.objectContaining({ kind: 'caddy', via: 'container', name: 'caddy', sites: ['hq.example.com'] }),
    ]);
    // the public address is asked from this computer, status only
    expect(rep.urls).toEqual([{ url: 'https://hq.example.com/ready', status: 200 }]);
    expect(asked).toEqual(['https://hq.example.com/ready']);
    // values of .env and compose never leave the server, and the probe changed nothing there
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe(before);
    const sshCalls = fake.log().filter((c) => c.startsWith('ssh '));
    expect(sshCalls).toHaveLength(1);
    expect(sshCalls[0]).toContain('BatchMode=yes');
    expect(sshCalls[0]).toContain('StrictHostKeyChecking=yes');
    expect(
      fake
        .log()
        .filter((c) => c.startsWith('docker '))
        .every((c) => /^docker (version|info|compose version|ps|volume ls)/.test(c)),
    ).toBe(true);
  });

  it('finds a stack outside /opt and /srv from the container labels and from $HOME, with no hints', async () => {
    const server = tmp('aom-server-');
    const flow = join(server, 'dcode', 'flow5-full');
    const other = join(server, 'tools');
    mkdirSync(flow, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(flow, 'compose.yaml'),
      'services:\n  dcode-server:\n    image: dcode-server:remote29-showcase-abc\n    ports:\n      - "5500:500"\n  postgres:\n    image: postgres:18\n',
    );
    writeFileSync(join(flow, '.env'), `POSTGRES_PASSWORD=${SECRET}\nTOKEN=x\n`);
    writeFileSync(join(other, 'docker-compose.yml'), 'services:\n  web:\n    image: nginx:1\n');
    const fake = fakeBin({
      ssh: SSH_LOCAL,
      docker: `
case "$1" in
  version) echo 29.1.2 ;;
  info) exit 0 ;;
  compose) [ "$2" = version ] && echo 2.40.0 ;;
  ps) printf '%s\\n' "${container('dcode-flow5-remote-dcode-server-1', 'dcode-server:remote29-showcase-abc', 'running', '0.0.0.0:5500->500/tcp', 'dcode-flow5-remote', 'dcode-server', join(flow, 'compose.yaml'), flow)}" "${container('portainer', 'portainer/portainer-ce', 'running', '9000/tcp')}" ;;
esac`,
    });
    const r = await runDeployProbe(payload({ scope: 'ssh_target', host: 'srv' }), {
      env: { ...fake.env, HOME: server },
      home: server,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    const files = r.report.composeFiles.map((c) => c.path);
    expect(files).toContain(join(flow, 'compose.yaml'));
    expect(files).toContain(join(other, 'docker-compose.yml'));
    const f = r.report.folders.find((x) => x.path === flow);
    expect(f?.envKeys).toEqual(['POSTGRES_PASSWORD', 'TOKEN']);
    const cf = r.report.composeFiles.find((c) => c.path === join(flow, 'compose.yaml'));
    expect(cf?.project).toBe('dcode-flow5-remote');
    expect(cf?.services.map((x) => x.name)).toEqual(['dcode-server', 'postgres']);
    expect(JSON.stringify(r)).not.toContain(SECRET);
    // where it looked is part of the answer, so "nothing found" can say so
    expect(r.report.checked).toEqual(expect.arrayContaining(['/opt/*', '/srv/*', flow]));
  });

  it('each ssh failure has its own error; a changed host key is a hard stop', async () => {
    const cases: Array<[string, string]> = [
      ['@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @', 'ssh_host_key_changed'],
      [
        'No ED25519 host key is known for srv and you have requested strict checking.\nHost key verification failed.',
        'ssh_host_key_unknown',
      ],
      ['srv: Permission denied (publickey).', 'ssh_auth'],
      ['ssh: connect to host srv port 22: Connection refused', 'ssh_unreachable'],
    ];
    for (const [stderr, error] of cases) {
      const fake = fakeBin({ ssh: `echo '${stderr.replaceAll("'", '')}' >&2; exit 255` });
      const r = await runDeployProbe(payload({ scope: 'ssh_target', host: 'srv' }), {
        env: fake.env,
        home: tmp(),
      });
      expect(r).toMatchObject({ ok: false, error });
    }
  });

  it('refuses a host name that is not a plain alias, and times out cleanly', async () => {
    const fake = fakeBin({ ssh: 'sleep 5' });
    expect(
      await runDeployProbe(payload({ scope: 'ssh_target', host: '-oProxyCommand=x' }), { env: fake.env }),
    ).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await runDeployProbe(payload({ scope: 'ssh_target' }), { env: fake.env })).toMatchObject({
      ok: false,
      error: 'bad_request',
    });
    const t0 = Date.now();
    const r = await runDeployProbe(payload({ scope: 'ssh_target', host: 'slow' }), {
      env: fake.env,
      totalMs: 300,
    });
    expect(r).toMatchObject({ ok: false, error: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2500);
  });
});

describe('parsers', () => {
  it('ports and container lines', () => {
    expect(parsePorts('0.0.0.0:4700->4600/tcp, [::]:4700->4600/tcp, 5432/tcp')).toEqual([
      { host: 4700, container: 4600, bind: '0.0.0.0' },
      { host: null, container: 5432 },
    ]);
    expect(parseContainerLine(container('c', 'img', 'running', '80/tcp'))).toMatchObject({
      name: 'c',
      image: 'img',
      state: 'running',
    });
    expect(parseContainerLine('CONTAINER\tonly')).toBeNull();
  });

  it('M3: stacks started from several compose files, with --env-file or --project-directory are marked "not supported yet"', () => {
    const line = (files: string, wd: string, envFile = '') =>
      `${container('app', 'img', 'running', '80/tcp', 'shop', 'app', files, wd)}${TAB}${envFile}`;
    expect(parseContainerLine(line('/srv/shop/compose.yaml', '/srv/shop'))?.unsupported).toBeUndefined();
    // the override file Guildwise writes itself is the normal case
    expect(
      parseContainerLine(line('/srv/shop/compose.yaml,/srv/shop/docker-compose.guildwise.yml', '/srv/shop'))
        ?.unsupported,
    ).toBeUndefined();
    expect(parseContainerLine(line('/srv/shop/a.yaml,/srv/shop/b.yaml', '/srv/shop'))?.unsupported).toContain(
      'several compose files',
    );
    expect(
      parseContainerLine(line('/srv/shop/compose.yaml', '/srv/shop', '/srv/shop/x.env'))?.unsupported,
    ).toContain('--env-file');
    expect(parseContainerLine(line('/srv/shop/compose.yaml', '/srv/other'))?.unsupported).toContain(
      '--project-directory',
    );
    const report = {
      containers: [parseContainerLine(line('/srv/shop/a.yaml,/srv/shop/b.yaml', '/srv/shop'))],
      composeFiles: [{ path: '/srv/shop/a.yaml', services: [], volumes: [] }],
    } as never as Parameters<typeof markUnsupportedStacks>[0];
    markUnsupportedStacks(report);
    expect(report.composeFiles[0]?.unsupported).toContain('not supported yet');
  });

  it('M2a: the probe flags data the app keeps in its folder (names only), and not the example settings file', () => {
    const dir = tmp('aom-state-');
    mkdirSync(join(dir, 'uploads'));
    writeFileSync(join(dir, 'uploads', 'a.png'), 'x');
    writeFileSync(join(dir, 'shop.sqlite'), 'x');
    writeFileSync(join(dir, '.env'), 'A=1');
    writeFileSync(join(dir, '.env.example'), 'A=');
    writeFileSync(join(dir, 'app.js'), 'x');
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'big.db'), 'x');
    writeFileSync(join(dir, 'logs.log'), 'x');
    const r = spawnSync('sh', ['-c', `${STATE_PATHS_FN}\naom_state_paths "$1"`, 'sh', dir], {
      encoding: 'utf8',
    });
    expect(r.stdout.split('\n').filter(Boolean)).toEqual(['.env', 'logs.log', 'shop.sqlite', 'uploads']);
    const built = buildServices({
      services: [
        ['systemd', 'shop.service', 'running', dir, 'me', '8000', '0', '/usr/bin/node app.js'].join(TAB),
      ],
      pm2: [],
      processes: [],
      appDirs: [],
      statePaths: [`${dir}${TAB}.env,logs.log,shop.sqlite,uploads`],
    });
    expect(built.services[0]?.statePaths).toEqual(['.env', 'logs.log', 'shop.sqlite', 'uploads']);
  });
});
