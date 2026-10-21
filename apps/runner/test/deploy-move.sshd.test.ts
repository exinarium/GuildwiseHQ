import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DeployMovePayload, DeployMovePayloadSchema, type MoveSpec } from '@aom/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeployKeys } from '../src/delivery/deploy-keys.ts';
import { DeployMover } from '../src/delivery/move.ts';
import { type Sshd, sshdAvailable, startSshd } from './helpers/sshd.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

/**
 * `deploy.move` between TWO throwaway sshd containers acting as the old and the new server (apps/runner/test/fixtures/sshd), with a
 * fake `docker` installed in each (fixtures/fake-server-docker.sh: a real busybox httpd answers the health address). A real `ssh`
 * carries the settings file, the image and the database backup from the old container to the new one through this test (the
 * "workstation"), exactly as in production. Hermetic: ssh runs with `-F` an explicit temp config and an explicit known_hosts, the agent
 * is off, and only the 127.0.0.1 ports of the two containers are used; the test checks that the real ~/.ssh did not change. Skipped
 * when Docker is not usable.
 */
const can = sshdAvailable();
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const P = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const MOVE = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const T_OLD = '11111111-1111-4111-8111-111111111111';
const T_NEW = '22222222-2222-4222-8222-222222222222';
const SECRET = 'hunter2-very-secret-value';

let oldBox: Sshd | undefined;
let newBox: Sshd | undefined;
const realSsh = join(homedir(), '.ssh');
const snapshot = () =>
  existsSync(realSsh)
    ? readdirSync(realSsh)
        .sort()
        .map((f) => `${f}:${statSync(join(realSsh, f)).mtimeMs}:${statSync(join(realSsh, f)).size}`)
    : [];
let realBefore: string[] = [];

const root = tmp('aom-move-sshd-');
const home = join(root, 'home');
const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, SSH_AUTH_SOCK: '' };

function installFake(box: Sshd) {
  execFileSync('docker', ['cp', join(FIX, 'fake-server-docker.sh'), `${box.name}:/usr/bin/docker`], {
    stdio: 'pipe',
  });
  box.sh('chmod +x /usr/bin/docker && mkdir -p /var/fakedocker/images && echo 3000 > /var/fakedocker/port');
  box.sh('mkdir -p /root/.ssh && chmod 700 /root/.ssh');
}

beforeAll(() => {
  if (!can) return;
  realBefore = snapshot();
  try {
    oldBox = startSshd();
    newBox = startSshd();
  } catch (err) {
    console.warn(`sshd test containers not available: ${String(err).slice(0, 200)}`);
    oldBox?.stop();
    newBox?.stop();
    oldBox = undefined;
    newBox = undefined;
    return;
  }
  mkdirSync(join(home, '.ssh'), { recursive: true });
  const key = join(root, 'test_key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key, '-C', 'move-test'], {
    stdio: 'pipe',
  });
  const pub = readFileSync(`${key}.pub`, 'utf8').trim();
  const hosts: string[] = [];
  let config = '';
  for (const [alias, box] of [
    ['move-old', oldBox],
    ['move-new', newBox],
  ] as const) {
    installFake(box);
    box.sh(`printf '%s\\n' '${pub}' > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`);
    const scan = spawnSync('ssh-keyscan', ['-T', '3', '-p', String(box.port), '-t', 'ed25519', '127.0.0.1'], {
      encoding: 'utf8',
    });
    hosts.push(scan.stdout.trim());
    config += `Host ${alias}\n  HostName 127.0.0.1\n  Port ${box.port}\n  User root\n  IdentityFile ${key}\n  IdentitiesOnly yes\n  IdentityAgent none\n`;
  }
  // both containers answer on 127.0.0.1 with their own port: known_hosts names `[127.0.0.1]:port`
  writeFileSync(join(home, '.ssh', 'config'), config, { mode: 0o600 });
  writeFileSync(join(home, '.ssh', 'known_hosts'), `${hosts.join('\n')}\n`);
  chmodSync(join(home, '.ssh', 'config'), 0o600);
}, 240_000);

