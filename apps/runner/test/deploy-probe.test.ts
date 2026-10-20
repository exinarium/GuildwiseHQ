import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DeployProbePayload, ProbeReportSchema } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import {
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
  for (const [name, body] of Object.entries(scripts)) {
    const file = join(dir, name);
    writeFileSync(file, `#!/bin/bash\necho "${name} $*" >> "${logFile}"\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return {
    dir,
    // only the fake folder and the basic tools: a binary that is not faked is missing
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, FAKE_LOG: logFile },
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

describe('deploy.probe: local Docker', () => {
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
    for (const c of fake.log())
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
if [ "$1" = "-G" ]; then
  shift; [ "$1" = "--" ] && shift
  echo "hostname host-$1.example.net"; echo "user deploy"; echo "port 22"; echo "identityfile ~/.ssh/id_ed25519"
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
});
