import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DeployPreparePayload, PrepareAction } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { DeployKeys } from '../src/delivery/deploy-keys.ts';
import { DeployPreparer } from '../src/delivery/prepare.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * `deploy.prepare` (design v2): a closed list of idempotent actions. The "server" is this computer: a fake `ssh` runs the
 * remote script locally, with a curated PATH (real coreutils, FAKE docker / systemctl / apt-get / sudo / caddy) and a temp
 * root, so nothing here can install, start or write anything real.
 */

const TOOLS = [
  'sh',
  'bash',
  'base64',
  'grep',
  'awk',
  'sed',
  'cat',
  'tee',
  'date',
  'mkdir',
  'id',
  'cp',
  'tail',
  'wc',
  'dirname',
  'tr',
  'head',
  'ls',
  'rm',
  'mv',
  'chmod',
  'chown',
  'cut',
  'sort',
  'env',
  'true',
  'false',
  'sleep',
  'uname',
  'printf',
  'test',
  'basename',
  'touch',
  'stat',
];
const P = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function which(name: string): string | null {
  for (const dir of ['/usr/bin', '/bin']) if (existsSync(join(dir, name))) return join(dir, name);
  return null;
}

interface Rig {
  root: string;
  bin: string;
  env: NodeJS.ProcessEnv;
  calls: () => string[];
  put: (name: string, body: string) => void;
  prep: (extra?: { repoPath?: (r: string) => Promise<string | null> }) => DeployPreparer;
  run: (actions: PrepareAction[], over?: Partial<DeployPreparePayload>) => ReturnType<DeployPreparer['run']>;
}

