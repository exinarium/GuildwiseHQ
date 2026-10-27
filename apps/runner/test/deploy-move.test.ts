import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
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
import { gzipSync } from 'node:zlib';
import { type DeployMovePayload, DeployMovePayloadSchema, type MoveSpec } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { DeployKeys } from '../src/delivery/deploy-keys.ts';
import { DeployMover, parseMoveOutput, REVOKE_ALL_SCRIPT } from '../src/delivery/move.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * `deploy.move` against FAKE servers: a fake `ssh` (it only runs the remote command locally, with that server's state folder) and a
 * fake `docker` / `docker compose` / `curl`. The two servers share this computer's file system and have their own Docker state, so
 * these tests cover the Docker side (stop, dump, restore, start, health, undo); the real file copies and the real ssh run in
 * deploy-move.sshd.test.ts against two throwaway sshd containers. No real ssh, no real Docker, no real host is reached: the
 * fake `ssh` is first on PATH and answers every call itself.
 */
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const P = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MOVE = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const T_OLD = '11111111-1111-4111-8111-111111111111';
const T_NEW = '22222222-2222-4222-8222-222222222222';

function rig() {
  const root = tmp('aom-move-');
  const bin = join(root, 'bin');
  const servers = join(root, 'servers');
  mkdirSync(bin, { recursive: true });
  mkdirSync(servers, { recursive: true });
  for (const [from, to] of [
    ['fake-server-ssh.sh', 'ssh'],
    ['fake-server-docker.sh', 'docker'],
    ['fake-curl.sh', 'curl'],
  ] as const) {
    copyFileSync(join(FIX, from), join(bin, to));
    chmodSync(join(bin, to), 0o755);
  }
  const app = join(root, 'shop');
  mkdirSync(app, { recursive: true });
  writeFileSync(
    join(app, 'docker-compose.yml'),
    'services:\n  app:\n    image: ${SHOP_IMAGE}\n  postgres:\n    image: postgres:16\n',
  );
  writeFileSync(join(app, '.env'), 'SHOP_IMAGE=shop:abc123def456\nDB_PASSWORD=hunter2-secret-value\n');
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    SSH_AUTH_SOCK: '',
    FAKE_SERVERS: servers,
  };
  const state = (alias: string) => join(servers, alias);
  const put = (alias: string, file: string, text = '') => {
    mkdirSync(state(alias), { recursive: true });
    writeFileSync(join(state(alias), file), text);
  };
  // the old server runs the app and the database
  put('old-box', 'up-app');
  put('old-box', 'up-postgres');
  put('old-box', 'db.sql', 'CREATE TABLE users;\nCREATE TABLE orders;\nCREATE TABLE sessions;\n');
  mkdirSync(join(state('old-box'), 'images'), { recursive: true });
  writeFileSync(join(state('old-box'), 'images', 'shop_abc123def456'), '');
  mkdirSync(state('new-box'), { recursive: true });
  const keys = new DeployKeys({ dir: join(root, 'keys'), home: root, env });
  const mover = new DeployMover({ keys, env, home: root, connectSec: 2, healthWaitSec: 3 });
  const spec: MoveSpec = {
    from: { targetId: T_OLD, alias: 'old-box' },
    to: { targetId: T_NEW, alias: 'new-box' },
    composeFile: join(app, 'docker-compose.yml'),
    appService: 'app',
    imageVar: 'SHOP_IMAGE',
    imageName: 'shop',
    dbService: 'postgres',
    backupDir: join(root, 'backups'),
    healthPath: '/ready',
  };
  const payload = (step: DeployMovePayload['step'], context: DeployMovePayload['context'] = {}) =>
    DeployMovePayloadSchema.parse({ projectId: P, moveId: MOVE, step, spec, context });
  const run = (step: DeployMovePayload['step'], context: DeployMovePayload['context'] = {}) =>
    mover.run(payload(step, context));
  const exists = (alias: string, f: string) => existsSync(join(state(alias), f));
  const read = (alias: string, f: string) => readFileSync(join(state(alias), f), 'utf8');
  return { root, env, run, put, exists, read, state, spec, app, servers };
}

/** The whole way up to the moment before the switch. */
async function prepared(r: ReturnType<typeof rig>) {
  const check = await r.run('check');
  expect(check, JSON.stringify(check)).toMatchObject({ ok: true });
  for (const step of ['copy_config', 'copy_image', 'start_database'] as const) {
    const out = await r.run(step);
    expect(out, `${step} ${JSON.stringify(out)}`).toMatchObject({ ok: true });
  }
  return check;
}

