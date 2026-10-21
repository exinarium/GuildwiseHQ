import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSetup, type DirectManager, directEnv } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * The scripts for an app that runs DIRECTLY on the machine (no Docker), run for real against a fake `systemctl`, `pm2`, `sudo`,
 * `curl` and `ssh` on PATH: a dry run changes nothing, a real run keeps one folder per version and only the app is restarted
 * (through sudo only when confirmed), a failed build or backup stops before anything is switched, an unhealthy site is rolled
 * back to the previous folder, a plain folder is only adopted when the person said so, and old folders are pruned safely.
 */

const COMMIT = '4f2c1ab9d0e84c7aa1b2c3d4e5f60718293a4b5c';
const SHORT = COMMIT.slice(0, 12);
const OLD = 'a'.repeat(12);
const here = dirname(fileURLToPath(import.meta.url));

interface World {
  root: string;
  home: string;
  app: string;
  checkout: string;
  env: NodeJS.ProcessEnv;
  calls: () => string[];
}

function world(): World {
  const root = tmp('aom-direct-');
  const home = join(root, 'home');
  const app = join(home, 'app');
  const checkout = join(root, 'checkout');
  const bin = join(root, 'bin');
  for (const d of [home, app, checkout, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(join(checkout, 'server.js'), 'console.log("hi")\n');
  writeFileSync(join(checkout, 'package.json'), '{}\n');
  const put = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  put(
    'systemctl',
    `echo "systemctl $*" >> "$FAKE_ROOT/calls.log"
args=("$@"); [ "\${args[0]:-}" = "--user" ] && args=("\${args[@]:1}")
case "\${args[0]:-}" in
  show) [ -f "$FAKE_ROOT/unknown-unit" ] && echo not-found || echo loaded ;;
  restart) [ -f "$FAKE_ROOT/restart-fails" ] && exit 1; echo "\${args[1]}" >> "$FAKE_ROOT/restarts.log" ;;
  *) echo "fake systemctl: unexpected $*" >&2; exit 2 ;;
esac`,
  );
  put(
    'pm2',
    `echo "pm2 $*" >> "$FAKE_ROOT/calls.log"
case "$1" in describe) exit 0 ;; restart) echo "$2" >> "$FAKE_ROOT/restarts.log" ;; *) echo "fake pm2: unexpected $*" >&2; exit 2 ;; esac`,
  );
  put(
    'sudo',
    `echo "sudo $*" >> "$FAKE_ROOT/calls.log"
if [ "$1" = -n ]; then shift; else echo "sudo asked for a password" >> "$FAKE_ROOT/forbidden.log"; exit 1; fi
if [ -f "$FAKE_ROOT/sudo-asks" ]; then echo "sudo: a password is required" >&2; exit 1; fi
exec "$@"`,
  );
  put(
    'curl',
    `echo "curl $*" >> "$FAKE_ROOT/calls.log"
n=0; [ -f "$FAKE_ROOT/restarts.log" ] && n=$(wc -l < "$FAKE_ROOT/restarts.log")
if [ -f "$FAKE_ROOT/unhealthy" ] && [ "$n" -lt "$(cat "$FAKE_ROOT/unhealthy")" ]; then printf 500; else printf 200; fi`,
  );
  put(
    'pg_dump',
    `[ -f "$FAKE_ROOT/dump-fails" ] && exit 1
for i in $(seq 1 40); do echo "-- fake dump line $i of the database $1 padding padding"; done`,
  );
  writeFileSync(join(bin, 'ssh'), readFileSync(join(here, 'fixtures', 'fake-ssh.sh'), 'utf8'));
  chmodSync(join(bin, 'ssh'), 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: root,
    XDG_RUNTIME_DIR: root,
    FAKE_ROOT: root,
    BASH_ENV: join(here, 'fixtures', 'fake-sleep.sh'),
    AOM_DEPLOY_COMMIT: COMMIT,
    AOM_DEPLOY_CHECKOUT: checkout,
    AOM_DEPLOY_APP_URL: 'http://localhost:3000',
    AOM_DEPLOY_DRY_RUN: '0',
    AOM_DEPLOY_HOST: 'shop-box',
  };
  const read = (f: string) =>
    existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8').split('\n').filter(Boolean) : [];
  return { root, home, app, checkout, env, calls: () => read('calls.log') };
}

const restarts = (w: World) =>
  existsSync(join(w.root, 'restarts.log')) ? readFileSync(join(w.root, 'restarts.log'), 'utf8').split('\n').filter(Boolean) : [];
const forbidden = (w: World) =>
  existsSync(join(w.root, 'forbidden.log')) ? readFileSync(join(w.root, 'forbidden.log'), 'utf8') : '';

const systemd = (over: Partial<Extract<DirectManager, { kind: 'systemd' }>> = {}): DirectManager => ({
  kind: 'systemd',
  unit: 'shop.service',
  scope: 'system',
  sudo: false,
  ...over,
});

function script(w: World, over: Record<string, unknown> = {}, host = false): string {
  const env = directEnv({
    name: 'live',
    label: 'Live site',
    target: 'shop',
    appDir: w.app,
    ...(host ? { host: 'shop-box' } : {}),
    manager: systemd({ sudo: true }),
    build: [{ label: 'Install', argv: ['sh', '-c', 'echo built > built.txt'] }],
    shared: ['.env'],
    database: { engine: 'postgres', database: 'shop', dir: join(w.app, 'backups') },
    healthUrl: 'http://127.0.0.1:3000/health',
    ...over,
  } as never);
  const c = compileSetup({ environments: [env] });
  if (!c.ok) throw new Error(c.issues.join('; '));
  return (c.files.find((f) => f.path === 'scripts/live.sh') as { content: string }).content;
}

function run(w: World, content: string, over: Record<string, string> = {}) {
  const file = join(w.root, 'deploy.sh');
  writeFileSync(file, content, { mode: 0o755 });
  const r = spawnSync('bash', [file], { env: { ...w.env, ...over }, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** An earlier release is running: `releases/<OLD>` with a marker file, `current` pointing at it, a shared settings file. */
function running(w: World): string {
  const rel = join(w.app, 'releases', OLD);
  mkdirSync(rel, { recursive: true });
  writeFileSync(join(rel, 'marker.txt'), 'old version');
  mkdirSync(join(w.app, 'shared'), { recursive: true });
  writeFileSync(join(w.app, 'shared', '.env'), 'SECRET=keep-me\n');
  symlinkSync(rel, join(w.app, 'current'));
  return rel;
}

describe('an app that runs directly: this computer, systemd with confirmed sudo', () => {
  it('a dry run checks and says what it would do, and changes nothing', () => {
    const w = world();
    running(w);
    const r = run(w, script(w), { AOM_DEPLOY_DRY_RUN: '1' });
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('dry run: only checking');
    expect(r.out).toContain('would: back up the postgres database');
    expect(r.out).toContain(`would: point ${join(w.app, 'current')} at ${join(w.app, 'releases', SHORT)}`);
    expect(r.out).toContain('dry run finished: nothing was changed');
    expect(readdirSync(join(w.app, 'releases'))).toEqual([OLD]);
    expect(readlinkSync(join(w.app, 'current'))).toBe(join(w.app, 'releases', OLD));
    expect(restarts(w)).toEqual([]);
    expect(existsSync(join(w.app, 'backups'))).toBe(false);
  });

  it('a real run: new folder, shared file linked, build, link switched, only the app restarted with sudo -n, backup kept', () => {
    const w = world();
    running(w);
    const r = run(w, script(w));
    expect(r.code, r.out).toBe(0);
    const rel = join(w.app, 'releases', SHORT);
    expect(readFileSync(join(rel, 'server.js'), 'utf8')).toContain('hi');
    expect(readFileSync(join(rel, 'built.txt'), 'utf8')).toBe('built\n');
    expect(lstatSync(join(rel, '.env')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(rel, '.env'), 'utf8')).toBe('SECRET=keep-me\n');
    expect(readlinkSync(join(w.app, 'current'))).toBe(rel);
    // the earlier version is still there, untouched
    expect(readFileSync(join(w.app, 'releases', OLD, 'marker.txt'), 'utf8')).toBe('old version');
    expect(restarts(w)).toEqual(['shop.service']);
    expect(w.calls().filter((c) => c.startsWith('sudo'))).toEqual(['sudo -n systemctl restart shop.service']);
    expect(readdirSync(join(w.app, 'backups'))).toHaveLength(1);
    expect(r.out).toContain('AOM-DEPLOY {"commit"');
    expect(forbidden(w)).toBe('');
    // never any other service, never stop/disable
    expect(w.calls().filter((c) => /systemctl (stop|disable|mask|kill|daemon)/.test(c))).toEqual([]);
  });

  it('the first deploy into an empty app folder works (nothing to go back to)', () => {
    const w = world();
    const r = run(w, script(w, { shared: [], database: undefined }));
    expect(r.code, r.out).toBe(0);
    expect(readlinkSync(join(w.app, 'current'))).toBe(join(w.app, 'releases', SHORT));
  });

  it('the same version again, healthy: nothing happens', () => {
    const w = world();
    const rel = join(w.app, 'releases', SHORT);
    mkdirSync(rel, { recursive: true });
    symlinkSync(rel, join(w.app, 'current'));
    const r = run(w, script(w, { shared: [], database: undefined }));
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('already deployed');
    expect(restarts(w)).toEqual([]);
  });

  it('an unhealthy site: the link goes back to the previous folder, the app is restarted again, the database is left alone', () => {
    const w = world();
    const old = running(w);
    writeFileSync(join(w.root, 'unhealthy'), '2'); // unhealthy until the second restart
    const r = run(w, script(w));
    expect(r.code, r.out).not.toBe(0);
    expect(r.out).toContain('putting the previous version back');
    expect(r.out).toContain(`rolled back to ${old}`);
    expect(r.out).toContain('the database was NOT rolled back');
    expect(readlinkSync(join(w.app, 'current'))).toBe(old);
    expect(restarts(w)).toEqual(['shop.service', 'shop.service']);
    // the failed version's folder is kept for a look
    expect(existsSync(join(w.app, 'releases', SHORT))).toBe(true);
  });

  it('a build that fails stops before anything is switched or restarted', () => {
    const w = world();
    const old = running(w);
    const r = run(w, script(w, { build: [{ label: 'Install', argv: ['false'] }] }));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('the build step "Install" failed; the running app was not touched');
    expect(readlinkSync(join(w.app, 'current'))).toBe(old);
    expect(restarts(w)).toEqual([]);
  });

  it('a failed database backup stops everything', () => {
    const w = world();
    const old = running(w);
    writeFileSync(join(w.root, 'dump-fails'), '1');
    const r = run(w, script(w));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('the database backup failed; nothing was changed');
    expect(readdirSync(join(w.app, 'releases'))).toEqual([OLD]);
    expect(readlinkSync(join(w.app, 'current'))).toBe(old);
    expect(restarts(w)).toEqual([]);
  });

  it('sudo that asks for a password is a plain stop in the dry run, and sudo is never used when not confirmed', () => {
    const w = world();
    running(w);
    writeFileSync(join(w.root, 'sudo-asks'), '1');
    const r = run(w, script(w), { AOM_DEPLOY_DRY_RUN: '1' });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('needs sudo, and sudo asks for a password here');
    const w2 = world();
    running(w2);
    const r2 = run(w2, script(w2, { manager: systemd({ sudo: false }) }));
    expect(r2.code, r2.out).toBe(0);
    expect(w2.calls().filter((c) => c.startsWith('sudo'))).toEqual([]);
    expect(w2.calls()).toContain('systemctl restart shop.service');
  });

  it('old release folders are pruned (newest 5 kept) but never the running one, the previous one or anything else', () => {
    const w = world();
    const old = running(w);
    for (let i = 0; i < 8; i++) {
      const name = `${i}`.repeat(12);
      mkdirSync(join(w.app, 'releases', name), { recursive: true });
      spawnSync('touch', ['-d', `${i + 1} days ago`, join(w.app, 'releases', name)]);
    }
    mkdirSync(join(w.app, 'releases', 'initial'), { recursive: true });
    mkdirSync(join(w.app, 'releases', 'not-a-release'), { recursive: true });
    const r = run(w, script(w, { shared: [], database: undefined }));
    expect(r.code, r.out).toBe(0);
    const left = readdirSync(join(w.app, 'releases'));
    expect(left).toContain(SHORT);
    expect(left).toContain(old.split('/').pop());
    expect(left).toContain('initial');
    expect(left).toContain('not-a-release');
    expect(left.filter((n) => /^[0-9a-f]{12}$/.test(n)).length).toBeLessThanOrEqual(5);
  });
});

describe('adopting a plain folder', () => {
  const plain = (w: World) => {
    const dir = join(w.home, 'shop');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.js'), 'running now');
    return dir;
  };

  it('without the person’s yes the folder is not touched', () => {
    const w = world();
    const dir = plain(w);
    const r = run(w, script(w, { currentLink: dir, shared: [], database: undefined }));
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('is a plain folder; confirm in the setup');
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(lstatSync(dir).isSymbolicLink()).toBe(false);
    expect(restarts(w)).toEqual([]);
    // a dry run says the same
    const d = run(w, script(w, { currentLink: dir, shared: [], database: undefined }), { AOM_DEPLOY_DRY_RUN: '1' });
    expect(d.code).not.toBe(0);
  });

  it('with it, the folder is moved (not copied or deleted) to releases/initial and a link takes its place; the shared file is copied from it', () => {
    const w = world();
    const dir = plain(w);
    writeFileSync(join(dir, '.env'), 'DB=local\n');
    const r = run(w, script(w, { currentLink: dir, adoptFolder: true, database: undefined }));
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(join(w.app, 'releases', 'initial', 'app.js'), 'utf8')).toBe('running now');
    expect(lstatSync(dir).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dir)).toBe(join(w.app, 'releases', SHORT));
    expect(readFileSync(join(w.app, 'shared', '.env'), 'utf8')).toBe('DB=local\n');
    expect(readFileSync(join(dir, '.env'), 'utf8')).toBe('DB=local\n');
    expect(restarts(w)).toEqual(['shop.service']);
  });

  it('if the new version does not answer the old folder comes back as the link target', () => {
    const w = world();
    const dir = plain(w);
    writeFileSync(join(w.root, 'unhealthy'), '2');
    const r = run(w, script(w, { currentLink: dir, adoptFolder: true, shared: [], database: undefined }));
    expect(r.code).not.toBe(0);
    expect(readlinkSync(dir)).toBe(join(w.app, 'releases', 'initial'));
    expect(readFileSync(join(dir, 'app.js'), 'utf8')).toBe('running now');
  });
});

describe('other managers, and a server over ssh', () => {
  it('a user service uses systemctl --user and never sudo', () => {
    const w = world();
    running(w);
    const r = run(w, script(w, { manager: systemd({ scope: 'user' }), shared: [], database: undefined }));
    expect(r.code, r.out).toBe(0);
    expect(w.calls()).toContain('systemctl --user restart shop.service');
    expect(w.calls().filter((c) => c.startsWith('sudo'))).toEqual([]);
  });

  it('pm2 restarts only the named process', () => {
    const w = world();
    running(w);
    const r = run(w, script(w, { manager: { kind: 'pm2', name: 'shop-api' }, shared: [], database: undefined }));
    expect(r.code, r.out).toBe(0);
    expect(restarts(w)).toEqual(['shop-api']);
    expect(w.calls().filter((c) => c.startsWith('pm2'))).toEqual(['pm2 restart shop-api']);
  });

  it('a command of the person’s own is run as written', () => {
    const w = world();
    running(w);
    const mine = join(w.root, 'bin', 'restart-shop');
    writeFileSync(mine, '#!/bin/bash\necho "restart-shop $*" >> "$FAKE_ROOT/calls.log"\necho mine >> "$FAKE_ROOT/restarts.log"\n');
    chmodSync(mine, 0o755);
    const r = run(w, script(w, { manager: { kind: 'command', restart: [mine, '--quick'], sudo: false }, shared: [], database: undefined }));
    expect(r.code, r.out).toBe(0);
    expect(w.calls()).toContain('restart-shop --quick');
  });

  it('over ssh the same steps run on the server through ssh (scripts travel as an argument, the files as a tar stream)', () => {
    const w = world();
    running(w);
    const r = run(w, script(w, { manager: systemd({ scope: 'user' }), shared: ['.env'], database: undefined }, true));
    expect(r.code, r.out).toBe(0);
    expect(readlinkSync(join(w.app, 'current'))).toBe(join(w.app, 'releases', SHORT));
    expect(readFileSync(join(w.app, 'releases', SHORT, 'server.js'), 'utf8')).toContain('hi');
    expect(w.calls().filter((c) => c.startsWith('ssh ')).length).toBeGreaterThan(5);
    expect(restarts(w)).toEqual(['shop.service']);
  });
});