function rig(): Rig {
  const root = tmp('aom-prep-');
  const bin = join(root, 'bin');
  const tools = join(root, 'tools');
  mkdirSync(bin, { recursive: true });
  mkdirSync(tools, { recursive: true });
  for (const t of TOOLS) {
    const p = which(t);
    if (p) {
      try {
        symlinkSync(p, join(tools, t));
      } catch {
        // linked already
      }
    }
  }
  const put = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  put(
    'ssh',
    '#!/bin/bash\necho "ssh $*" >> "$FAKE_ROOT/calls.log"\ncmd=""; for a in "$@"; do cmd="$a"; done\nexec sh -c "$cmd"\n',
  );
  put(
    'sudo',
    '#!/bin/bash\necho "sudo $*" >> "$FAKE_ROOT/calls.log"\n[ -f "$FAKE_ROOT/no-sudo" ] && exit 1\nshift_args=("$@"); [ "$1" = -n ] && shift\nexec "$@"\n',
  );
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${tools}`,
    HOME: root,
    FAKE_ROOT: root,
    AOM_CADDYFILE: join(root, 'etc-caddy', 'Caddyfile'),
    AOM_CADDY_DIR: join(root, 'opt-caddy'),
    AOM_OS_RELEASE: join(root, 'os-release'),
  };
  writeFileSync(join(root, 'os-release'), 'ID=ubuntu\nID_LIKE=debian\n');
  const keys = new DeployKeys({ dir: join(root, 'keys'), home: root, env });
  const prep = (extra: { repoPath?: (r: string) => Promise<string | null> } = {}) =>
    new DeployPreparer({
      keys,
      repoPath: extra.repoPath ?? (async () => null),
      env,
      home: root,
      connectSec: 2,
      commandMs: 30_000,
    });
  return {
    root,
    bin,
    env,
    put,
    prep,
    calls: () =>
      existsSync(join(root, 'calls.log'))
        ? readFileSync(join(root, 'calls.log'), 'utf8').split('\n').filter(Boolean)
        : [],
    run: (actions, over = {}) =>
      prep().run({
        projectId: P,
        hosting: 'ssh',
        alias: 'aom-shop',
        actions,
        dryRun: false,
        ...over,
      } as DeployPreparePayload),
  };
}

describe('deploy.prepare on a server', () => {
  it('create_dir: a dry run changes nothing, a real run creates, a second run leaves it alone', async () => {
    const r = rig();
    const dir = join(r.root, 'srv', 'shop');
    const dry = await r.run([{ kind: 'create_dir', path: dir }], { dryRun: true });
    expect(dry).toMatchObject({ ok: true, steps: [{ outcome: 'would' }] });
    expect(existsSync(dir)).toBe(false);
    expect(await r.run([{ kind: 'create_dir', path: dir }])).toMatchObject({
      ok: true,
      steps: [{ outcome: 'done' }],
    });
    expect(existsSync(dir)).toBe(true);
    writeFileSync(join(dir, 'keep.txt'), 'mine');
    expect(await r.run([{ kind: 'create_dir', path: dir }])).toMatchObject({
      ok: true,
      steps: [{ outcome: 'skipped' }],
    });
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('write_compose: the project file goes in, an existing file is never overwritten, a link, a path outside and a secret are refused', async () => {
    const r = rig();
    const repo = join(r.root, 'repo');
    mkdirSync(join(repo, 'deploy'), { recursive: true });
    writeFileSync(join(repo, 'deploy', 'docker-compose.yml'), 'services:\n  app:\n    image: x\n');
    writeFileSync(
      join(repo, 'leak.yml'),
      'services:\n  app:\n    environment:\n      TOKEN: ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD\n',
    );
    symlinkSync('/etc/hostname', join(repo, 'link.yml'));
    const p = r.prep({ repoPath: async () => repo });
    const dest = join(r.root, 'srv', 'shop', 'docker-compose.yml');
    const act = (repoPath: string, path = dest): PrepareAction =>
      ({ kind: 'write_compose', path, repoPath, remote: 'github.com/acme/shop' }) as PrepareAction;
    const base = { projectId: P, hosting: 'ssh', alias: 'aom-shop', dryRun: false } as const;
    expect(await p.run({ ...base, actions: [act('deploy/docker-compose.yml')] })).toMatchObject({
      ok: true,
      steps: [{ outcome: 'done' }],
    });
    expect(readFileSync(dest, 'utf8')).toContain('image: x');
    writeFileSync(dest, 'MINE');
    expect(await p.run({ ...base, actions: [act('deploy/docker-compose.yml')] })).toMatchObject({
      ok: true,
      steps: [{ outcome: 'skipped' }],
    });
    expect(readFileSync(dest, 'utf8')).toBe('MINE');
    const other = join(r.root, 'srv', 'other', 'c.yml');
    for (const bad of ['../../etc/passwd', 'link.yml', 'leak.yml', 'missing.yml']) {
      const out = await p.run({ ...base, actions: [act(bad, other)] });
      expect(out.ok, bad).toBe(false);
      expect(out.error).toBe('repo_file_missing');
      expect(existsSync(other)).toBe(false);
    }
  });

  it('install_docker: skipped when Docker is there; installs with the system packages when it is not; stops without root', async () => {
    const r = rig();
    r.put('docker', '#!/bin/bash\nexit 0\n');
    expect(await r.run([{ kind: 'install_docker' }])).toMatchObject({
      ok: true,
      steps: [{ outcome: 'skipped' }],
    });
    const r2 = rig();
    r2.put(
      'apt-get',
      `#!/bin/bash\necho "apt-get $*" >> "$FAKE_ROOT/calls.log"\nif [ "$1" = install ] && [ "$3" = docker.io ]; then printf '#!/bin/bash\\nexit 0\\n' > "$(dirname "$0")/docker"; chmod +x "$(dirname "$0")/docker"; fi\nexit 0\n`,
    );
    r2.put('systemctl', '#!/bin/bash\necho "systemctl $*" >> "$FAKE_ROOT/calls.log"\n');
    r2.put('usermod', '#!/bin/bash\necho "usermod $*" >> "$FAKE_ROOT/calls.log"\n');
    const dry = await r2.run([{ kind: 'install_docker' }], { dryRun: true });
    expect(dry).toMatchObject({ ok: true, steps: [{ outcome: 'would' }] });
    expect(r2.calls().some((c) => c.startsWith('apt-get'))).toBe(false);
    const done = await r2.run([{ kind: 'install_docker' }]);
    expect(done, JSON.stringify(done)).toMatchObject({ ok: true, steps: [{ outcome: 'done' }] });
    expect(r2.calls().some((c) => c.includes('apt-get') && c.includes('docker.io'))).toBe(true);
    expect(r2.calls().some((c) => c.startsWith('systemctl') && c.includes('enable --now docker'))).toBe(true);
    // not root and no sudo: a clear stop, nothing installed
    const r3 = rig();
    writeFileSync(join(r3.root, 'no-sudo'), '');
    r3.put('apt-get', '#!/bin/bash\necho "apt-get $*" >> "$FAKE_ROOT/calls.log"\n');
    const out = await r3.run([{ kind: 'install_docker' }]);
    if (spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim() !== '0') {
      expect(out).toMatchObject({ ok: false, error: 'needs_root' });
      expect(r3.calls().some((c) => c.startsWith('apt-get'))).toBe(false);
    }
    // other systems are not guessed at
    writeFileSync(join(r3.root, 'os-release'), 'ID=fedora\n');
    expect(await r3.run([{ kind: 'install_docker' }])).toMatchObject({ ok: false });
  });

  describe('caddy_site', () => {
    const A: PrepareAction = { kind: 'caddy_site', domain: 'shop.example.com', upstreamPort: 4600 };
    const containerWorld = (r: Rig, file: string) => {
      r.put(
        'docker',
        `#!/bin/bash
echo "docker $*" >> "$FAKE_ROOT/calls.log"
case "$1" in
  ps) echo "caddy caddy:2" ;;
  inspect)
    case "$*" in
      *Mounts*) printf '%s' "${file}" ;;
      *NetworkMode*) echo bridge ;;
    esac ;;
  network) echo 172.17.0.1 ;;
  exec) if [ "$3" = caddy ] && [ "$4" = validate ] && [ -f "$FAKE_ROOT/invalid" ]; then echo "invalid" >&2; exit 1; fi ;;
esac
exit 0
`,
      );
    };

    it('an existing Caddy in a container: one site is appended after a dated copy, validated and reloaded; the rest of the file is untouched', async () => {
      const r = rig();
      const file = join(r.root, 'caddy', 'Caddyfile');
      mkdirSync(join(r.root, 'caddy'), { recursive: true });
      const original = 'other.example.com {\n\treverse_proxy app2:3000\n}\n';
      writeFileSync(file, original);
      containerWorld(r, file);
      const dry = await r.run([A], { dryRun: true });
      expect(dry).toMatchObject({ ok: true, steps: [{ outcome: 'would' }] });
      expect(readFileSync(file, 'utf8')).toBe(original);
      const out = await r.run([A]);
      expect(out, JSON.stringify(out)).toMatchObject({ ok: true, steps: [{ outcome: 'done' }] });
      const text = readFileSync(file, 'utf8');
      expect(text.startsWith(original)).toBe(true);
      expect(text).toContain('shop.example.com {\n\treverse_proxy 172.17.0.1:4600\n}');
      const baks = readdirSync(join(r.root, 'caddy')).filter((f) => f.includes('guildwise-bak-'));
      expect(baks).toHaveLength(1);
      expect(readFileSync(join(r.root, 'caddy', baks[0] as string), 'utf8')).toBe(original);
      expect(r.calls().some((c) => c.includes('caddy reload'))).toBe(true);
      // again: the site is there, nothing changes
      const before = readFileSync(file, 'utf8');
      expect(await r.run([A])).toMatchObject({ ok: true, steps: [{ outcome: 'skipped' }] });
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('a Caddyfile that Caddy rejects is put back exactly as it was', async () => {
      const r = rig();
      const file = join(r.root, 'caddy', 'Caddyfile');
      mkdirSync(join(r.root, 'caddy'), { recursive: true });
      const original = 'other.example.com {\n\treverse_proxy app2:3000\n}\n';
      writeFileSync(file, original);
      containerWorld(r, file);
      writeFileSync(join(r.root, 'invalid'), '');
      const out = await r.run([A]);
      expect(out).toMatchObject({ ok: false, error: 'failed' });
      expect(readFileSync(file, 'utf8')).toBe(original);
      expect(r.calls().some((c) => c.includes('caddy reload'))).toBe(false);
    });

    it('Caddy as a system service: its Caddyfile gets the site and the service is reloaded (never restarted)', async () => {
      const r = rig();
      const file = r.env.AOM_CADDYFILE as string;
      mkdirSync(join(r.root, 'etc-caddy'), { recursive: true });
      writeFileSync(file, 'a.example.com {\n\trespond ok\n}\n');
      r.put('systemctl', '#!/bin/bash\necho "systemctl $*" >> "$FAKE_ROOT/calls.log"\nexit 0\n');
      r.put('caddy', '#!/bin/bash\necho "caddy $*" >> "$FAKE_ROOT/calls.log"\nexit 0\n');
      const out = await r.run([A]);
      expect(out, JSON.stringify(out)).toMatchObject({ ok: true, steps: [{ outcome: 'done' }] });
      expect(readFileSync(file, 'utf8')).toContain('reverse_proxy 127.0.0.1:4600');
      const calls = r.calls();
      expect(calls.some((c) => c.startsWith('systemctl') && c.includes('reload caddy'))).toBe(true);
      expect(calls.some((c) => /systemctl (restart|stop)/.test(c))).toBe(false);
    });

    it('no Caddy and the web ports are free: Caddy is started in its own container for this domain only; busy ports stop it', async () => {
      const r = rig();
      r.put(
        'docker',
        '#!/bin/bash\necho "docker $*" >> "$FAKE_ROOT/calls.log"\ncase "$1" in ps) ;; esac\nexit 0\n',
      );
      r.put('ss', '#!/bin/bash\nexit 0\n');
      const out = await r.run([A]);
      expect(out, JSON.stringify(out)).toMatchObject({ ok: true, steps: [{ outcome: 'done' }] });
      expect(readFileSync(join(r.root, 'opt-caddy', 'Caddyfile'), 'utf8')).toContain('shop.example.com {');
      const run = r.calls().find((c) => c.startsWith('docker run'));
      expect(run).toContain('--name guildwise-caddy');
      expect(run).toContain('--network host');
      const busy = rig();
      busy.put('docker', '#!/bin/bash\nexit 0\n');
      busy.put(
        'ss',
        '#!/bin/bash\nprintf "State Recv-Q Send-Q Local Address:Port\\nLISTEN 0 511 0.0.0.0:80 0.0.0.0:*\\n"\n',
      );
      const nope = await busy.run([A]);
      expect(nope).toMatchObject({ ok: false, error: 'port_in_use' });
      expect(busy.calls().some((c) => c.startsWith('docker run'))).toBe(false);
    });
  });

  it('start_services: only the supporting parts, never the app; an existing project is not touched', async () => {
    const r = rig();
    const file = join(r.root, 'shop', 'docker-compose.yml');
    mkdirSync(join(r.root, 'shop'), { recursive: true });
    writeFileSync(file, 'services: {}\n');
    r.put(
      'docker',
      `#!/bin/bash
echo "docker $*" >> "$FAKE_ROOT/calls.log"
case "$*" in
  *"version"*) echo 2.40.0 ;;
  *" ls "*) [ -f "$FAKE_ROOT/exists" ] && echo '[{"Name":"aom-shop-uat","Status":"running(2)"}]' || echo '[]' ;;
  *"config --services"*) printf 'postgres\\napp\\nmailpit\\n' ;;
esac
exit 0
`,
    );
    const A: PrepareAction = {
      kind: 'start_services',
      composeFile: file,
      project: 'aom-shop-uat',
      except: ['app'],
    };
    const dry = await r.run([A], { dryRun: true });
    expect(dry).toMatchObject({ ok: true, steps: [{ outcome: 'would' }] });
    expect(r.calls().some((c) => c.includes(' up '))).toBe(false);
    const out = await r.run([A]);
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, steps: [{ outcome: 'done' }] });
    const up = r.calls().find((c) => c.includes(' up '));
    expect(up).toContain('up -d postgres mailpit');
    expect(up).not.toContain('app');
    expect(r.calls().some((c) => /\b(down|rm|stop|kill)\b/.test(c) && c.startsWith('docker'))).toBe(false);
    writeFileSync(join(r.root, 'exists'), '');
    r.calls().length = 0;
    expect(await r.run([A])).toMatchObject({ ok: true, steps: [{ outcome: 'skipped' }] });
  });

  it('stops at the first action that fails and says which; an unreachable server is "unreachable"', async () => {
    const r = rig();
    writeFileSync(join(r.root, 'blocker'), 'x');
    const out = await r.run([
      { kind: 'create_dir', path: join(r.root, 'blocker', 'sub') },
      { kind: 'create_dir', path: join(r.root, 'never') },
    ]);
    expect(out.ok).toBe(false);
    expect(out.steps).toHaveLength(1);
    expect(existsSync(join(r.root, 'never'))).toBe(false);
    const down = rig();
    down.put('ssh', '#!/bin/bash\necho "ssh: connect to host x port 22: Connection refused" >&2\nexit 255\n');
    expect(await down.run([{ kind: 'create_dir', path: join(down.root, 'x') }])).toMatchObject({
      ok: false,
      error: 'unreachable',
    });
  });
});