describe('parseMoveOutput', () => {
  it('reads checks, facts, errors and results', () => {
    const o = parseMoveOutput(
      'AOM_CHECK docker ok Docker works\nAOM_CHECK x bad Not good\nAOM_FACT image shop:1\nAOM_ERR backup_failed pg_dump failed\nAOM_RESULT stopped a b\nnoise\n',
    );
    expect(o.checks).toEqual([
      { id: 'docker', ok: true, text: 'Docker works' },
      { id: 'x', ok: false, text: 'Not good' },
    ]);
    expect(o.facts).toEqual({ image: 'shop:1' });
    expect(o.err).toEqual({ code: 'backup_failed', text: 'pg_dump failed' });
    expect(o.result).toEqual(['stopped', 'a', 'b']);
  });
});

describe('deploy.move on two fake servers', () => {
  it('the whole way: look, copy, start the database, stop and back up, restore, start and check', async () => {
    const r = rig();
    const check = await prepared(r);
    if (!check.ok) return;
    expect(check.facts).toMatchObject({ image: 'shop:abc123def456', appPort: 3000 });
    // nothing changed on the old server so far
    expect(r.exists('old-box', 'up-app')).toBe(true);
    expect(r.exists('new-box', 'images/shop_abc123def456')).toBe(true);
    expect(r.exists('new-box', 'up-postgres')).toBe(true);
    expect(r.exists('new-box', 'up-app')).toBe(false);

    const stopped = await r.run('stop_and_backup');
    expect(stopped, JSON.stringify(stopped)).toMatchObject({ ok: true, oldAppRunning: false });
    if (!stopped.ok) return;
    expect(r.exists('old-box', 'up-app')).toBe(false);
    expect(r.exists('old-box', 'up-postgres')).toBe(true); // the database keeps running
    const backupFile = stopped.facts.backupFile as string;
    expect(backupFile).toMatch(/\/backups\/move-\d{8}-\d{6}\.sql\.gz$/);
    expect(existsSync(backupFile)).toBe(true);
    expect(stopped.facts.tablesOld).toBe(3);

    const restored = await r.run('restore', { backupFile });
    expect(restored, JSON.stringify(restored)).toMatchObject({
      ok: true,
      facts: { tablesNew: 3, tablesOld: 3 },
    });
    expect(r.read('new-box', 'db.sql')).toContain('CREATE TABLE orders;');

    const started = await r.run('start_app', { appPort: 3000 });
    expect(started, JSON.stringify(started)).toMatchObject({ ok: true, facts: { healthy: true } });
    expect(r.exists('new-box', 'up-app')).toBe(true);
    // the old app stays stopped: nothing was deleted there
    expect(r.exists('old-box', 'up-app')).toBe(false);
    expect(r.read('old-box', 'db.sql')).toContain('CREATE TABLE users;');
  });

  it('a settings value is never in an answer, an argument or a log line', async () => {
    const r = rig();
    const results = [await r.run('check')];
    for (const step of ['copy_config', 'copy_image', 'start_database'] as const)
      results.push(await r.run(step));
    expect(JSON.stringify(results)).not.toContain('hunter2');
    // the ssh calls (script and arguments) and the docker calls never carry it either
    const calls = [readFileSync(join(r.servers, 'calls.log'), 'utf8')];
    for (const a of ['old-box', 'new-box']) {
      const f = join(r.state(a), 'calls.log');
      if (existsSync(f)) calls.push(readFileSync(f, 'utf8'));
    }
    expect(calls.join('\n')).not.toContain('hunter2');
  });

  it('never runs down, rm, prune or volume removal on either server', async () => {
    const r = rig();
    await prepared(r);
    const stopped = await r.run('stop_and_backup');
    if (stopped.ok) {
      await r.run('restore', { backupFile: stopped.facts.backupFile as string });
      await r.run('start_app', { appPort: 3000 });
    }
    await r.run('restart_old');
    for (const a of ['old-box', 'new-box']) {
      const f = join(r.state(a), 'calls.log');
      const log = existsSync(f) ? readFileSync(f, 'utf8') : '';
      // the fake logs one line per call: look at the docker verbs, not at option values
      for (const line of log.split('\n').filter(Boolean)) {
        expect(line, `${a}: ${line}`).not.toMatch(
          /^docker (compose .*)?(down|prune|rm|rmi|kill|volume rm|system prune)\b|--volumes|--remove-orphans/,
        );
        expect(line, `${a}: ${line}`).not.toMatch(/ (down|rm|kill|prune)( |$)/);
      }
    }
  });

  it('look: a server that is not reachable, a missing settings file, a stopped database are said in words', async () => {
    const r = rig();
    writeFileSync(join(r.servers, 'down-new-box'), '');
    expect(await r.run('check')).toMatchObject({ ok: false, error: 'new_unreachable' });
    const r2 = rig();
    writeFileSync(join(r2.servers, 'down-old-box'), '');
    expect(await r2.run('check')).toMatchObject({ ok: false, error: 'old_unreachable' });
    const r3 = rig();
    writeFileSync(join(r3.app, '.env'), '');
    const noImage = await r3.run('check');
    expect(noImage.ok).toBe(false);
    expect(noImage.checks.map((c) => c.text).join(' ')).toContain('which version of the app');
    const r4 = rig();
    writeFileSync(join(r4.app, 'docker-compose.yml'), 'x');
    r4.put('old-box', 'up-postgres', '');
    expect((await r4.run('check')).ok).toBe(true);
    const r5 = rig();
    r5.put('old-box', 'x');
    rmFile(join(r5.state('old-box'), 'up-postgres'));
    const noDb = await r5.run('check');
    expect(noDb.ok).toBe(false);
    expect(noDb.checks.find((c) => !c.ok)?.text).toContain('database');
    const r6 = rig();
    r6.put('new-box', 'up-app');
    const notNew = await r6.run('check');
    expect(notNew.ok).toBe(false);
    expect(notNew.checks.find((c) => !c.ok)?.text).toContain('already runs this app');
  });

  it('the image is copied once: a second run finds it there', async () => {
    const r = rig();
    await r.run('check');
    expect(await r.run('copy_image')).toMatchObject({ ok: true });
    expect(await r.run('copy_image')).toMatchObject({ ok: true, skipped: true });
  });

  it('a failed backup starts the old app again and changes nothing else', async () => {
    const r = rig();
    await prepared(r);
    r.put('old-box', 'fail-dump');
    const out = await r.run('stop_and_backup');
    expect(out).toMatchObject({ ok: false, error: 'backup_failed', oldAppRunning: true });
    expect(r.exists('old-box', 'up-app')).toBe(true);
  });

  it('a failed restore applies nothing, starts the old app again and says so', async () => {
    const r = rig();
    await prepared(r);
    const stopped = await r.run('stop_and_backup');
    if (!stopped.ok) throw new Error('backup');
    r.put('new-box', 'fail-restore');
    const out = await r.run('restore', { backupFile: stopped.facts.backupFile as string });
    expect(out).toMatchObject({ ok: false, error: 'restore_failed', oldAppRunning: true });
    expect(r.exists('new-box', 'db.sql')).toBe(false);
    expect(r.exists('old-box', 'up-app')).toBe(true);
  });

  /** The last backup on the old server replaced by `content` (gzip'd here), as a stream or a file cut short would deliver it. */
  const replaceBackup = (file: string, content: Buffer | string, raw = false) =>
    writeFileSync(file, raw ? (content as Buffer) : gzipSync(content));
  const BODY =
    '-- PostgreSQL database dump\nCREATE TABLE users;\nCREATE TABLE orders;\nCREATE TABLE sessions;\n';

  it('a dump cut at a statement boundary (valid gzip, no trailer) is refused before anything is applied', async () => {
    const r = rig();
    await prepared(r);
    const stopped = await r.run('stop_and_backup');
    if (!stopped.ok) throw new Error('backup');
    const file = stopped.facts.backupFile as string;
    replaceBackup(file, `${BODY}-- padding\n`.repeat(20)); // ends cleanly after a statement, but is not a finished dump
    const out = await r.run('restore', { backupFile: file });
    expect(out).toMatchObject({ ok: false, error: 'restore_failed', oldAppRunning: true });
    expect(out.ok ? '' : out.detail).toContain('incomplete');
    expect(r.exists('new-box', 'db.sql')).toBe(false); // psql never ran
    expect(readFileSync(join(r.state('new-box'), 'calls.log'), 'utf8')).not.toContain('--single-transaction');
    expect(r.exists('old-box', 'up-app')).toBe(true);
    expect(
      readdirSync(r.app).filter((n) => n.startsWith('.aom-restore') || n.startsWith('.guildwise-restore')),
    ).toEqual([]); // the temporary file is gone
  });

  it('a gzip stream cut in the middle is refused too', async () => {
    const r = rig();
    await prepared(r);
    const stopped = await r.run('stop_and_backup');
    if (!stopped.ok) throw new Error('backup');
    const file = stopped.facts.backupFile as string;
    const whole = readFileSync(file);
    replaceBackup(file, whole.subarray(0, whole.length - 30), true);
    const out = await r.run('restore', { backupFile: file });
    expect(out).toMatchObject({ ok: false, error: 'restore_failed', oldAppRunning: true });
    expect(r.exists('new-box', 'db.sql')).toBe(false);
  });

  it('a database that cannot be asked is an error, not an empty database', async () => {
    const r = rig();
    await prepared(r);
    const stopped = await r.run('stop_and_backup');
    if (!stopped.ok) throw new Error('backup');
    r.put('new-box', 'fail-count');
    const out = await r.run('restore', { backupFile: stopped.facts.backupFile as string });
    expect(out).toMatchObject({ ok: false, error: 'database_not_ready', oldAppRunning: true });
    expect(r.exists('new-box', 'db.sql')).toBe(false);
  });

  it('counts the tables of every schema but the system ones', async () => {
    const r = rig();
    await prepared(r);
    await r.run('stop_and_backup');
    const log = readFileSync(join(r.state('old-box'), 'calls.log'), 'utf8');
    expect(log).toContain("table_schema not in ('pg_catalog','information_schema')");
    expect(log).not.toContain("table_schema='public'");
  });

  it('a count that cannot be read after the restore is a failure, said as such (the data is there, unverified)', async () => {
    const r = rig();
    await prepared(r);
    const stopped = await r.run('stop_and_backup');
    if (!stopped.ok) throw new Error('backup');
    r.put('old-box', 'fail-count'); // the old database cannot be counted for the comparison
    const out = await r.run('restore', { backupFile: stopped.facts.backupFile as string });
    expect(out).toMatchObject({ ok: false, error: 'restore_failed', oldAppRunning: false });
    expect(out.ok ? '' : out.detail).toContain('could not be counted');
  });

  it('a database on the new server that has data is never restored over', async () => {
    const r = rig();
    await prepared(r);
    r.put('new-box', 'db.sql', 'CREATE TABLE something;\n');
    const stopped = await r.run('stop_and_backup');
    if (!stopped.ok) throw new Error('backup');
    const out = await r.run('restore', { backupFile: stopped.facts.backupFile as string });
    expect(out).toMatchObject({ ok: false, error: 'new_database_not_empty', oldAppRunning: true });
    expect(r.read('new-box', 'db.sql')).toBe('CREATE TABLE something;\n');
    expect(r.exists('old-box', 'up-app')).toBe(true);
  });

  it('an app that does not answer is stopped on the new server; the old one stays stopped until the person decides', async () => {
    const r = rig();
    await prepared(r);
    const stopped = await r.run('stop_and_backup');
    if (!stopped.ok) throw new Error('backup');
    await r.run('restore', { backupFile: stopped.facts.backupFile as string });
    r.put('new-box', 'unhealthy');
    const out = await r.run('start_app', { appPort: 3000 });
    expect(out).toMatchObject({ ok: false, error: 'app_not_healthy', oldAppRunning: false });
    expect(r.exists('new-box', 'up-app')).toBe(false);
    expect(r.exists('old-box', 'up-app')).toBe(false);
    // ... and going back starts the old app, with the new one stopped
    expect(await r.run('restart_old')).toMatchObject({ ok: true, oldAppRunning: true });
    expect(r.exists('old-box', 'up-app')).toBe(true);
    expect(r.exists('new-box', 'up-app')).toBe(false);
  });

  it('a restore without a backup file is refused', async () => {
    const r = rig();
    expect(await r.run('restore')).toMatchObject({ ok: false, error: 'bad_request' });
  });
});

