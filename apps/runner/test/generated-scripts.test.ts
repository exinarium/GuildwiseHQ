import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSetup, localAdoptEnv, sshShipEnv } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * The scripts `compileSetup` generates, run for real against FAKE docker, ssh and curl on PATH (design section 9 test plan):
 * dry run changes nothing, a real run restarts only the app service and never runs down, a failed backup stops, an unhealthy
 * site is rolled back to the previous image and the database is left alone.
 */

const COMMIT = '4f2c1ab9d0e84c7aa1b2c3d4e5f60718293a4b5c';
const SHORT = COMMIT.slice(0, 12);

interface World {
  root: string;
  home: string;
  checkout: string;
  bin: string;
  state: string;
  env: NodeJS.ProcessEnv;
  calls: () => string[];
  forbidden: () => string[];
}

const FAKE_DOCKER = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-docker.sh'),
  'utf8',
);

function world(): World {
  const root = tmp('aom-gen-');
  const home = join(root, 'home');
  const checkout = join(root, 'checkout');
  const bin = join(root, 'bin');
  for (const d of [home, checkout, bin]) mkdirSync(d, { recursive: true });
  const put = (name: string, body: string) => {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  };
  put('docker', FAKE_DOCKER);
  put(
    'curl',
    `#!/bin/bash\necho "curl $*" >> "$FAKE_ROOT/calls.log"\nif [ -f "$FAKE_ROOT/unhealthy" ] && [ ! -f "$FAKE_ROOT/healed" ]; then printf 500; else printf 200; fi\n`,
  );
  put('ssh', readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-ssh.sh'), 'utf8'));
  const state = join(root, 'state');
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: root,
    XDG_RUNTIME_DIR: root,
    FAKE_ROOT: root,
    BASH_ENV: join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-sleep.sh'),
  };
  const read = (f: string) =>
    existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8').split('\n').filter(Boolean) : [];
  return {
    root,
    home,
    checkout,
    bin,
    state,
    env,
    calls: () => read('calls.log'),
    forbidden: () => read('forbidden.log'),
  };
}

function script(setup: unknown, name: string): string {
  const c = compileSetup(setup);
  if (!c.ok) throw new Error(c.issues.join('; '));
  return (c.files.find((f) => f.path === `scripts/${name}.sh`) as { content: string }).content;
}