afterAll(() => {
  oldBox?.stop();
  newBox?.stop();
  // the person's real ssh folder was not touched by any of this
  if (can) expect(snapshot()).toEqual(realBefore);
});

const ti = (name: string, fn: () => Promise<void>, timeout = 120_000) =>
  it(
    name,
    async (ctx) => {
      if (!oldBox || !newBox) return ctx.skip();
      await fn();
    },
    timeout,
  );

const userConfig = () => join(home, '.ssh', 'config');
const mover = () =>
  new DeployMover({
    keys: new DeployKeys({ dir: join(root, 'keys'), home, userConfig: userConfig(), env }),
    env,
    home,
    userSshConfig: userConfig(),
    connectSec: 5,
    healthWaitSec: 20,
  });
const spec: MoveSpec = {
  from: { targetId: T_OLD, alias: 'move-old' },
  to: { targetId: T_NEW, alias: 'move-new' },
  composeFile: '/opt/shop/docker-compose.yml',
  appService: 'app',
  imageVar: 'SHOP_IMAGE',
  imageName: 'shop',
  dbService: 'postgres',
  backupDir: '/opt/shop/backups',
  healthPath: '/ready',
};
const step = (s: DeployMovePayload['step'], context: DeployMovePayload['context'] = {}) =>
  mover().run(DeployMovePayloadSchema.parse({ projectId: P, moveId: MOVE, step: s, spec, context }));

/** The old server: a compose folder with two settings files, a running app and database, and three tables. */
function seedOld(box: Sshd) {
  const lines = [
    'rm -rf /opt/shop /var/fakedocker && mkdir -p /opt/shop /var/fakedocker/images && echo 3000 > /var/fakedocker/port',
    "printf 'services:\\n  app:\\n    image: ${SHOP_IMAGE}\\n    env_file: app.env\\n  postgres:\\n    image: postgres:16\\n' > /opt/shop/docker-compose.yml",
    `printf 'SHOP_IMAGE=shop:abc123def456\\nDB_PASSWORD=${SECRET}\\n' > /opt/shop/.env && chmod 600 /opt/shop/.env`,
    `printf 'API_TOKEN=${SECRET}-token\\n' > /opt/shop/app.env && chmod 600 /opt/shop/app.env`,
    'touch /var/fakedocker/up-app /var/fakedocker/up-postgres /var/fakedocker/images/shop_abc123def456',
    "printf 'CREATE TABLE users;\\nCREATE TABLE orders;\\nCREATE TABLE sessions;\\n' > /var/fakedocker/db.sql",
  ];
  box.sh(lines.join(' && '));
}
const resetNew = (box: Sshd) =>
  box.sh(
    'pkill httpd; rm -rf /opt/shop /var/fakedocker && mkdir -p /var/fakedocker/images && echo 3000 > /var/fakedocker/port; true',
  );

