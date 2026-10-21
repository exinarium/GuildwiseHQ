import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, DEPLOYER, E2E_DIR, paths, ROOT } from '../support/env.ts';
import { killRunner, pairRunner, startRunner } from '../support/runner.ts';

// Moving to a new server (docs/design/deploy-run-ux-design.md J6, v3) through the web UI against TWO REAL sshd containers acting as
// the old and the new server (apps/runner/test/fixtures/sshd, each with the fake docker of apps/runner/test/fixtures; a real httpd
// answers the health address). The new server is connected with a password in the UI; the old one is reached through an ssh alias in
// a config file of THIS test (the runner's HOME is a temp folder and every ssh call names its own config: nothing of this computer's
// ~/.ssh is read, and the spec refuses to start if the runner could see a real alias). Nothing outside the two containers is touched.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('deploy-move');
const DIR = join(E2E_DIR, 'deploy-move');
const RUNNER_HOME = join(DIR, 'home');
const IMAGE = 'aom-test-sshd:1';
const OLD = `aom-e2e-move-old-${process.pid}`;
const NEW = `aom-e2e-move-new-${process.pid}`;
const ROOT_PASSWORD = 'rootpw-for-tests';
const SECRET = 'e2e-hunter2-secret';
const DNS_FILE = join(E2E_DIR, 'dns.json');

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inOld = (cmd: string) => docker('exec', OLD, 'sh', '-c', cmd);
const inNew = (cmd: string) => docker('exec', NEW, 'sh', '-c', cmd);
const portOf = (name: string) => {
  const m = docker('port', name, '22').split('\n')[0] ?? '';
  return Number(m.slice(m.lastIndexOf(':') + 1));
};

let page: Page;
let api: APIRequestContext;
let projectId: string;
let oldPort = 0;
let newPort = 0;
let newFp = '';
let oldTarget = '';
const dns = (ips: string[]) => writeFileSync(DNS_FILE, JSON.stringify({ 'shop.e2e.test': ips }));