function run(w: World, content: string, over: Record<string, string> = {}) {
  const file = join(w.root, 'deploy.sh');
  writeFileSync(file, content, { mode: 0o755 });
  const r = spawnSync('bash', [file], {
    env: {
      ...w.env,
      AOM_DEPLOY_COMMIT: COMMIT,
      AOM_DEPLOY_CHECKOUT: w.checkout,
      AOM_DEPLOY_ENV: 'x',
      AOM_DEPLOY_APP_URL: 'http://localhost:4700',
      AOM_DEPLOY_DRY_RUN: '0',
      ...over,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

// ----------------------------------------------------------------------------------------------- this computer (UAT)

const uatEnv = () =>
  localAdoptEnv({
    name: 'uat',
    label: 'Test copy',
    target: 'aom-uat',
    composeFile: '~/uat/docker-compose.yml',
    composeProject: 'aom-uat',
    service: 'app',
    imageName: 'aom-uat-app',
    appUrl: 'http://localhost:4700',
    database: { service: 'postgres', dir: '~/uat/backups' },
  });

function uatWorld() {
  const w = world();
  mkdirSync(join(w.home, 'uat'), { recursive: true });
  writeFileSync(join(w.home, 'uat', 'docker-compose.yml'), 'services: {}\n');
  // the stack is running an older build
  mkdirSync(join(w.root, 'state-local'), { recursive: true });
  writeFileSync(join(w.root, 'state-local', 'running'), 'aom-uat-app\n');
  return w;
}

describe('the generated UAT script, against a fake docker', () => {
  const uat = () => script({ environments: [uatEnv()] }, 'uat');

  it('a dry run checks and prints what it would do, and changes nothing', () => {
    const w = uatWorld();
    const r = run(w, uat(), { AOM_DEPLOY_DRY_RUN: '1' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('dry run: only checking');
    expect(r.out).toContain('would: back up the database (postgres)');
    expect(r.out).toContain(
      `would: build aom-uat-app:${SHORT} from the approved version and restart only app`,
    );
    expect(r.out).toContain('dry run finished: nothing was changed');
    expect(existsSync(join(w.home, 'uat', 'backups'))).toBe(false);
    expect(existsSync(join(w.root, 'up.log'))).toBe(false);
    expect(w.forbidden()).toEqual([]);
  });

  it('a real run: backup (newest 20 kept), only the app restarted from the checkout through an override file, tags pruned', () => {
    const w = uatWorld();
    const backups = join(w.home, 'uat', 'backups');
    mkdirSync(backups, { recursive: true });
    for (let i = 0; i < 25; i++) {
      const f = join(
        backups,
        `uat-before-old${String(i).padStart(2, '0')}-20260101-0000${String(i).padStart(2, '0')}.sql.gz`,
      );
      writeFileSync(f, 'old');
      const t = new Date(Date.now() - (30 - i) * 86_400_000);
      spawnSync('touch', ['-d', t.toISOString(), f]);
    }
    writeFileSync(join(backups, 'other-env-before-x.sql.gz'), 'not ours');
    // image tags on this computer (newest first, as docker lists them): 8 builds, the current one and the older ones
    const tags = Array.from({ length: 8 }, (_, i) => `aom-uat-app:${`${i}`.repeat(12)}`).concat([
      'aom-uat-app:latest',
    ]);
    writeFileSync(join(w.root, 'tags'), `${[`aom-uat-app:${SHORT}`, ...tags].join('\n')}\n`);
    const r = run(w, uat());
    expect(r.code, r.out).toBe(0);
    // exactly one up, only the app, no deps, built from the checkout
    const ups = readFileSync(join(w.root, 'up.log'), 'utf8').split('\n').filter(Boolean);
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain('up -d --build --no-deps app');
    const override = readFileSync(join(w.root, 'override.yml'), 'utf8');
    expect(override).toBe(
      `services:\n  app:\n    build: "${w.checkout}"\n    image: "aom-uat-app:${SHORT}"\n`,
    );
    // the owner's compose file was not touched
    expect(readFileSync(join(w.home, 'uat', 'docker-compose.yml'), 'utf8')).toBe('services: {}\n');
    // the backup: a new file, the newest 20 of this environment kept, the other environment's file untouched
    const ours = readdirSync(backups).filter((f) => f.startsWith('uat-before-'));
    expect(ours).toHaveLength(20);
    expect(ours.some((f) => f.includes(SHORT))).toBe(true);
    expect(existsSync(join(backups, 'other-env-before-x.sql.gz'))).toBe(true);
    // old tags beyond the newest 5 are removed one by one (never the new tag, `latest` or a non-sha tag)
    const removed = readFileSync(join(w.root, 'removed.log'), 'utf8').split('\n').filter(Boolean);
    expect(removed.length).toBeGreaterThan(0);
    expect(removed).not.toContain(`aom-uat-app:${SHORT}`);
    expect(removed).not.toContain('aom-uat-app:latest');
    expect(r.out).toMatch(
      /AOM-DEPLOY \{"commit":"4f2c1ab9d0e84c7aa1b2c3d4e5f60718293a4b5c","url":"http:\/\/localhost:4700","version":"aom-uat-app:4f2c1ab9d0e8"\}/,
    );
    expect(w.forbidden()).toEqual([]);
  });

  it('a backup that fails stops everything before the app is touched', () => {
    const w = uatWorld();
    writeFileSync(join(w.root, 'backup-fails'), '');
    const r = run(w, uat());
    expect(r.code).toBe(1);
    expect(r.out).toContain('the database backup failed; nothing was changed');
    expect(existsSync(join(w.root, 'up.log'))).toBe(false);
    // a dump too small to be real stops it too
    const w2 = uatWorld();
    const r2 = run(w2, uat(), { FAKE_DUMP_BYTES: '10' });
    expect(r2.code).toBe(1);
    expect(r2.out).toContain('too small');
    expect(existsSync(join(w2.root, 'up.log'))).toBe(false);
    expect(readdirSync(join(w2.home, 'uat', 'backups'))).toEqual([]);
  });

  it('an unhealthy site is rolled back to the previous image; the database is not rolled back', () => {
    const w = uatWorld();
    writeFileSync(join(w.root, 'unhealthy'), '');
    const r = run(w, uat());
    expect(r.code).toBe(1);
    const imgs = readFileSync(join(w.root, 'up-images.log'), 'utf8').split('\n').filter(Boolean);
    expect(imgs).toEqual([`aom-uat-app:${SHORT}`, 'aom-uat-app']);
    expect(r.out).toContain('putting the previous version back: aom-uat-app');
    expect(r.out).toContain('the database was NOT rolled back');
    expect(r.out).toMatch(/backup made before this update is .*uat-before-/);
    const ups = readFileSync(join(w.root, 'up.log'), 'utf8');
    expect(ups).toContain('--no-build --no-deps app');
    expect(w.forbidden()).toEqual([]);
  });

  it('the same version, healthy: nothing is done', () => {
    const w = uatWorld();
    writeFileSync(join(w.root, 'state-local', 'running'), `aom-uat-app:${SHORT}\n`);
    const r = run(w, uat());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('already deployed');
    expect(existsSync(join(w.root, 'up.log'))).toBe(false);
    expect(existsSync(join(w.home, 'uat', 'backups'))).toBe(false);
  });

  it('refuses a commit that is not a commit id and an unusual checkout path', () => {
    const w = uatWorld();
    expect(run(w, uat(), { AOM_DEPLOY_COMMIT: '$(touch /tmp/pwn)' }).code).toBe(1);
    expect(run(w, uat(), { AOM_DEPLOY_CHECKOUT: w.checkout.replace('checkout', 'check out') }).code).toBe(1);
  });
});

// ----------------------------------------------------------------------------------------------- a server (production)

function prodWorld() {
  const w = world();
  const app = join(w.root, 'server', 'guildwise');
  mkdirSync(join(app, 'backups'), { recursive: true });
  writeFileSync(join(app, 'docker-compose.yml'), 'services: {}\n');
  writeFileSync(
    join(app, '.env'),
    'DATABASE_PASSWORD=keep-me\nGUILDWISE_IMAGE=guildwise-hq:0ldc0mmit000\nOTHER=1\n',
    { mode: 0o600 },
  );
  mkdirSync(join(w.root, 'state-remote'), { recursive: true });
  writeFileSync(join(w.root, 'state-remote', 'running'), 'guildwise-hq:0ldc0mmit000\n');
  const setup = {
    environments: [
      sshShipEnv({
        name: 'production',
        label: 'Live site',
        target: 'prod-server',
        host: 'prod-server',
        composeFile: join(app, 'docker-compose.yml'),
        service: 'app',
        imageName: 'guildwise-hq',
        imageVar: 'GUILDWISE_IMAGE',
        healthUrl: 'https://hq.example.com/ready',
        database: { service: 'postgres', dir: join(app, 'backups') },
      }),
    ],
  };
  return { w, app, setup };
}

describe('the generated production script, against a fake docker and ssh', () => {
  const env = (extra: Record<string, string> = {}) => ({
    AOM_DEPLOY_HOST: 'prod-server',
    AOM_DEPLOY_DRY_RUN: '0',
    ...extra,
  });

  it('a dry run checks the server and changes nothing on it', () => {
    const { w, app, setup } = prodWorld();
    const before = readFileSync(join(app, '.env'), 'utf8');
    const r = run(w, script(setup, 'production'), env({ AOM_DEPLOY_DRY_RUN: '1' }));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('server runs: guildwise-hq:0ldc0mmit000');
    expect(r.out).toContain('would: back up the database (postgres)');
    expect(r.out).toContain(`would: build guildwise-hq:${SHORT}`);
    expect(r.out).toContain(`would: set GUILDWISE_IMAGE=guildwise-hq:${SHORT}`);
    expect(r.out).toContain('would restart only app');
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe(before);
    expect(readdirSync(join(app, 'backups'))).toEqual([]);
    expect(existsSync(join(w.root, 'up.log'))).toBe(false);
    expect(w.calls().some((c) => c.startsWith('docker build') || c.startsWith('docker save'))).toBe(false);
    // every ssh call is non-interactive with strict host keys
    for (const c of w.calls().filter((x) => x.startsWith('ssh '))) {
      expect(c).toContain('BatchMode=yes');
      expect(c).toContain('StrictHostKeyChecking=yes');
    }
  });

  it('a real release: backup, .env copy, build here, ship, switch one line, restart only the app, health', () => {
    const { w, app, setup } = prodWorld();
    const r = run(w, script(setup, 'production'), env());
    expect(r.code, r.out).toBe(0);
    const envText = readFileSync(join(app, '.env'), 'utf8');
    expect(envText).toBe(`DATABASE_PASSWORD=keep-me\nGUILDWISE_IMAGE=guildwise-hq:${SHORT}\nOTHER=1\n`);
    expect(readFileSync(join(app, `.env.bak-before-${SHORT}`), 'utf8')).toBe(
      'DATABASE_PASSWORD=keep-me\nGUILDWISE_IMAGE=guildwise-hq:0ldc0mmit000\nOTHER=1\n',
    );
    expect(readdirSync(join(app, 'backups')).filter((f) => f.startsWith('production-before-'))).toHaveLength(
      1,
    );
    const calls = w.calls();
    expect(calls.some((c) => c.startsWith(`docker build -t guildwise-hq:${SHORT}`))).toBe(true);
    expect(calls).toContain(`docker save guildwise-hq:${SHORT}`);
    expect(calls).toContain('docker load');
    const ups = readFileSync(join(w.root, 'up.log'), 'utf8').split('\n').filter(Boolean);
    expect(ups).toHaveLength(1);
    expect(ups[0]).toContain('up -d --no-deps app');
    expect(r.out).toContain('AOM-DEPLOY {"commit"');
    expect(w.forbidden()).toEqual([]);
  });

  it('a failed backup blocks the release before anything on the server changes', () => {
    const { w, app, setup } = prodWorld();
    writeFileSync(join(w.root, 'backup-fails'), '');
    const before = readFileSync(join(app, '.env'), 'utf8');
    const r = run(w, script(setup, 'production'), env());
    expect(r.code).toBe(1);
    expect(r.out).toContain('the database backup failed; nothing was changed');
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe(before);
    expect(existsSync(join(app, `.env.bak-before-${SHORT}`))).toBe(false);
    expect(w.calls().some((c) => c.startsWith('docker build'))).toBe(false);
  });

  it('a health check that fails puts the previous image back (the .env line and the app), and says the database was not rolled back', () => {
    const { w, app, setup } = prodWorld();
    writeFileSync(join(w.root, 'unhealthy'), '');
    const r = run(w, script(setup, 'production'), env());
    expect(r.code).toBe(1);
    expect(r.out).toContain('putting the previous version back: guildwise-hq:0ldc0mmit000');
    expect(r.out).toContain('the database was NOT rolled back');
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe(
      'DATABASE_PASSWORD=keep-me\nGUILDWISE_IMAGE=guildwise-hq:0ldc0mmit000\nOTHER=1\n',
    );
    const imgs = readFileSync(join(w.root, 'up-images.log'), 'utf8').split('\n').filter(Boolean);
    expect(imgs).toEqual([`guildwise-hq:${SHORT}`, 'guildwise-hq:0ldc0mmit000']);
    expect(w.forbidden()).toEqual([]);
  });

  it('refuses a host name that could be an ssh option', () => {
    const { w, setup } = prodWorld();
    const r = run(w, script(setup, 'production'), env({ AOM_DEPLOY_HOST: '-oProxyCommand=touch /tmp/pwn' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('AOM_DEPLOY_HOST must be the server name');
    expect(w.calls().filter((c) => c.startsWith('ssh '))).toEqual([]);
  });
});
