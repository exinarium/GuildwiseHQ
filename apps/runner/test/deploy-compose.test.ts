import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type * as DeployCompose from '../admin/deploy-compose.cjs';

/*
 * deploy-compose (DESIGN R20 step 4, [rv6-2], [rv7-8], [rv7-9]): one test per known escape. No root and no daemon:
 * the helper runs with test paths, its ownership checks expect the current uid, and docker is a recording wrapper that
 * passes only `compose ... config` (which never talks to the daemon) to the real CLI. up/pull/down are logged, never run.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN = join(here, '..', 'admin', 'deploy-compose.cjs');
const dc = createRequire(import.meta.url)(ADMIN) as typeof DeployCompose;

const realDocker = (() => {
  const which = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' });
  const p = which.stdout.trim();
  if (!p) return '';
  return spawnSync(p, ['compose', 'version'], { encoding: 'utf8' }).status === 0 ? p : '';
})();
const withCompose = describe.skipIf(!realDocker);

const BASE = 'services:\n  web:\n    image: alpine:3\n';
const cleanups: string[] = [];
afterEach(() => {
  for (const d of cleanups.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  base: string;
  tools: string;
  src: string;
  options: DeployCompose.DeployOptions;
  writeConf: (hash: string) => void;
  log: () => string;
  env: () => string;
  lastCompose: () => string;
  write: (rel: string, content: string) => void;
}

function harness(files: Record<string, string>): Harness {
  const base = mkdtempSync(join(tmpdir(), 'deploy-compose-'));
  cleanups.push(base);
  const src = join(base, 'src');
  mkdirSync(src);
  const write = (rel: string, content: string) => {
    mkdirSync(dirname(join(src, rel)), { recursive: true });
    writeFileSync(join(src, rel), content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  const confDir = join(base, 'etc', 'guildwise-runner', 'apps');
  mkdirSync(confDir, { recursive: true });
  // the helper refuses group- or world-writable config dirs; do not depend on the umask of the machine
  chmodSync(dirname(confDir), 0o755);
  chmodSync(confDir, 0o755);
  const stateDir = join(base, 'var', 'lib', 'guildwise', 'apps');
  const tools = join(base, 'tools');
  mkdirSync(tools);
  const docker = join(tools, 'docker');
  writeFileSync(
    docker,
    `#!/bin/sh
{ printf 'ARGV'; for a in "$@"; do printf ' %s' "$a"; done; printf '\\n'; } >> '${tools}/docker.log'
env | sort > '${tools}/docker.env'
case " $* " in
  *".resolved.json config "*) if [ -f '${tools}/canned-rerun.json' ]; then cat '${tools}/canned-rerun.json'; exit 0; fi;;
esac
for a in "$@"; do
  if [ "$a" = config ]; then
    if [ -f '${tools}/canned.json' ]; then cat '${tools}/canned.json'; exit 0; fi
    exec '${realDocker || '/bin/false'}' "$@"
  fi
done
prev=
for a in "$@"; do if [ "$prev" = -f ]; then cp "$a" '${tools}/last-compose.json'; fi; prev=$a; done
exit 0
`,
  );
  chmodSync(docker, 0o755);
  const read = (f: string) => (existsSync(join(tools, f)) ? readFileSync(join(tools, f), 'utf8') : '');
  return {
    base,
    tools,
    src,
    write,
    options: {
      confDir,
      stateDir,
      docker,
      rootUid: process.getuid!(),
      dropPrivileges: false,
      homeDir: homedir(),
      readerCommand: [process.execPath, ADMIN],
    },
    writeConf: (hash) => {
      writeFileSync(
        join(confDir, 'demo.conf'),
        dc.formatAppConf({ source: src, hash, owner: process.getuid!(), group: process.getgid!() }),
      );
      chmodSync(join(confDir, 'demo.conf'), 0o644);
    },
    log: () => read('docker.log'),
    env: () => read('docker.env'),
    lastCompose: () => read('last-compose.json'),
  };
}

async function approved(files: Record<string, string>): Promise<Harness> {
  const h = harness(files);
  h.writeConf('');
  const r = await dc.deploy('demo', 'resolve', h.options);
  expect(r.approved).toBe(false);
  h.writeConf(r.hash);
  return h;
}

async function refusedAt(stage: 'freeze' | 'prescan' | 'validate', h: Harness, pattern: RegExp) {
  if (!existsSync(join(h.options.confDir!, 'demo.conf'))) h.writeConf('a'.repeat(64));
  const err = await dc.deploy('demo', 'up', h.options).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(Error);
  expect((err as DeployCompose.DeployError).message).toMatch(pattern);
  expect((err as DeployCompose.DeployError).exitCode).toBe(dc.EXIT.REFUSED);
  const log = h.log();
  expect(log).not.toMatch(/ (up|pull|down)( |$)/m);
  if (stage === 'validate') expect(log).toMatch(/ config --format json/);
  else expect(log).toBe('');
}

const refuses = (stage: 'freeze' | 'prescan' | 'validate', files: Record<string, string>, pattern: RegExp) =>
  refusedAt(stage, harness(files), pattern);

describe('deploy-compose: a root tool that stands alone [rv6-1]', () => {
  it('requires nothing but Node built-ins (never the runner tree)', () => {
    const text = readFileSync(ADMIN, 'utf8');
    const required = [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect(required.length).toBeGreaterThan(0);
    for (const r of required) expect(r).toMatch(/^node:[a-z_/]+$/);
    expect(text).not.toMatch(/^\s*import\s/m);
    expect(text).not.toMatch(/\bimport\(/);
    expect(text.split('\n')[0]).toBe('#!/usr/local/lib/guildwise/node/bin/node');
  });

  it('refuses to run under any other interpreter', () => {
    const r = spawnSync(process.execPath, [ADMIN, 'demo', 'up'], { encoding: 'utf8' });
    expect(r.status).toBe(dc.EXIT.ENV);
    expect(r.stderr).toMatch(/runs only under \/usr\/local\/lib\/guildwise\/node\/bin\/node/);
  });

  it('refuses bad app names and actions', async () => {
    expect(() => dc.checkAppName('../etc')).toThrow(/invalid app name/);
    expect(() => dc.checkAppName('Demo')).toThrow(/invalid app name/);
    const h = harness({ 'compose.yaml': BASE });
    h.writeConf('');
    await expect(dc.deploy('demo', 'exec' as 'up', h.options)).rejects.toMatchObject({
      exitCode: dc.EXIT.USAGE,
    });
  });

  it('refuses an app config that is not root-owned or is writable by others', async () => {
    const h = harness({ 'compose.yaml': BASE });
    h.writeConf('');
    await expect(
      dc.deploy('demo', 'resolve', { ...h.options, rootUid: process.getuid!() + 1 }),
    ).rejects.toMatchObject({
      exitCode: dc.EXIT.ENV,
      message: expect.stringMatching(/not owned by root/),
    });
    chmodSync(join(h.options.confDir!, 'demo.conf'), 0o666);
    await expect(dc.deploy('demo', 'resolve', h.options)).rejects.toMatchObject({
      exitCode: dc.EXIT.ENV,
      message: expect.stringMatching(/writable by group or others/),
    });
  });

  it('refuses an app that was never approved', async () => {
    const h = harness({ 'compose.yaml': BASE });
    await expect(dc.deploy('demo', 'up', h.options)).rejects.toMatchObject({
      exitCode: dc.EXIT.ENV,
      message: expect.stringMatching(/not an approved app: run sudo .*guildwise-admin approve-app demo/),
    });
  });
});

describe('deploy-compose: freeze', () => {
  it('refuses a symlink to /etc in the folder', async () => {
    const h = harness({ 'compose.yaml': BASE });
    symlinkSync('/etc', join(h.src, 'etc'));
    await refusedAt('freeze', h, /etc: symlinks are not allowed/);
  });

  it('refuses a symlinked file deeper in the tree', async () => {
    const h = harness({ 'compose.yaml': BASE, 'app/x.txt': 'x' });
    symlinkSync('/etc/passwd', join(h.src, 'app', 'passwd'));
    await refusedAt('freeze', h, /app\/passwd: symlinks are not allowed/);
  });

  it('refuses hard links', async () => {
    const h = harness({ 'compose.yaml': BASE, 'a.txt': 'a' });
    linkSync(join(h.src, 'a.txt'), join(h.src, 'b.txt'));
    await refusedAt('freeze', h, /hard links are not allowed/);
  });

  it('refuses FIFOs', async () => {
    const h = harness({ 'compose.yaml': BASE });
    execFileSync('mkfifo', [join(h.src, 'pipe')]);
    await refusedAt('freeze', h, /pipe: devices, FIFOs and sockets are not allowed/);
  });
});

describe('deploy-compose: pre-scan before `docker compose config` runs [rv7-9]', () => {
  it.each([
    ['git', 'git@github.com:evil/stack.git'],
    ['git over https', 'https://github.com/evil/stack.git'],
    ['github shorthand', 'github.com/evil/stack/compose.yaml'],
    ['oci', 'oci://registry.example/evil:1'],
    ['absolute path', '/etc/guildwise-runner/apps/other.yaml'],
    ['parent folder', '../other/compose.yaml'],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a Compose variable, not a template
    ['interpolated', '${REMOTE}'],
  ])('refuses a remote or outside include (%s)', async (_kind, source) => {
    await refuses(
      'prescan',
      { 'compose.yaml': `include:\n  - ${JSON.stringify(source)}\n${BASE}` },
      /include/,
    );
  });

  it('refuses a remote include in the long syntax and in a locally included file', async () => {
    await refuses(
      'prescan',
      { 'compose.yaml': `include:\n  - path: [oci://evil/x:1]\n${BASE}` },
      /include\.path/,
    );
    await refuses(
      'prescan',
      {
        'compose.yaml': `include:\n  - more/inc.yaml\n${BASE}`,
        'more/inc.yaml': 'include: ["git@evil:x/y.git"]\n',
      },
      /more\/inc\.yaml: include/,
    );
  });

  it('refuses extends from a remote or outside file', async () => {
    await refuses(
      'prescan',
      { 'compose.yaml': `${BASE}    extends:\n      file: https://evil.example/c.yaml\n      service: x\n` },
      /extends\.file/,
    );
    await refuses(
      'prescan',
      { 'compose.yaml': `${BASE}    extends: {file: /root/c.yaml, service: x}\n` },
      /extends\.file/,
    );
  });

  it('refuses extends hidden behind an anchor and a merge key', async () => {
    const yaml = `x-base: &base\n  extends: {file: "../x/c.yaml", service: a}\nservices:\n  web:\n    <<: *base\n    image: alpine:3\n`;
    await refuses('prescan', { 'compose.yaml': yaml }, /extends\.file/);
  });

  it('refuses a key name written with escapes', async () => {
    await refuses('prescan', { 'compose.yaml': `"\\x69nclude": ["git@evil:x/y.git"]\n${BASE}` }, /include/);
  });

  it('refuses the words include/extends where the reader cannot see them as a key or value', async () => {
    await refuses(
      'prescan',
      { 'compose.yaml': `${BASE}# include: git@evil:x/y.git\n` },
      /outside a key or value/,
    );
  });

  it('refuses YAML it cannot read reliably (tags, several documents)', async () => {
    await refuses('prescan', { 'compose.yaml': `${BASE}    command: !reset []\n` }, /tags are not supported/);
    await refuses('prescan', { 'compose.yaml': `${BASE}---\nservices: {}\n` }, /several documents/);
  });

  it.each([
    ['parent folder', '../secrets.env'],
    ['absolute', '/etc/shadow'],
    ['home', '~/.ssh/env'],
    ['long syntax', '{path: /root/.env, required: false}'],
  ])('refuses an env_file outside the folder (%s)', async (_kind, value) => {
    await refuses(
      'prescan',
      { 'compose.yaml': `${BASE}    env_file: [${value.startsWith('{') ? value : JSON.stringify(value)}]\n` },
      /env_file/,
    );
  });

  it('refuses a top-level name', async () => {
    await refuses('prescan', { 'compose.yaml': `name: uat\n${BASE}` }, /top-level "name" is not allowed/);
  });

  it.each([
    'DOCKER_HOST=tcp://evil:2375',
    'COMPOSE_FILE=/etc/x.yaml',
    'export DOCKER_CONFIG=/home/runner/.docker',
    'BUILDX_CONFIG=/x',
  ])('refuses Docker or Compose settings in .env (%s)', async (line) => {
    await refuses(
      'prescan',
      { 'compose.yaml': BASE, '.env': `A=1\n${line}\n` },
      /would change how Docker or Compose itself runs/,
    );
  });

  it('refuses more than one compose file and a folder without one', async () => {
    await refuses('prescan', { 'compose.yaml': BASE, 'docker-compose.yml': BASE }, /several compose files/);
    await refuses('prescan', { 'other.yaml': BASE }, /no compose file/);
  });

  it('accepts local includes and extends', () => {
    const root = mkdtempSync(join(tmpdir(), 'deploy-compose-scan-'));
    cleanups.push(root);
    mkdirSync(join(root, 'more'));
    writeFileSync(
      join(root, 'compose.yaml'),
      `include:\n  - more/db.yaml\n${BASE}    extends: {file: more/base.yaml, service: base}\n`,
    );
    writeFileSync(join(root, 'more', 'db.yaml'), 'services:\n  db:\n    image: postgres:16\n');
    writeFileSync(join(root, 'more', 'base.yaml'), 'services:\n  base:\n    environment: [A=1]\n');
    expect(() => dc.prescan(root, dc.composeFiles(root))).not.toThrow();
  });
});

describe('deploy-compose: pin [rv7-8]', () => {
  it('replaces the snapshot path by $APP before hashing', () => {
    const cfg = (root: string) => ({
      name: 'guildwise-demo',
      services: {
        web: {
          build: { context: `${root}/app` },
          volumes: [{ type: 'bind', source: `${root}/data`, target: '/d' }],
        },
      },
    });
    const a = dc.pinResolved(cfg('/var/lib/guildwise/apps/demo/aaaa'), '/var/lib/guildwise/apps/demo/aaaa');
    const b = dc.pinResolved(cfg('/var/lib/guildwise/apps/demo/bbbb'), '/var/lib/guildwise/apps/demo/bbbb');
    expect(a.hash).toBe(b.hash);
    expect(JSON.stringify(a.pinned)).toContain('"$APP/app"');
    expect(dc.pinResolved({ ...cfg('/r'), x: 1 }, '/r').hash).not.toBe(dc.pinResolved(cfg('/r'), '/r').hash);
  });
});

describe('deploy-compose: allowlist (without docker)', () => {
  const root = '/var/lib/guildwise/apps/demo/abc';
  const ok = {
    name: 'guildwise-demo',
    networks: { default: { name: 'guildwise-demo_default', ipam: {} } },
    volumes: { data: { name: 'guildwise-demo_data' } },
    services: {
      web: {
        image: 'guildwise-demo-web',
        build: { context: `${root}/app`, dockerfile: 'Dockerfile' },
        command: null,
        entrypoint: null,
        networks: { default: null },
        volumes: [
          { type: 'volume', source: 'data', target: '/data', volume: {} },
          { type: 'bind', source: `${root}/static`, target: '/s', read_only: true, bind: {} },
        ],
        deploy: { resources: { limits: { cpus: 0.5, memory: '1' } }, placement: {} },
        logging: { driver: 'local' },
      },
    },
  };
  it('accepts a project-scoped config', () => {
    expect(dc.validateResolved(ok, { root, project: 'guildwise-demo' })).toEqual([]);
  });
  it('refuses a top-level key outside the allowlist and a foreign project name', () => {
    expect(
      dc.validateResolved({ ...ok, name: 'uat', secrets: {} }, { root, project: 'guildwise-demo' }),
    ).toEqual(expect.arrayContaining(['name: must be guildwise-demo', 'config.secrets: not allowed']));
  });
});

withCompose('deploy-compose: the resolved config is checked against the allowlist', () => {
  const svc = (extra: string) => `services:\n  web:\n    image: alpine:3\n${extra}`;

  it('deploys an approved app from the frozen copy with a forced project name', async () => {
    const files = {
      'compose.yaml': `services:
  web:
    build: { context: ./app }
    ports: ["8080:80"]
    environment: { MODE: prod }
    env_file: [web.env]
    volumes: [data:/data, ./static:/static:ro]
    networks: [back]
    depends_on: [db]
    restart: unless-stopped
    healthcheck: { test: ["CMD", "true"], interval: 10s }
    labels: { team: a }
    deploy: { resources: { limits: { cpus: "0.5", memory: 512M, pids: 100 }, reservations: { memory: 64M } } }
    logging: { driver: json-file, options: { max-size: 10m } }
  db:
    image: postgres:16
    volumes: [pg:/var/lib/postgresql/data]
    networks: [back]
volumes:
  data: {}
  pg: {}
networks:
  back: {}
`,
      'web.env': 'A=1\n',
      'app/Dockerfile': 'FROM alpine:3\n',
      'static/index.html': '<p>hi</p>\n',
      '.env': 'PORT=8080\n',
    };
    const h = await approved(files);
    const r = await dc.deploy('demo', 'up', h.options);
    expect(r.approved).toBe(true);
    const up = h
      .log()
      .split('\n')
      .find((l) => / up /.test(l))!;
    expect(up).toBe(
      `ARGV compose --project-directory ${r.snapshotDir} -p guildwise-demo -f ${r.resolvedFile} up -d --build`,
    );
    expect(r.snapshotDir.startsWith(join(h.options.stateDir!, 'demo'))).toBe(true);
    expect(JSON.parse(h.lastCompose()).name).toBe('guildwise-demo');
    await dc.deploy('demo', 'pull', h.options);
    await dc.deploy('demo', 'down', h.options);
    expect(h.log()).toMatch(/-p guildwise-demo -f \S+ pull\n/);
    expect(h.log()).toMatch(/-p guildwise-demo -f \S+ down\n/);
  });

  it('reuses the snapshot of an unchanged tree in place (running containers may bind-mount it)', async () => {
    const h = await approved({ 'compose.yaml': BASE, 'static/a.txt': 'a' });
    const first = await dc.deploy('demo', 'up', h.options);
    const ino = statSync(join(first.snapshotDir, 'static', 'a.txt')).ino;
    const second = await dc.deploy('demo', 'up', h.options);
    expect(second.snapshotDir).toBe(first.snapshotDir);
    expect(statSync(join(second.snapshotDir, 'static', 'a.txt')).ino).toBe(ino);
    expect(readdirSync(join(h.options.stateDir!, 'demo')).filter((n) => n.startsWith('.freeze-'))).toEqual(
      [],
    );
  });

  it('ignores DOCKER_HOST, DOCKER_CONFIG and COMPOSE_* in the caller env', async () => {
    const h = await approved({ 'compose.yaml': BASE });
    const saved = { ...process.env };
    Object.assign(process.env, {
      DOCKER_HOST: 'tcp://evil.example:2375',
      DOCKER_CONFIG: '/tmp/evil-docker',
      COMPOSE_FILE: '/etc/evil.yaml',
      COMPOSE_PROJECT_NAME: 'uat',
    });
    try {
      await dc.deploy('demo', 'up', h.options);
    } finally {
      for (const k of ['DOCKER_HOST', 'DOCKER_CONFIG', 'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
    const env = h.env();
    expect(env).not.toMatch(/^(DOCKER_HOST|DOCKER_CONFIG|COMPOSE_FILE|COMPOSE_PROJECT_NAME)=/m);
    expect(env).toMatch(/^COMPOSE_EXPERIMENTAL_GIT_REMOTE=false$/m);
    expect(env).toMatch(/^COMPOSE_EXPERIMENTAL_OCI_REMOTE=false$/m);
    expect(env).toMatch(new RegExp(`^HOME=${homedir()}$`, 'm'));
    expect(h.log()).toMatch(/ -p guildwise-demo -f /);
  });

  it('runs the frozen copy when a file is swapped after the freeze', async () => {
    const h = await approved({ 'compose.yaml': BASE, 'app/server.js': 'ok\n' });
    const r = await dc.deploy('demo', 'up', {
      ...h.options,
      afterFreeze: () => {
        h.write('compose.yaml', `${BASE}    privileged: true\n`);
        h.write('app/server.js', 'swapped\n');
      },
    });
    expect(h.lastCompose()).not.toMatch(/privileged/);
    expect(readFileSync(join(r.snapshotDir, 'app', 'server.js'), 'utf8')).toBe('ok\n');
    expect(readFileSync(join(r.snapshotDir, 'compose.yaml'), 'utf8')).toBe(BASE);
    // the next run freezes the swapped source, and that one is refused
    await expect(dc.deploy('demo', 'up', h.options)).rejects.toMatchObject({
      exitCode: dc.EXIT.REFUSED,
      message: expect.stringMatching(/services\.web\.privileged: not allowed/),
    });
    expect(h.log().match(/ up /g)).toHaveLength(1);
  });

  it('keeps the pin across app-code changes and holds a compose change [rv7-8]', async () => {
    const compose = 'services:\n  web:\n    build: ./app\n    volumes: [./data:/data:ro]\n';
    const h = harness({
      'compose.yaml': compose,
      'app/Dockerfile': 'FROM alpine:3\n',
      'app/server.js': 'v1\n',
      'data/x': '1',
    });
    h.writeConf('');
    const first = await dc.deploy('demo', 'resolve', h.options);
    h.write('app/server.js', 'v2\n');
    const second = await dc.deploy('demo', 'resolve', h.options);
    expect(second.snapshotDir).not.toBe(first.snapshotDir);
    expect(second.hash).toBe(first.hash);
    h.writeConf(first.hash);
    await expect(dc.deploy('demo', 'up', h.options)).resolves.toMatchObject({ approved: true });
    h.write('compose.yaml', `${compose}    environment: [A=1]\n`);
    await expect(dc.deploy('demo', 'up', h.options)).rejects.toMatchObject({
      exitCode: dc.EXIT.HELD,
      message: expect.stringMatching(/changed since it was approved.*guildwise-admin approve-app demo/),
    });
    expect(h.log().match(/ up /g)).toHaveLength(1);
  });

  it('refuses privileged added by compose.override.yaml', async () => {
    await refuses(
      'validate',
      { 'compose.yaml': BASE, 'compose.override.yaml': 'services:\n  web:\n    privileged: true\n' },
      /services\.web\.privileged: not allowed/,
    );
  });

  it('refuses a host path interpolated from .env', async () => {
    await refuses(
      'validate',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a Compose variable, not a template
      { 'compose.yaml': svc('    volumes: ["${DATA}:/data"]\n'), '.env': 'DATA=/etc\n' },
      /bind mounts must stay inside the app folder \(\/etc\)/,
    );
  });

  it.each(['/etc', '/root', '/var/lib/docker', '/home/human'])('refuses a bind of %s', async (host) => {
    await refuses(
      'validate',
      { 'compose.yaml': svc(`    volumes: ["${host}:/host"]\n`) },
      /bind mounts must stay inside the app folder/,
    );
  });

  it('refuses a bind that climbs out of the folder', async () => {
    await refuses(
      'validate',
      { 'compose.yaml': svc('    volumes: ["../../..:/up"]\n') },
      /bind mounts must stay inside the app folder/,
    );
  });

  it('refuses a volume driver_opts bind', async () => {
    await refuses(
      'validate',
      {
        'compose.yaml': `${svc('    volumes: [etc:/etc-host]\n')}volumes:\n  etc:\n    driver: local\n    driver_opts: {type: none, o: bind, device: /etc}\n`,
      },
      /volumes\.etc\.driver_opts: not allowed/,
    );
  });

  it.each([
    ['devices', '    devices: ["/dev/sda:/dev/sda"]\n', /\.devices: not allowed/],
    ['device_cgroup_rules', '    device_cgroup_rules: ["a *:* rwm"]\n', /\.device_cgroup_rules: not allowed/],
    ['cap_add', '    cap_add: [SYS_ADMIN]\n', /\.cap_add: not allowed/],
    [
      'security_opt',
      '    security_opt: ["seccomp=unconfined", "apparmor=unconfined"]\n',
      /\.security_opt: not allowed/,
    ],
    ['userns_mode host', '    userns_mode: host\n', /\.userns_mode: not allowed/],
    ['ipc host', '    ipc: host\n', /\.ipc: not allowed/],
    ['ipc container:', '    ipc: "container:uat-db-1"\n', /\.ipc: not allowed/],
    ['uts host', '    uts: host\n', /\.uts: not allowed/],
    ['pid host', '    pid: host\n', /\.pid: not allowed/],
    ['pid container:', '    pid: "container:uat-db-1"\n', /\.pid: not allowed/],
    ['cgroup host', '    cgroup: host\n', /\.cgroup: not allowed/],
    ['network_mode host', '    network_mode: host\n', /\.network_mode: not allowed/],
    ['network_mode container:', '    network_mode: "container:uat-db-1"\n', /\.network_mode: not allowed/],
    ['cgroup_parent', '    cgroup_parent: /\n', /\.cgroup_parent: not allowed/],
    ['sysctls', '    sysctls: {kernel.core_pattern: "|/bin/sh"}\n', /\.sysctls: not allowed/],
    [
      'post_start hook with privileged',
      '    post_start:\n      - command: id\n        privileged: true\n',
      /\.post_start: not allowed/,
    ],
    ['pre_stop hook', '    pre_stop:\n      - command: id\n', /\.pre_stop: not allowed/],
    ['privileged', '    privileged: true\n', /\.privileged: not allowed/],
    [
      'build.entitlements',
      '    build: {context: ., entitlements: [network.host]}\n',
      /build\.entitlements: not allowed/,
    ],
    ['build.privileged', '    build: {context: ., privileged: true}\n', /build\.privileged: not allowed/],
    ['build.ssh', '    build: {context: ., ssh: [default]}\n', /build\.ssh: not allowed/],
    ['build.context outside', '    build: {context: ..}\n', /build\.context: must be inside the app folder/],
    [
      'build.context git',
      '    build: {context: "https://github.com/evil/x.git"}\n',
      /build\.context: must be inside/,
    ],
    [
      'build.additional_contexts outside',
      '    build: {context: ., additional_contexts: {etc: /etc}}\n',
      /additional_contexts\.etc: must be inside/,
    ],
    [
      'build.dockerfile outside',
      '    build: {context: ., dockerfile: /etc/passwd}\n',
      /build\.dockerfile: must be inside/,
    ],
    ['a Compose project label', '    labels: {com.docker.compose.project: uat}\n', /reserved Compose label/],
    [
      'reservations.devices',
      '    deploy: {resources: {reservations: {devices: [{driver: nvidia, count: all, capabilities: [gpu]}]}}}\n',
      /reservations\.devices: not allowed/,
    ],
    [
      'a syslog logging driver',
      '    logging: {driver: syslog, options: {syslog-address: "udp://evil.example:514"}}\n',
      /logging\.driver: only json-file or local/,
    ],
    [
      'a gelf logging driver',
      '    logging: {driver: gelf, options: {gelf-address: "udp://evil.example:12201"}}\n',
      /logging\.driver: only json-file or local/,
    ],
  ])('refuses %s', async (_name, extra, pattern) => {
    await refuses('validate', { 'compose.yaml': svc(extra), Dockerfile: 'FROM alpine:3\n' }, pattern);
  });

  it.each([
    ['ipc service:', 'ipc: "service:db"', /\.ipc: not allowed/],
    ['pid service:', 'pid: "service:db"', /\.pid: not allowed/],
    ['network_mode service:', 'network_mode: "service:db"', /\.network_mode: not allowed/],
    ['volumes_from', 'volumes_from: [db]', /\.volumes_from: not allowed/],
  ])('refuses %s', async (_name, line, pattern) => {
    await refuses(
      'validate',
      { 'compose.yaml': `${svc(`    ${line}\n`)}  db:\n    image: postgres:16\n` },
      pattern,
    );
  });

  it('refuses a built image tagged with the name of another stack', async () => {
    await refuses(
      'validate',
      {
        'compose.yaml': 'services:\n  web:\n    build: .\n    image: postgres:16\n',
        Dockerfile: 'FROM alpine:3\n',
      },
      /services\.web\.image: a built image must be named guildwise-demo-/,
    );
  });

  it('refuses build secrets', async () => {
    await refuses(
      'validate',
      {
        'compose.yaml': `${svc('    build: {context: ., secrets: [s]}\n')}secrets:\n  s: {file: ./s.txt}\n`,
        's.txt': 'x',
        Dockerfile: 'FROM alpine:3\n',
      },
      /build\.secrets: not allowed/,
    );
  });

  it('refuses external secrets and configs', async () => {
    await refuses(
      'validate',
      {
        'compose.yaml': `${svc('    secrets: [s]\n')}secrets:\n  s: {external: true}\nconfigs:\n  c: {external: true}\n`,
      },
      /config\.secrets: not allowed/,
    );
  });

  it('refuses a provider service', async () => {
    await refuses(
      'validate',
      { 'compose.yaml': 'services:\n  web:\n    provider: {type: model, options: {model: x}}\n' },
      /\.provider: not allowed/,
    );
  });

  it.each([
    [
      'an external volume',
      `${svc('    volumes: [pg:/pg]\n')}volumes:\n  pg: {external: true, name: uat_pgdata}\n`,
      /volumes\.pg\.external: not allowed/,
    ],
    [
      'a renamed volume',
      `${svc('    volumes: [pg:/pg]\n')}volumes:\n  pg: {name: uat_pgdata}\n`,
      /volumes\.pg\.name: renamed volumes are not allowed/,
    ],
    [
      'an external network',
      `${svc('    networks: [uat]\n')}networks:\n  uat: {external: true, name: uat_default}\n`,
      /networks\.uat\.external: not allowed/,
    ],
    [
      'a renamed network',
      `${svc('    networks: [uat]\n')}networks:\n  uat: {name: uat_default}\n`,
      /networks\.uat\.name: renamed networks are not allowed/,
    ],
    [
      'a host network driver',
      `${svc('    networks: [n]\n')}networks:\n  n: {driver: host}\n`,
      /networks\.n\.driver: only the default bridge driver/,
    ],
  ])('refuses %s [rv7-9]', async (_name, yaml, pattern) => {
    await refuses('validate', { 'compose.yaml': yaml }, pattern);
  });

  it('resolve reports the pinned config and whether it is approved', async () => {
    const h = harness({
      'compose.yaml': 'services:\n  web:\n    build: ./app\n',
      'app/Dockerfile': 'FROM alpine:3\n',
    });
    h.writeConf('');
    const r = await dc.deploy('demo', 'resolve', h.options);
    expect(r.approved).toBe(false);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(r.pinned)).toContain('"context":"$APP/app"');
    expect(JSON.stringify(r.pinned)).not.toContain(r.snapshotDir);
    expect(h.log()).not.toMatch(/ up /);
  });
});

describe('deploy-compose rework: the reader identity is fixed at approval [B1]', () => {
  type SpawnFn = NonNullable<DeployCompose.DeployOptions['spawn']>;
  const recordingSpawn = (seen: { uid?: number; gid?: number }[]): SpawnFn =>
    ((cmd: string, args: readonly string[], o: Record<string, unknown>) => {
      seen.push({ uid: o.uid as number, gid: o.gid as number });
      // the test cannot setuid: record the identity, then read as the current user
      const { uid: _u, gid: _g, ...rest } = o;
      return spawn(cmd, args, rest);
    }) as unknown as SpawnFn;

  it('reads as the uid/gid in the app conf, never the owner or group of the folder', async () => {
    const h = harness({ 'compose.yaml': BASE });
    h.writeConf('');
    const conf = join(h.options.confDir!, 'demo.conf');
    // the approval names gid 4243, the folder's group is the test user's: the reader must get 4243
    writeFileSync(conf, dc.formatAppConf({ source: h.src, hash: '', owner: process.getuid!(), group: 4243 }));
    chmodSync(conf, 0o644);
    const seen: { uid?: number; gid?: number }[] = [];
    await dc.deploy('demo', 'resolve', { ...h.options, dropPrivileges: true, spawn: recordingSpawn(seen) });
    expect(seen).toEqual([{ uid: process.getuid!(), gid: 4243 }]);
  });

  it('ignores a reader uid passed by the caller of deploy', async () => {
    const h = harness({ 'compose.yaml': BASE });
    h.writeConf('');
    const seen: { uid?: number; gid?: number }[] = [];
    await dc.deploy('demo', 'resolve', {
      ...h.options,
      dropPrivileges: true,
      readerUid: 4242,
      readerGid: 4242,
      spawn: recordingSpawn(seen),
    });
    expect(seen).toEqual([{ uid: process.getuid!(), gid: process.getgid!() }]);
  });

  it('refuses a source whose parent was swapped for a symlink to a folder of another owner', async () => {
    const h = harness({ 'compose.yaml': BASE });
    // the approved owner is the runner (here: uid + 1); `parent` now points at a folder of the test user (the "human")
    const human = join(h.base, 'human', 'demo');
    mkdirSync(human, { recursive: true });
    writeFileSync(join(human, 'compose.yaml'), BASE);
    writeFileSync(join(human, '.env'), 'SECRET=1\n');
    symlinkSync(join(h.base, 'human'), join(h.base, 'parent'));
    const conf = join(h.options.confDir!, 'demo.conf');
    writeFileSync(
      conf,
      dc.formatAppConf({
        source: join(h.base, 'parent', 'demo'),
        hash: '',
        owner: process.getuid!() + 1,
        group: 1,
      }),
    );
    chmodSync(conf, 0o644);
    const seen: { uid?: number; gid?: number }[] = [];
    await expect(
      dc.deploy('demo', 'resolve', { ...h.options, dropPrivileges: true, spawn: recordingSpawn(seen) }),
    ).rejects.toMatchObject({
      exitCode: dc.EXIT.REFUSED,
      message: expect.stringMatching(/owned by uid \d+, not the approved uid/),
    });
    expect(seen).toEqual([]);
    expect(h.log()).toBe('');
  });

  it('refuses to freeze with dropped privileges as gid 0 [N3]', async () => {
    const h = harness({ 'compose.yaml': BASE });
    const seen: { uid?: number; gid?: number }[] = [];
    await expect(
      dc.prepare('demo', h.src, {
        ...h.options,
        dropPrivileges: true,
        readerUid: process.getuid!(),
        readerGid: 0,
        spawn: recordingSpawn(seen),
      }),
    ).rejects.toMatchObject({ exitCode: dc.EXIT.ENV, message: expect.stringMatching(/reader uid\/gid/) });
    expect(seen).toEqual([]);
  });

  it('refuses to freeze with dropped privileges when no reader uid was approved', async () => {
    const h = harness({ 'compose.yaml': BASE });
    const conf = join(h.options.confDir!, 'demo.conf');
    writeFileSync(conf, `source=${h.src}\nhash=\n`);
    chmodSync(conf, 0o644);
    await expect(dc.deploy('demo', 'resolve', { ...h.options, dropPrivileges: true })).rejects.toMatchObject({
      exitCode: dc.EXIT.ENV,
      message: expect.stringMatching(/reader uid\/gid of this app are not set: run .*approve-app again/),
    });
    await expect(dc.prepare('demo', h.src, { ...h.options, dropPrivileges: true })).rejects.toMatchObject({
      exitCode: dc.EXIT.ENV,
    });
  });

  it('writes and reads owner and group in the app conf; root and missing ids are refused', () => {
    const text = dc.formatAppConf({
      source: '/home/r/src/demo',
      hash: 'a'.repeat(64),
      owner: 999,
      group: 998,
    });
    expect(dc.parseAppConf(text)).toEqual({
      source: '/home/r/src/demo',
      hash: 'a'.repeat(64),
      owner: 999,
      group: 998,
    });
    expect(() => dc.parseAppConf('source=/x\nowner=0\n')).toThrow(/owner must not be root/);
    expect(() => dc.parseAppConf('source=/x\nowner=-1\n')).toThrow(/numeric id/);
    expect(() => dc.formatAppConf({ source: '/x', hash: '', owner: 0, group: 0 })).toThrow(/non-root uid/);
    // [N3] gid 0 would let the reader read files only the root group can read
    expect(() => dc.formatAppConf({ source: '/x', hash: '', owner: 999, group: 0 })).toThrow(/non-root gid/);
    expect(() => dc.parseAppConf('source=/x\ngroup=0\n')).toThrow(/group must not be root/);
  });
});

describe('deploy-compose rework: Node and libuv settings are refused [N1]', () => {
  const proc = (env: Record<string, string>) => ({
    execPath: '/usr/local/lib/guildwise/node/bin/node',
    execArgv: [] as string[],
    env,
    getuid: () => 0,
    geteuid: () => 0,
  });
  it.each(['NODE_OPTIONS', 'NODE_COMPILE_CACHE', 'NODE_V8_COVERAGE', 'NODE_ICU_DATA', 'UV_THREADPOOL_SIZE'])(
    'refuses %s in the environment',
    (k) => {
      expect(() => dc.preflight(dc.DEFAULTS, proc({ PATH: '/usr/bin', [k]: '/tmp/x' }))).toThrow(
        new RegExp(k),
      );
    },
  );
  it('accepts a clean root environment', () => {
    expect(() => dc.preflight(dc.DEFAULTS, proc({ PATH: '/usr/bin', HOME: '/root' }))).not.toThrow();
  });
});

describe('deploy-compose rework: prepare takes the app lock [N2]', () => {
  it('refuses while another run of the same app holds the lock', async () => {
    const h = harness({ 'compose.yaml': BASE });
    const appDir = join(h.options.stateDir!, 'demo');
    mkdirSync(appDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(appDir, '.lock'), '1\n');
    await expect(dc.prepare('demo', h.src, h.options)).rejects.toThrow(/in progress/);
    expect(existsSync(join(appDir, '.lock'))).toBe(true);
  });
});

describe('deploy-compose rework: image names cannot collide between apps [S1]', () => {
  const root = '/var/lib/guildwise/apps/foo/abc';
  const check = (services: Record<string, unknown>) =>
    dc.validateResolved({ name: 'guildwise-foo', services }, { root, project: 'guildwise-foo' });
  const build = { context: `${root}/app` };
  it('refuses a built service whose name has a dash (app foo + bar-web = app foo-bar + web)', () => {
    expect(check({ 'bar-web': { build } }).join('\n')).toMatch(/needs a name of a-z, 0-9, _ and \. \(no -/);
  });
  it('refuses a built image named for another app that shares the prefix', () => {
    expect(check({ web: { build, image: 'guildwise-foo-bar-web' } }).join('\n')).toMatch(
      /a built image must be named guildwise-foo-web/,
    );
  });
  it("refuses pulling another guildwise stack's image, also through docker.io/library", () => {
    expect(check({ web: { image: 'guildwise-foo-bar-web:latest' } }).join('\n')).toMatch(
      /only this project's own/,
    );
    expect(check({ web: { image: 'docker.io/library/guildwise-uat-app' } }).join('\n')).toMatch(
      /only this project's own/,
    );
  });
  it("accepts the project's own built images, also reused by another service", () => {
    expect(
      check({ web: { build, image: 'guildwise-foo-web:2' }, worker: { image: 'guildwise-foo-web:2' } }),
    ).toEqual([]);
    expect(check({ web: { build }, db: { image: 'postgres:16' } })).toEqual([]);
  });
});

describe('deploy-compose rework: a tampered snapshot is never reused [B2]', () => {
  it('hashTree matches the freeze hash and changes when the snapshot changes', async () => {
    const h = await approved({ 'compose.yaml': BASE, 'static/a.txt': 'a', 'bin/run': '#!/bin/sh\n' });
    const r = await dc.deploy('demo', 'resolve', h.options);
    expect(dc.hashTree(r.snapshotDir, process.getuid!())).toBe(r.snapshotHash);
    writeFileSync(join(r.snapshotDir, 'static', 'a.txt'), 'changed');
    expect(dc.hashTree(r.snapshotDir, process.getuid!())).not.toBe(r.snapshotHash);
  });

  it.each([
    ['a changed file', (d: string) => writeFileSync(join(d, 'static', 'a.txt'), 'evil')],
    ['an added file', (d: string) => writeFileSync(join(d, 'static', 'b.txt'), 'evil')],
    [
      'a directory swapped for a symlink to /',
      (d: string) => {
        rmSync(join(d, 'static'), { recursive: true });
        symlinkSync('/', join(d, 'static'));
      },
    ],
  ])('re-freezes over %s', async (_kind, tamper) => {
    const h = await approved({ 'compose.yaml': BASE, 'static/a.txt': 'a' });
    const first = await dc.deploy('demo', 'resolve', h.options);
    tamper(first.snapshotDir);
    const second = await dc.deploy('demo', 'resolve', h.options);
    expect(second.snapshotDir).toBe(first.snapshotDir);
    expect(readFileSync(join(second.snapshotDir, 'static', 'a.txt'), 'utf8')).toBe('a');
    expect(existsSync(join(second.snapshotDir, 'static', 'b.txt'))).toBe(false);
    expect(dc.hashTree(second.snapshotDir, process.getuid!())).toBe(second.snapshotHash);
  });
});

withCompose('deploy-compose rework: binds into the snapshot are read-only [B2]', () => {
  it.each([
    ['the whole folder', '.:/app'],
    ['a data folder', './data:/data'],
    ['a long-syntax bind', '{type: bind, source: ./data, target: /data}'],
  ])('refuses a writable bind of %s', async (_kind, mount) => {
    const yaml = `services:\n  web:\n    image: alpine:3\n    volumes:\n      - ${mount}\n`;
    await refuses(
      'validate',
      { 'compose.yaml': yaml, 'data/x': '1' },
      /read_only: binds into the app folder must be read-only/,
    );
  });

  it('accepts read-only binds', async () => {
    const h = await approved({
      'compose.yaml':
        'services:\n  web:\n    image: alpine:3\n    volumes:\n      - .:/app:ro\n      - {type: bind, source: ./data, target: /data, read_only: true}\n',
      'data/x': '1',
    });
    await expect(dc.deploy('demo', 'up', h.options)).resolves.toMatchObject({ approved: true });
  });
});

withCompose('deploy-compose rework: the resolved file must resolve to the approved config again [B3]', () => {
  it('lets a $$-escaped value with a matching .env variable round-trip unchanged', async () => {
    const h = await approved({
      'compose.yaml':
        'services:\n  web:\n    image: alpine:3\n    volumes: ["./$${X}:/x:ro"]\n    environment: {E: "$${X}"}\n',
      '.env': 'X=../../../../..\n',
    });
    const r = await dc.deploy('demo', 'up', h.options);
    const lines = h.log().split('\n');
    const rerun = lines.findIndex((l) => l.includes(`-f ${r.resolvedFile} config --format json`));
    const up = lines.findIndex((l) => / up -d --build$/.test(l));
    expect(rerun).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(rerun);
    expect(JSON.stringify(r.pinned)).toContain('$APP/$${X}');
  });

  it('refuses to run when the resolved file resolves to something else', async () => {
    const h = await approved({ 'compose.yaml': BASE });
    const r = await dc.deploy('demo', 'resolve', h.options);
    const changed = JSON.parse(JSON.stringify(r.resolved));
    changed.services.web.volumes = [{ type: 'bind', source: '/', target: '/host', read_only: true }];
    writeFileSync(join(h.tools, 'canned-rerun.json'), JSON.stringify(changed));
    await expect(dc.deploy('demo', 'up', h.options)).rejects.toMatchObject({
      exitCode: dc.EXIT.REFUSED,
      message: expect.stringMatching(
        /does not resolve to the approved config[\s\S]*bind mounts must stay inside/,
      ),
    });
    expect(h.log()).not.toMatch(/ up /);
  });

  it('refuses to run when the re-resolved config passes the allowlist but has another pin', async () => {
    const h = await approved({ 'compose.yaml': BASE });
    const r = await dc.deploy('demo', 'resolve', h.options);
    const changed = JSON.parse(JSON.stringify(r.resolved));
    changed.services.web.environment = { INJECTED: '1' };
    writeFileSync(join(h.tools, 'canned-rerun.json'), JSON.stringify(changed));
    await expect(dc.deploy('demo', 'pull', h.options)).rejects.toMatchObject({
      exitCode: dc.EXIT.REFUSED,
      message: expect.stringMatching(/does not resolve to the approved config$/),
    });
    expect(h.log()).not.toMatch(/ pull$/m);
  });
});