describe.skipIf(!can)('deploy.move between two real sshd containers', () => {
  ti(
    'copies the settings and the image, restores the data, starts the app, and the new server really answers',
    async () => {
      const o = oldBox as Sshd;
      const n = newBox as Sshd;
      seedOld(o);
      resetNew(n);
      const all: unknown[] = [];
      const must = async (s: DeployMovePayload['step'], ctx: DeployMovePayload['context'] = {}) => {
        const out = await step(s, ctx);
        all.push(out);
        expect(out, `${s}: ${JSON.stringify(out)}`).toMatchObject({ ok: true });
        return out;
      };
      const check = await must('check');
      expect(check.checks.filter((c) => !c.ok)).toEqual([]);
      expect(check.facts).toMatchObject({ image: 'shop:abc123def456', appPort: 3000 });
      await must('copy_config');
      // byte for byte, private, nothing shown
      for (const f of ['docker-compose.yml', '.env', 'app.env'])
        expect(n.sh(`cat /opt/shop/${f}`)).toBe(o.sh(`cat /opt/shop/${f}`));
      expect(
        n.sh('stat -c %a /opt/shop/.env /opt/shop/app.env /opt/shop/docker-compose.yml').trim().split('\n'),
      ).toEqual(['600', '600', '644']);
      await must('copy_image');
      expect(n.sh('ls /var/fakedocker/images')).toContain('shop_abc123def456');
      await must('start_database');
      expect(n.sh('ls /var/fakedocker')).toContain('up-postgres');
      // the old server is untouched so far
      expect(o.sh('ls /var/fakedocker')).toContain('up-app');
      const stopped = await must('stop_and_backup');
      if (!stopped.ok) return;
      expect(o.sh('ls /var/fakedocker')).not.toContain('up-app');
      expect(o.sh('ls /var/fakedocker')).toContain('up-postgres');
      const file = stopped.facts.backupFile as string;
      expect(o.sh(`ls ${file}`)).toContain('move-');
      const restored = await must('restore', { backupFile: file });
      expect(restored.facts).toMatchObject({ tablesOld: 3, tablesNew: 3 });
      expect(n.sh('cat /var/fakedocker/db.sql')).toContain('CREATE TABLE orders;');
      const started = await must('start_app', { appPort: 3000 });
      expect(started.facts.healthy).toBe(true);
      // a real busybox httpd on the new server answers /ready
      expect(n.sh('wget -q -O - http://127.0.0.1:3000/ready').trim()).toBe('ok');
      // nothing was deleted on the old server
      expect(o.sh('cat /opt/shop/.env')).toContain(SECRET);
      expect(o.sh('cat /var/fakedocker/db.sql')).toContain('CREATE TABLE users;');
      // the secret value is in no answer
      expect(JSON.stringify(all)).not.toContain(SECRET);
    },
    300_000,
  );

  ti('a different settings file on the new server is never overwritten', async () => {
    const o = oldBox as Sshd;
    const n = newBox as Sshd;
    seedOld(o);
    resetNew(n);
    n.sh("mkdir -p /opt/shop && printf 'SHOP_IMAGE=other\\nDB_PASSWORD=mine\\n' > /opt/shop/.env");
    const out = await step('copy_config');
    expect(out).toMatchObject({ ok: false, error: 'config_differs' });
    expect(n.sh('cat /opt/shop/.env')).toContain('DB_PASSWORD=mine');
    // with the other file out of the way, it is copied, and a second copy finds it identical
    n.sh('rm /opt/shop/.env');
    expect(await step('copy_config')).toMatchObject({ ok: true });
    expect(await step('copy_config')).toMatchObject({ ok: true, skipped: true });
  });

  ti('a backup that cannot be made starts the old app again', async () => {
    const o = oldBox as Sshd;
    const n = newBox as Sshd;
    seedOld(o);
    resetNew(n);
    o.sh('touch /var/fakedocker/fail-dump');
    const out = await step('stop_and_backup');
    expect(out).toMatchObject({ ok: false, error: 'backup_failed', oldAppRunning: true });
    expect(o.sh('ls /var/fakedocker')).toContain('up-app');
  });

  ti('retire removes the keys Guildwise added and nothing else; the data stays', async () => {
    const o = oldBox as Sshd;
    seedOld(o);
    o.sh(
      [
        "printf '%s\\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGuildwiseKeyGuildwiseKeyGuildwiseKeyGuildwiseK guildwise-deploy:abc12345:Old-laptop' >> /root/.ssh/authorized_keys",
        "printf '%s\\n' 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPersonOwnKeyPersonOwnKeyPersonOwnKeyPers person@home' >> /root/.ssh/authorized_keys",
      ].join(' && '),
    );
    const out = await step('retire_keys');
    expect(out, JSON.stringify(out)).toMatchObject({ ok: true, facts: { removedKeys: 1 } });
    const left = o.sh('cat /root/.ssh/authorized_keys');
    expect(left).not.toContain('guildwise-deploy:');
    expect(left).toContain('person@home');
    expect(left).toContain('move-test');
    expect(o.sh('ls /root/.ssh')).toContain('authorized_keys.guildwise-bak-');
    expect(o.sh('cat /opt/shop/.env')).toContain(SECRET);
    expect(await step('retire_keys')).toMatchObject({ ok: true, facts: { removedKeys: 0 } });
  });
});
