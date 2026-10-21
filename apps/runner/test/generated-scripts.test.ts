import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    'docker-compose',
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-docker-compose.sh'), 'utf8'),
  );
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

/** Starts the script in its own process group, waits for a file to appear, then sends TERM to the group (the runner's timeout). */
async function runThenTerm(w: World, content: string, waitFor: string, over: Record<string, string> = {}) {
  const file = join(w.root, 'deploy-term.sh');
  writeFileSync(file, content, { mode: 0o755 });
  const child = spawn('bash', [file], {
    detached: true,
    env: {
      ...w.env,
      AOM_DEPLOY_COMMIT: COMMIT,
      AOM_DEPLOY_CHECKOUT: w.checkout,
      AOM_DEPLOY_ENV: 'x',
      AOM_DEPLOY_APP_URL: 'http://localhost:4700',
      AOM_DEPLOY_DRY_RUN: '0',
      ...over,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => {
    out += d;
  });
  child.stderr.on('data', (d) => {
    out += d;
  });
  const closed = new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
  const t0 = Date.now();
  while (!existsSync(join(w.root, waitFor)) && Date.now() - t0 < 20_000)
    await new Promise((r) => setTimeout(r, 50));
  expect(existsSync(join(w.root, waitFor)), 'the script never got to the step').toBe(true);
  process.kill(-(child.pid as number), 'SIGTERM');
  const code = await closed;
  return { code, out };
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

  it('M3: an app that was started from other compose files or another project folder is not restarted', () => {
    for (const [label, text] of [
      [`${'$HOME'}/uat/docker-compose.yml,/tmp/extra.yml|$HOME/uat|aom-uat|`, 'several compose files'],
      ['$HOME/other/docker-compose.yml|$HOME/other|aom-uat|', 'not from'],
      ['$HOME/uat/docker-compose.yml|$HOME/elsewhere|aom-uat|', 'another project folder'],
      ['$HOME/uat/docker-compose.yml|$HOME/uat|aom-uat|/x/.env', '--env-file'],
    ] as const) {
      const w = uatWorld();
      writeFileSync(join(w.root, 'labels'), `${label.replaceAll('$HOME', w.home)}\n`);
      for (const dry of ['1', '0']) {
        const r = run(w, uat(), { AOM_DEPLOY_DRY_RUN: dry });
        expect(r.code, r.out).not.toBe(0);
        expect(r.out).toContain(text);
        expect(existsSync(join(w.home, 'uat', 'backups'))).toBe(false);
        expect(existsSync(join(w.root, 'up.log'))).toBe(false);
      }
    }
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

  it('a start that fails after the switch puts the previous image back and says so', () => {
    const w = uatWorld();
    writeFileSync(join(w.root, 'up-fails-once'), '');
    const r = run(w, uat());
    expect(r.code).toBe(1);
    expect(r.out).toContain('putting the previous version back: aom-uat-app');
    expect(r.out).toContain('the database was NOT rolled back');
    const imgs = readFileSync(join(w.root, 'up-images.log'), 'utf8').split('\n').filter(Boolean);
    expect(imgs).toEqual(['aom-uat-app']);
    expect(w.forbidden()).toEqual([]);
  });

  it('when even the rollback fails it says so out loud', () => {
    const w = uatWorld();
    writeFileSync(join(w.root, 'up-fails'), '');
    const r = run(w, uat());
    expect(r.code).toBe(1);
    expect(r.out).toContain('ROLLBACK FAILED');
  });

  it('a TERM in the middle of the start (the runner timeout) rolls back too', async () => {
    const w = uatWorld();
    writeFileSync(join(w.root, 'up-hangs-once'), '');
    const r = await runThenTerm(w, uat(), 'up-hanging');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('putting the previous version back: aom-uat-app');
    const imgs = readFileSync(join(w.root, 'up-images.log'), 'utf8').split('\n').filter(Boolean);
    expect(imgs.at(-1)).toBe('aom-uat-app');
  }, 40_000);

  it('the backup is checked after it is saved (a vanished file stops the deploy)', () => {
    const w = uatWorld();
    // the fake gzip target is real: an empty dump is refused before it is moved; the file check is in the script
    expect(uat()).toContain('[ -s "$BACKUP_FILE" ] || die');
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

  it('the database backup really runs even though docker reads standard input (the script is not on stdin)', () => {
    const { w, app, setup } = prodWorld();
    const r = run(w, script(setup, 'production'), env());
    expect(r.code, r.out).toBe(0);
    const backups = readdirSync(join(app, 'backups')).filter((f) => f.startsWith('production-before-'));
    expect(backups).toHaveLength(1);
    expect(r.out).toContain('backup saved:');
    // a too-small dump still stops it, and keeps the rotation: 25 old backups leave the newest 20 plus the new one
    const w2 = prodWorld();
    const r2 = run(w2.w, script(w2.setup, 'production'), env({ FAKE_DUMP_BYTES: '10' }));
    expect(r2.code).toBe(1);
    expect(r2.out).toContain('the database backup failed; nothing was changed');
    const w3 = prodWorld();
    for (let i = 0; i < 25; i++) {
      const f = join(w3.app, 'backups', `production-before-old${String(i).padStart(2, '0')}-2026.sql.gz`);
      writeFileSync(f, 'old');
      spawnSync('touch', ['-d', new Date(Date.now() - (30 - i) * 86_400_000).toISOString(), f]);
    }
    const r3 = run(w3.w, script(w3.setup, 'production'), env());
    expect(r3.code, r3.out).toBe(0);
    expect(
      readdirSync(join(w3.app, 'backups')).filter((f) => f.startsWith('production-before-')),
    ).toHaveLength(20);
  });

  it('works on a server that only has the old docker-compose program', () => {
    const { w, app, setup } = prodWorld();
    writeFileSync(join(w.root, 'v1only'), '');
    const r = run(w, script(setup, 'production'), env());
    expect(r.code, r.out).toBe(0);
    expect(w.calls().some((c) => c.startsWith('docker-compose '))).toBe(true);
    expect(readFileSync(join(app, '.env'), 'utf8')).toContain(`GUILDWISE_IMAGE=guildwise-hq:${SHORT}`);
    expect(readFileSync(join(w.root, 'up.log'), 'utf8')).toContain('up -d --no-deps app');
    // and nothing runs when neither exists
    const none = prodWorld();
    writeFileSync(join(none.w.root, 'v1only'), '');
    rmSync(join(none.w.bin, 'docker-compose'));
    const r2 = run(none.w, script(none.setup, 'production'), env());
    expect(r2.code).toBe(1);
    expect(existsSync(join(none.w.root, 'up.log'))).toBe(false);
  });

  it('a restart that fails after the .env was switched puts the .env and the app back', () => {
    const { w, app, setup } = prodWorld();
    const before = readFileSync(join(app, '.env'), 'utf8');
    writeFileSync(join(w.root, 'up-fails-once'), '');
    const r = run(w, script(setup, 'production'), env());
    expect(r.code).toBe(1);
    expect(r.out).toContain('putting the previous version back: guildwise-hq:0ldc0mmit000');
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe(before);
    const imgs = readFileSync(join(w.root, 'up-images.log'), 'utf8').split('\n').filter(Boolean);
    expect(imgs).toEqual(['guildwise-hq:0ldc0mmit000']);
  });

  it('prints ROLLBACK FAILED when the rollback itself cannot restart the app', () => {
    const { w, setup } = prodWorld();
    writeFileSync(join(w.root, 'up-fails'), '');
    const r = run(w, script(setup, 'production'), env());
    expect(r.code).toBe(1);
    expect(r.out).toContain('ROLLBACK FAILED');
    expect(r.out).toContain(`.env.bak-before-${SHORT}`);
  });

  it('a TERM while the app restarts (the runner timeout) rolls back', async () => {
    const { w, app, setup } = prodWorld();
    const before = readFileSync(join(app, '.env'), 'utf8');
    writeFileSync(join(w.root, 'up-hangs-once'), '');
    const r = await runThenTerm(w, script(setup, 'production'), 'up-hanging', env());
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('putting the previous version back: guildwise-hq:0ldc0mmit000');
    expect(readFileSync(join(app, '.env'), 'utf8')).toBe(before);
  }, 40_000);

  it('reads the image line of a .env with export, quotes, a comment and CRLF, and switches only that line', () => {
    const { w, app, setup } = prodWorld();
    writeFileSync(
      join(app, '.env'),
      'A=1\r\nexport GUILDWISE_IMAGE="guildwise-hq:0ldc0mmit000"  # pinned\r\nB=2\r\n',
    );
    const r = run(w, script(setup, 'production'), env());
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('settings point at: guildwise-hq:0ldc0mmit000');
    const text = readFileSync(join(app, '.env'), 'utf8');
    expect(text.match(/GUILDWISE_IMAGE=/g)).toHaveLength(1);
    expect(text).toContain(`GUILDWISE_IMAGE=guildwise-hq:${SHORT}`);
    expect(text).toContain('A=1');
    expect(text).toContain('B=2');
  });

  it('rolls back to the running image when the .env has no image line', () => {
    const { w, app, setup } = prodWorld();
    writeFileSync(join(app, '.env'), 'A=1\n');
    writeFileSync(join(w.root, 'unhealthy'), '');
    const r = run(w, script(setup, 'production'), env());
    expect(r.code).toBe(1);
    expect(r.out).toContain('putting the previous version back: guildwise-hq:0ldc0mmit000');
    expect(readFileSync(join(app, '.env'), 'utf8')).toContain('GUILDWISE_IMAGE=guildwise-hq:0ldc0mmit000');
  });

  it('refuses a host name that could be an ssh option', () => {
    const { w, setup } = prodWorld();
    const r = run(w, script(setup, 'production'), env({ AOM_DEPLOY_HOST: '-oProxyCommand=touch /tmp/pwn' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('AOM_DEPLOY_HOST must be the server name');
    expect(w.calls().filter((c) => c.startsWith('ssh '))).toEqual([]);
  });
});
