import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSetup, sshShipEnv } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { cleanupTmp, gitCommit, tmp } from './helpers.ts';

cleanupTmp();

/**
 * The three ways a new version reaches a server (copy from this computer, pull from a registry, build on the server), on a stack
 * that is NOT in /opt, has a LITERAL image tag and no .env variable (the owner's case): the new version is named in
 * docker-compose.guildwise.yml next to the compose file, the compose file is never edited, only the app is replaced (the database
 * container keeps its id), the compose project name comes from the running stack, and an unhealthy site is put back. Run for real
 * against the fake docker (two state folders: this computer and the server) and a fake ssh.
 */

const here = dirname(fileURLToPath(import.meta.url));
// the checkout is a real git repository with one fixed commit (the id never changes while its files do not)
const COMMIT = 'bcd474e3c3c4ae5f1b2aa1fdd0d39f4c55b90b36';
const SHORT = COMMIT.slice(0, 12);
const COMMIT2 = '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a291807';
const SHORT2 = COMMIT2.slice(0, 12);
const OLD_IMAGE = 'dcode-server:remote29-showcase-old000000';

interface W {
  root: string;
  appDir: string;
  checkout: string;
  server: string;
  local: string;
  env: NodeJS.ProcessEnv;
  calls: (side: 'server' | 'local') => string[];
  cid: (svc: string) => string;
  image: (svc: string) => string;
}

function world(): W {
  const root = tmp('aom-flow-');
  const home = join(root, 'home');
  const appDir = join(root, 'srv-home', 'app', 'flow');
  const checkout = join(root, 'checkout');
  const bin = join(root, 'bin');
  const server = join(root, 'state-server');
  const local = join(root, 'state-local');
  for (const d of [
    home,
    appDir,
    checkout,
    bin,
    server,
    local,
    join(server, 'c'),
    join(server, 'images'),
    join(local, 'images'),
  ])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(checkout, 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(checkout, 'app.js'), 'console.log(1)\n');
  gitCommit(checkout);
  const put = (name: string, from: string) => {
    writeFileSync(join(bin, name), readFileSync(join(here, 'fixtures', from), 'utf8'));
    chmodSync(join(bin, name), 0o755);
  };
  put('docker', 'fake-flow-docker.sh');
  put('ssh', 'fake-ssh.sh');
  writeFileSync(
    join(bin, 'curl'),
    `#!/bin/bash\necho "curl $*" >> "$FAKE_ROOT/curl.log"\nif [ -f "$FAKE_ROOT/unhealthy" ] && [ "$(sed -n 2p "$FAKE_STATE_REMOTE/c/dcode-server")" = "$(cat "$FAKE_ROOT/unhealthy")" ]; then printf 500; else printf 200; fi\n`,
  );
  chmodSync(join(bin, 'curl'), 0o755);
  // the running stack (as `docker compose up` left it): its compose file has a LITERAL tag, a published port, no .env variable
  writeFileSync(
    join(appDir, 'compose.yaml'),
    `services:\n  dcode-server:\n    image: ${OLD_IMAGE}\n    ports:\n      - "5500:500"\n  postgres:\n    image: postgres:18\n`,
  );
  const files = join(appDir, 'compose.yaml');
  const seed = (svc: string, id: string, image: string, port = '') =>
    writeFileSync(join(server, 'c', svc), `${id}\n${image}\ndcode-flow5-remote\n${files}\n${port}\n`);
  seed('dcode-server', 'app-old-cid', OLD_IMAGE, '5500');
  seed('postgres', 'db-cid-1', 'postgres:18');
  writeFileSync(join(server, 'images', OLD_IMAGE.replace(/[/:@]/g, '_')), OLD_IMAGE);
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: root,
    XDG_RUNTIME_DIR: root,
    FAKE_ROOT: root,
    FAKE_STATE: local,
    FAKE_STATE_REMOTE: server,
    FAKE_REGISTRY_FILE: join(root, 'registry.txt'),
    BASH_ENV: join(here, 'fixtures', 'fake-sleep.sh'),
    AOM_DEPLOY_COMMIT: COMMIT,
    AOM_DEPLOY_CHECKOUT: checkout,
    AOM_DEPLOY_APP_URL: 'http://127.0.0.1:5500',
    AOM_DEPLOY_DRY_RUN: '0',
    AOM_DEPLOY_HOST: 'e2e-flow',
    AOM_DEPLOY_SSH: join(bin, 'ssh'),
  };
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
  return {
    root,
    appDir,
    checkout,
    server,
    local,
    env,
    calls: (side) => read(join(side === 'server' ? server : local, 'calls.log')),
    cid: (svc) => read(join(server, 'c', svc))[0] ?? '',
    image: (svc) => read(join(server, 'c', svc))[1] ?? '',
  };
}