describe('deploy.prepare on this computer (a new copy)', () => {
  it('creates the folder, copies the project compose file once, starts the supporting parts', async () => {
    const r = rig();
    const repo = join(r.root, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'docker-compose.yml'), 'services:\n  app:\n    build: .\n');
    r.put(
      'docker',
      `#!/bin/bash
echo "docker $*" >> "$FAKE_ROOT/calls.log"
case "$*" in
  *" ls "*) echo '[]' ;;
  *"config --services"*) printf 'postgres\\napp\\n' ;;
esac
exit 0
`,
    );
    const dir = join(r.root, 'guildwise', 'shop-uat');
    const p = r.prep({ repoPath: async () => repo });
    const actions: PrepareAction[] = [
      { kind: 'create_dir', path: dir },
      {
        kind: 'write_compose',
        path: `${dir}/docker-compose.yml`,
        repoPath: 'docker-compose.yml',
        remote: 'github.com/acme/shop',
      },
      {
        kind: 'start_services',
        composeFile: `${dir}/docker-compose.yml`,
        project: 'aom-shop-uat',
        except: ['app'],
      },
    ] as PrepareAction[];
    const out = await p.run({ projectId: P, hosting: 'this_computer', actions, dryRun: false });
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true });
    expect(out.steps.map((s) => s.outcome)).toEqual(['done', 'done', 'done']);
    expect(readFileSync(join(dir, 'docker-compose.yml'), 'utf8')).toContain('build: .');
    expect(r.calls().find((c) => c.includes(' up '))).toContain('up -d postgres');
    const again = await p.run({ projectId: P, hosting: 'this_computer', actions, dryRun: false });
    expect(again.steps.map((s) => s.outcome)).toEqual(['skipped', 'skipped', 'done']);
    // Docker and Caddy are never installed from here
    expect(
      await p.run({
        projectId: P,
        hosting: 'this_computer',
        actions: [{ kind: 'install_docker' }],
        dryRun: false,
      }),
    ).toMatchObject({ ok: false });
  });
});