function rmFile(f: string) {
  rmSync(f, { force: true });
}

describe('retire: removing the keys Guildwise added (the script runs here, in a temp HOME)', () => {
  const KEY =
    'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuildwiseKeyGuildwiseKeyGuildwiseKeyGuildwiseK guildwise-deploy:abc:Laptop';
  const OTHER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPersonOwnKeyPersonOwnKeyPersonOwnKeyPers person@home';
  it('every Guildwise key goes, the person’s own stay, the mode is kept, a dated copy is made, a second run changes nothing', () => {
    const home = tmp('aom-retire-');
    mkdirSync(join(home, '.ssh'));
    const f = join(home, '.ssh', 'authorized_keys');
    writeFileSync(f, `${OTHER}\n${KEY}\n`);
    chmodSync(f, 0o640);
    const run = () =>
      spawnSync('sh', ['-c', REVOKE_ALL_SCRIPT, 'aom-remote', 'guildwise-deploy:'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', HOME: home },
      });
    expect(run().stdout).toMatch(/AOM_RESULT 1 /);
    expect(readFileSync(f, 'utf8')).toBe(`${OTHER}\n`);
    expect((statSync(f).mode & 0o777).toString(8)).toBe('640');
    expect(readdirSync(join(home, '.ssh')).filter((n) => n.includes('aom-tmp'))).toEqual([]);
    expect(readdirSync(join(home, '.ssh')).some((n) => n.startsWith('authorized_keys.guildwise-bak-'))).toBe(
      true,
    );
    expect(run().stdout).toContain('AOM_RESULT 0');
  });
});