const flow = (w: W, over: Record<string, unknown> = {}) =>
  sshShipEnv({
    name: 'live',
    label: 'Live site',
    target: 'flow5-server',
    host: 'e2e-flow',
    composeFile: join(w.appDir, 'compose.yaml'),
    composeProject: 'dcode-flow5-remote',
    service: 'dcode-server',
    imageName: 'dcode-server',
    healthUrl: 'http://127.0.0.1:5500/ready',
    database: { service: 'postgres', dir: join(w.appDir, 'backups') },
    ...over,
  } as never);

function script(env: unknown): string {
  const c = compileSetup({ environments: [env] });
  if (!c.ok) throw new Error(c.issues.join('; '));
  return (c.files.find((f) => f.path === 'scripts/live.sh') as { content: string }).content;
}

function run(w: W, content: string, over: Record<string, string> = {}) {
  const file = join(w.root, 'deploy.sh');
  writeFileSync(file, content, { mode: 0o755 });
  const r = spawnSync('bash', [file], { env: { ...w.env, ...over }, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const sha = (f: string) => spawnSync('sha256sum', [f], { encoding: 'utf8' }).stdout.split(' ')[0];
const override = (w: W) => join(w.appDir, 'docker-compose.guildwise.yml');

describe('copy from this computer, a literal tag and no .env variable (the owner’s server)', () => {
  it('a dry run checks and changes nothing', () => {
    const w = world();
    const r = run(w, script(flow(w)), { AOM_DEPLOY_DRY_RUN: '1' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('would: back up the database');
    expect(r.out).toContain('docker-compose.guildwise.yml');
    expect(existsSync(override(w))).toBe(false);
    expect(existsSync(join(w.appDir, 'backups'))).toBe(false);
    expect(w.cid('dcode-server')).toBe('app-old-cid');
  });

  it('a real release: backup, build here, copy over, override file, ONLY the app is replaced, compose file and .env untouched', () => {
    const w = world();
    const composeSha = sha(join(w.appDir, 'compose.yaml'));
    const r = run(w, script(flow(w)));
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(override(w), 'utf8')).toContain(`image: "dcode-server:${SHORT}"`);
    expect(sha(join(w.appDir, 'compose.yaml'))).toBe(composeSha);
    expect(existsSync(join(w.appDir, '.env'))).toBe(false);
    expect(w.cid('postgres')).toBe('db-cid-1');
    expect(w.cid('dcode-server')).not.toBe('app-old-cid');
    expect(w.image('dcode-server')).toBe(`dcode-server:${SHORT}`);
    expect(readdirSync(join(w.appDir, 'backups'))).toHaveLength(1);
    // the stack's own project name is used for everything on the server, never the folder name
    const server = w.calls('server');
    expect(
      server
        .filter((c) => c.startsWith('docker compose') && !c.includes('version'))
        .every((c) => c.includes('-p dcode-flow5-remote')),
    ).toBe(true);
    expect(server.some((c) => /up -d --no-deps --no-build dcode-server/.test(c))).toBe(true);
    expect(server.some((c) => /\b(down|rm|stop|kill)\b/.test(c))).toBe(false);
    expect(w.calls('local').some((c) => c.startsWith('docker build -t dcode-server:'))).toBe(true);
    expect(r.out).toContain('AOM-DEPLOY');
  });

  it('an unhealthy release goes back to the earlier image; with no override file before, the override is removed (not pinned); the database is untouched', () => {
    const w = world();
    writeFileSync(join(w.root, 'unhealthy'), `dcode-server:${SHORT}`);
    const r = run(w, script(flow(w)));
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toContain('putting the previous version back');
    expect(r.out).toContain('the database was NOT rolled back');
    expect(r.out).toContain('the compose file names the image again');
    expect(existsSync(override(w))).toBe(false);
    expect(w.image('dcode-server')).toBe(OLD_IMAGE);
    expect(w.cid('postgres')).toBe('db-cid-1');
  });

  it('an unhealthy release after an earlier one goes back to the earlier image through the same override file', () => {
    const w = world();
    expect(run(w, script(flow(w))).code).toBe(0);
    writeFileSync(join(w.root, 'unhealthy'), `dcode-server:${SHORT2}`);
    const r = run(w, script(flow(w)), { AOM_DEPLOY_COMMIT: COMMIT2 });
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toContain('putting the previous version back');
    expect(readFileSync(override(w), 'utf8')).toContain(`image: "dcode-server:${SHORT}"`);
    expect(w.image('dcode-server')).toBe(`dcode-server:${SHORT}`);
  });

  it('a second release replaces the first; the earlier override is kept as a copy', () => {
    const w = world();
    expect(run(w, script(flow(w))).code).toBe(0);
    const r = run(w, script(flow(w)), { AOM_DEPLOY_COMMIT: COMMIT2 });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(override(w), 'utf8')).toContain(`dcode-server:${SHORT2}`);
    expect(existsSync(`${override(w)}.bak-before-${SHORT2}`)).toBe(true);
    expect(w.cid('postgres')).toBe('db-cid-1');
  });

  it('a failed backup stops everything before the image is copied', () => {
    const w = world();
    writeFileSync(join(w.server, 'fail-dump'), '1');
    const r = run(w, script(flow(w)));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('the database backup failed; nothing was changed');
    expect(existsSync(override(w))).toBe(false);
    expect(w.cid('dcode-server')).toBe('app-old-cid');
  });
});

describe('pull from a registry', () => {
  it('builds here, uploads, the server pulls, the override names the registry image; CI mode only pulls', () => {
    const w = world();
    const env = flow(w, { method: 'registry', registry: '192.168.1.11:5000' });
    const r = run(w, script(env));
    expect(r.code, r.out).toBe(0);
    const tag = `192.168.1.11:5000/dcode-server:${SHORT}`;
    expect(readFileSync(override(w), 'utf8')).toContain(`image: "${tag}"`);
    expect(w.calls('local')).toEqual(expect.arrayContaining([`docker push ${tag}`]));
    expect(w.calls('server')).toEqual(expect.arrayContaining([`docker pull ${tag}`]));
    expect(w.cid('postgres')).toBe('db-cid-1');
    // CI already pushed a later commit: no build, no push
    const w2 = world();
    writeFileSync(join(w2.root, 'registry.txt'), `192.168.1.11:5000/dcode-server:${SHORT}\n`);
    const ci = run(
      w2,
      script(flow(w2, { method: 'registry', registry: '192.168.1.11:5000', registryPush: false })),
    );
    expect(ci.code, ci.out).toBe(0);
    expect(w2.calls('local').some((c) => c.startsWith('docker build') || c.startsWith('docker push'))).toBe(
      false,
    );
  });

  it('an image the registry does not have stops before anything is switched, with a plain reason', () => {
    const w = world();
    writeFileSync(join(w.root, 'registry.txt'), '');
    const r = run(
      w,
      script(flow(w, { method: 'registry', registry: '192.168.1.11:5000', registryPush: false })),
    );
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('the server could not download');
    expect(existsSync(override(w))).toBe(false);
    expect(w.cid('dcode-server')).toBe('app-old-cid');
  });
});

describe('build on the server', () => {
  it('the approved files are copied to a folder of their own, the server builds only the app, nothing else is built or replaced', () => {
    const w = world();
    // an untracked file (a settings file with a secret) is not part of the approved version and is not sent
    writeFileSync(join(w.checkout, '.env'), 'SECRET=1\n');
    // the compose file builds the app (a build: line), as many stacks do
    writeFileSync(
      join(w.appDir, 'compose.yaml'),
      `services:\n  dcode-server:\n    build: ./src\n    image: ${OLD_IMAGE}\n    ports:\n      - "5500:500"\n  postgres:\n    image: postgres:18\n`,
    );
    const r = run(w, script(flow(w, { method: 'build_on_server' })));
    expect(r.code, r.out).toBe(0);
    const src = join(w.appDir, 'guildwise-src', SHORT);
    expect(readFileSync(join(src, 'app.js'), 'utf8')).toContain('console.log(1)');
    expect(existsSync(join(src, '.env'))).toBe(false);
    expect(existsSync(join(src, '.aom-complete'))).toBe(true);
    expect(w.image('dcode-server')).toBe(`dcode-server:${SHORT}`);
    expect(readFileSync(override(w), 'utf8')).toContain(`dcode-server:${SHORT}`);
    expect(w.cid('postgres')).toBe('db-cid-1');
    expect(statSync(src).isDirectory()).toBe(true);
    expect(w.calls('server').filter((c) => / build /.test(c))).toHaveLength(1);
  });
});

describe('a stack that was started another way is not restarted (M3), and a source that is not git is not sent (m11)', () => {
  const labels = (w: W, line: string) => writeFileSync(join(w.server, 'labels'), `${line}\n`);
  const cases: Array<[string, (w: W) => string, string]> = [
    [
      'several compose files',
      (w) =>
        `${join(w.appDir, 'compose.yaml')},${join(w.appDir, 'extra.yaml')}|${w.appDir}|dcode-flow5-remote|`,
      'several compose files',
    ],
    [
      'another compose file',
      (w) => `${join(w.root, 'elsewhere', 'compose.yaml')}|${join(w.root, 'elsewhere')}|dcode-flow5-remote|`,
      'not from',
    ],
    [
      'another project folder',
      (w) => `${join(w.appDir, 'compose.yaml')}|${join(w.root, 'other')}|dcode-flow5-remote|`,
      'another project folder',
    ],
    [
      'an --env-file',
      (w) => `${join(w.appDir, 'compose.yaml')}|${w.appDir}|dcode-flow5-remote|${join(w.root, 'x.env')}`,
      '--env-file',
    ],
  ];
  it.each(cases)(
    '%s: a plain stop, in the dry run and the real run, before anything changes',
    (_n, line, text) => {
      const w = world();
      labels(w, line(w));
      for (const dry of ['1', '0']) {
        const r = run(w, script(flow(w)), { AOM_DEPLOY_DRY_RUN: dry });
        expect(r.code).not.toBe(0);
        expect(r.out).toContain(text);
        expect(r.out).toMatch(/nothing was changed/i);
        expect(existsSync(override(w))).toBe(false);
        expect(w.cid('dcode-server')).toBe('app-old-cid');
        expect(existsSync(join(w.appDir, 'backups'))).toBe(false);
      }
    },
  );

  it('the compose file plus the override file that Guildwise itself writes is the normal case', () => {
    const w = world();
    labels(
      w,
      `${join(w.appDir, 'compose.yaml')},${join(w.appDir, 'docker-compose.guildwise.yml')}|${w.appDir}|dcode-flow5-remote|`,
    );
    const r = run(w, script(flow(w)));
    expect(r.code, r.out).toBe(0);
  });

  it('files that are not a git checkout are refused before anything is copied to the server', () => {
    const w = world();
    rmSync(join(w.checkout, '.git'), { recursive: true, force: true });
    writeFileSync(
      join(w.appDir, 'compose.yaml'),
      `services:\n  dcode-server:\n    build: ./src\n    image: ${OLD_IMAGE}\n    ports:\n      - "5500:500"\n  postgres:\n    image: postgres:18\n`,
    );
    const r = run(w, script(flow(w, { method: 'build_on_server' })));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('not a git checkout');
    expect(existsSync(join(w.appDir, 'guildwise-src'))).toBe(false);
    expect(existsSync(override(w))).toBe(false);
  });
});