test.beforeAll(async ({ browser }) => {
  try {
    await inviteAndAccept(await apiAs(ADMIN.email, ADMIN.password), DEPLOYER);
  } catch {
    // another spec made this user already
  }
  api = await apiAs(DEPLOYER.email, DEPLOYER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test.afterAll(() => {
  // stop this spec's runner: a runner left behind is another computer of the same person and gets picked by the next spec
  killRunner('SIGTERM', HOME);
  for (const n of [OLD, NEW]) {
    try {
      docker('rm', '-f', n);
    } catch {
      // never started
    }
  }
  rmSync(DIR, { recursive: true, force: true });
  rmSync(DNS_FILE, { force: true });
});

function startBox(name: string): void {
  docker('run', '-d', '--rm', '--name', name, '-p', '127.0.0.1::22', IMAGE);
  docker('cp', join(ROOT, 'apps/runner/test/fixtures/fake-server-docker.sh'), `${name}:/usr/bin/docker`);
  docker(
    'exec',
    name,
    'sh',
    '-c',
    'chmod +x /usr/bin/docker && mkdir -p /var/fakedocker/images && echo 3000 > /var/fakedocker/port',
  );
}

test('setup: two throwaway servers, a runner whose ssh sees only them, an approved guided setup for the old one', async () => {
  docker('build', '-q', '-t', IMAGE, join(ROOT, 'apps/runner/test/fixtures/sshd'));
  startBox(OLD);
  startBox(NEW);
  oldPort = portOf(OLD);
  newPort = portOf(NEW);
  for (const [p, name] of [
    [oldPort, 'old'],
    [newPort, 'new'],
  ] as const)
    await waitFor(
      `${name} sshd answers`,
      async () => {
        try {
          return execFileSync('ssh-keyscan', ['-T', '1', '-p', String(p), '-t', 'ed25519', '127.0.0.1'], {
            encoding: 'utf8',
          }).includes('ssh-ed25519');
        } catch {
          return false;
        }
      },
      (ok) => ok,
      30_000,
    );
  newFp = /(SHA256:\S+)/.exec(inNew('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'))?.[1] as string;
  // the old server is reached by an alias in a config of this test (key only); the runner's HOME is this folder
  mkdirSync(join(RUNNER_HOME, '.ssh'), { recursive: true });
  const key = join(DIR, 'old_key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key, '-C', 'e2e-move'], {
    stdio: 'pipe',
  });
  inOld(
    `mkdir -p /root/.ssh && chmod 700 /root/.ssh && printf '%s\\n' '${readFileSync(`${key}.pub`, 'utf8').trim()}' > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys`,
  );
  const scan = spawnSync('ssh-keyscan', ['-T', '3', '-p', String(oldPort), '-t', 'ed25519', '127.0.0.1'], {
    encoding: 'utf8',
  });
  writeFileSync(join(RUNNER_HOME, '.ssh', 'known_hosts'), scan.stdout);
  writeFileSync(
    join(RUNNER_HOME, '.ssh', 'config'),
    `Host e2e-old\n  HostName 127.0.0.1\n  Port ${oldPort}\n  User root\n  IdentityFile ${key}\n  IdentitiesOnly yes\n  IdentityAgent none\n`,
    { mode: 0o600 },
  );
  chmodSync(join(RUNNER_HOME, '.ssh', 'config'), 0o600);
  // the old server runs the app and the database, with a settings file that holds a secret
  inOld(
    [
      'mkdir -p /opt/shop /var/fakedocker/images',
      "printf 'services:\\n  app:\\n    image: ${SHOP_IMAGE}\\n  postgres:\\n    image: postgres:16\\n' > /opt/shop/docker-compose.yml",
      `printf 'SHOP_IMAGE=shop:e2e123456789\\nDB_PASSWORD=${SECRET}\\n' > /opt/shop/.env && chmod 600 /opt/shop/.env`,
      'touch /var/fakedocker/up-app /var/fakedocker/up-postgres /var/fakedocker/images/shop_e2e123456789',
      "printf 'CREATE TABLE users;\\nCREATE TABLE orders;\\nCREATE TABLE invoices;\\n' > /var/fakedocker/db.sql",
    ].join(' && '),
  );
  dns(['198.51.100.7']);

  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Move PC', HOME);
  startRunner({ AOM_MOCK_STEP_MS: '100', HOME: RUNNER_HOME, SSH_AUTH_SOCK: '' }, HOME);
  await waitFor(
    'runner connected',
    async () =>
      ((await (await api.get('/api/workstations')).json()).workstations as any[]).find(
        (w) => w.name === 'Move PC',
      ),
    (w) => w?.connected === true,
    30_000,
  );
  const proj = await api.post('/api/projects', { data: { key: 'DMV', name: 'Deploy move project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const caps = await q<{ capabilities: string[] }>('SELECT capabilities FROM workstation_capabilities');
  expect(caps.some((c) => c.capabilities.includes('deploy-move:1'))).toBe(true);

  const org = (await q<{ org_id: string }>('SELECT org_id FROM projects WHERE id=$1', [projectId]))[0]
    ?.org_id;
  const ws = (await q<{ id: string }>(`SELECT id FROM workstations WHERE name='Move PC'`))[0]?.id;
  oldTarget = crypto.randomUUID();
  await q(
    `INSERT INTO deploy_targets (id, org_id, project_id, name, kind, workstation_id, host, app_url, production, created_by, created_at, updated_at)
     VALUES ($1,$2,$3,'Live shop','remote_ssh',$4,'e2e-old','https://shop.e2e.test',true,(SELECT id FROM users WHERE email='deployer@e2e.test'),now(),now())`,
    [oldTarget, org, projectId, ws],
  );
  await q(
    `INSERT INTO deploy_target_keys (target_id, workstation_id, project_id, org_id, fingerprint, public_key, alias, method, address, ssh_user, port, state, added_at)
     VALUES ($1,$2,$3,$4,$5,'ssh-ed25519 AAAA existing','e2e-old','alias','198.51.100.7','root',22,'active',now())`,
    [oldTarget, ws, projectId, org, `SHA256:${'A'.repeat(43)}`],
  );
  const setup = {
    version: 1,
    generator: 'setup-1.4',
    environments: [
      {
        name: 'production',
        label: 'Live shop',
        target: 'Live shop',
        mode: 'guided',
        hosting: 'ssh',
        host: 'e2e-old',
        app: {
          composeFile: '/opt/shop/docker-compose.yml',
          service: 'app',
          imageName: 'shop',
          imageVar: 'SHOP_IMAGE',
          imageKeep: 5,
          appUrl: 'https://shop.e2e.test',
        },
        steps: [
          { kind: 'db_backup', service: 'postgres', dir: '/opt/shop/backups', keep: 20 },
          { kind: 'env_backup' },
          { kind: 'build_image_local' },
          { kind: 'ship_image_ssh' },
          { kind: 'set_image_var' },
          { kind: 'compose_up_remote' },
        ],
        health: { kind: 'http', url: '${appUrl}/ready', expect: '2xx', graceSec: 3 },
        healthTimeoutSec: 60,
        rollback: true,
        trigger: ['on_request'],
        releasedBy: 'owner',
        gate: 'none',
        secrets: [],
        timeoutSec: 1800,
      },
    ],
  };
  const vault = `e2e-vault-${projectId.slice(0, 8)}`;
  await q(
    `INSERT INTO delivery_recipes (id, org_id, project_id, vault_id, path, status, present, version, setup, observed_hash, approved_hash, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'projects/dmv/delivery','approved',true,1,$5::jsonb,$6,$6,now(),now())`,
    [crypto.randomUUID(), org, projectId, vault, JSON.stringify(setup), 'a'.repeat(64)],
  );
  await q(`UPDATE projects SET delivery_mode='recipe' WHERE id=$1`, [projectId]);
});

test('Move to a new server: connect the new server with a password; Guildwise looks at it and sets up the folder', async () => {
  await page.goto('/p/DMV/environments');
  await page.getByTestId('env-move-production').click({ timeout: 60_000 });
  await page.getByTestId('move-connect-new').click();
  await page.getByTestId('connect-name').fill('New shop server');
  await page.getByTestId('connect-address').fill('127.0.0.1');
  await page.getByTestId('connect-user').fill('root');
  await page.getByText('The server uses a different port').click();
  await page.getByTestId('connect-port').fill(String(newPort));
  await page.getByTestId('connect-continue').click();
  await expect(page.getByTestId('connect-fp')).toHaveText(newFp, { timeout: 60_000 });
  await page.getByTestId('connect-fp-matches').click();
  await page.getByTestId('connect-password').fill(ROOT_PASSWORD);
  await page.getByTestId('connect-go').click();
  await expect(page.getByTestId('connect-done')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('connect-finish').click();
  const prepare = page.getByTestId('move-prepare');
  await expect(prepare).toBeVisible({ timeout: 30_000 });
  // the same folder as on the old server; nothing to type
  await expect(page.getByTestId('prepare-fixed')).toContainText('/opt/shop', { timeout: 60_000 });
  await page.getByTestId('prepare-run').click();
  await expect(page.getByTestId('prepare-done')).toBeVisible({ timeout: 60_000 });
  expect(inNew('ls -d /opt/shop /opt/shop/backups')).toContain('/opt/shop/backups');
  // not on the old server's account list: only the NEW server got a Guildwise key
  expect(inNew('cat /root/.ssh/authorized_keys')).toContain('guildwise-deploy:');
  expect(inOld('cat /root/.ssh/authorized_keys')).not.toContain('guildwise-deploy:');
});

test('the look and the copy run by themselves; the old site is untouched until the person agrees to the downtime', async () => {
  await page.getByTestId('move-start').click();
  await expect(page.getByTestId('move-ready')).toBeVisible({ timeout: 180_000 });
  // copied byte for byte and private; the old server still runs
  expect(inNew('cat /opt/shop/.env')).toBe(inOld('cat /opt/shop/.env'));
  expect(inNew('stat -c %a /opt/shop/.env').trim()).toBe('600');
  expect(inNew('ls /var/fakedocker/images')).toContain('shop_e2e123456789');
  expect(inOld('ls /var/fakedocker')).toContain('up-app');
  expect(inNew('ls /var/fakedocker')).not.toContain('up-app');
  await expect(page.getByTestId('move-downtime-text')).toContainText('visitors cannot use the site');
  await page.screenshot({ path: join(DIR, 'move-ready.png') }).catch(() => undefined);
});

test('a short downtime: the old app stops, the last backup is saved on the old server, the data and the app move, the new app answers', async () => {
  await page.getByTestId('move-switch').click();
  await expect(page.getByTestId('move-live')).toBeVisible({ timeout: 240_000 });
  expect(inOld('ls /var/fakedocker')).not.toContain('up-app');
  expect(inOld('ls /var/fakedocker')).toContain('up-postgres');
  expect(inOld('ls /opt/shop/backups')).toMatch(/move-\d{8}-\d{6}\.sql\.gz/);
  expect(inNew('cat /var/fakedocker/db.sql')).toContain('CREATE TABLE invoices;');
  // a real httpd on the new server answers the health address
  expect(inNew('wget -q -O - http://127.0.0.1:3000/ready').trim()).toBe('ok');
  // nothing was deleted on the old server
  expect(inOld('cat /opt/shop/.env')).toContain(SECRET);
  expect(inOld('cat /var/fakedocker/db.sql')).toContain('CREATE TABLE users;');
});

test('point the domain: the live check says where it points; the Owner makes the new server live; the names swap', async () => {
  await expect(page.getByTestId('move-dns-address')).toContainText('127.0.0.1');
  await expect(page.getByTestId('move-dns-state')).toHaveText('Still points to the old server', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('move-golive')).toBeDisabled();
  await page.screenshot({ path: join(DIR, 'move-dns.png') }).catch(() => undefined);
  dns(['127.0.0.1']);
  await page.getByTestId('move-dns-again').click();
  await expect(page.getByTestId('move-dns-state')).toHaveText('Points to the new server', {
    timeout: 30_000,
  });
  await page.getByTestId('move-golive').click();
  await page.getByRole('button', { name: 'Make it live' }).click();
  await expect(page.getByTestId('move-done')).toBeVisible({ timeout: 30_000 });
  const rows = await q<any>(
    `SELECT name, role, production, app_url, host FROM deploy_targets WHERE project_id=$1 AND removed_at IS NULL ORDER BY name`,
    [projectId],
  );
  expect(rows.find((r) => r.host === 'e2e-old')).toMatchObject({
    name: 'Live shop (old server)',
    role: 'standby',
  });
  expect(rows.find((r) => r.role === 'active')).toMatchObject({
    name: 'Live shop',
    production: true,
    app_url: 'https://shop.e2e.test',
  });
});

test('the old server is a standby; retire removes Guildwise keys only, and nothing is deleted there', async () => {
  await page.getByTestId('move-close').click();
  const old = page.getByTestId('old-servers');
  await expect(old).toContainText('Standby (fallback)');
  await old.getByRole('button', { name: 'Retire' }).click();
  await expect(page.getByTestId('retire-explainer')).toContainText('never deletes anything');
  await page.getByTestId('retire-confirm').click();
  await waitFor(
    'retired',
    async () => (await q<any>(`SELECT role FROM deploy_targets WHERE id=$1`, [oldTarget]))[0]?.role,
    (r) => r === 'retired',
    60_000,
  );
  await expect(old).toContainText('Retired');
  // the old server keeps everything: its data, its settings, the move's backup, and the person's own key
  expect(inOld('cat /opt/shop/.env')).toContain(SECRET);
  expect(inOld('cat /var/fakedocker/db.sql')).toContain('CREATE TABLE users;');
  expect(inOld('ls /opt/shop/backups')).toMatch(/move-/);
  expect(inOld('cat /root/.ssh/authorized_keys')).toContain('e2e-move');
  // no secret value or private key travelled through the server
  const everything =
    JSON.stringify(await q('SELECT payload FROM events')) +
    JSON.stringify(await q('SELECT payload FROM runner_commands'));
  expect(everything).not.toContain(SECRET);
  expect(everything).not.toContain(ROOT_PASSWORD);
  expect(existsSync(join(RUNNER_HOME, '.ssh', 'config'))).toBe(true);
});
