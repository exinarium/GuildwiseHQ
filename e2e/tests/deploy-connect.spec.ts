import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, DEPLOYER, E2E_DIR, paths, ROOT } from '../support/env.ts';
import { killRunner, pairRunner, startRunner } from '../support/runner.ts';

// Guided connect (docs/design/deploy-run-ux-design.md v2) against a REAL sshd: a throwaway container acting as the customer's
// VPS (apps/runner/test/fixtures/sshd). Through the web UI: the fingerprint is shown and confirmed, a password is typed once and
// used to append Guildwise's own key (the password is nowhere afterwards), the server is looked at and the "set it up" list is
// tried without changing anything, then the key stops working, the card says so, and Reconnect with a pasted key fixes it.
// Standalone: the deploy user, its own runner (mock runtime) and project DCN. Nothing outside the throwaway container is touched.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('deploy-connect');
const PASSWORD = 'deploypw-for-tests';
const IMAGE = 'aom-test-sshd:1';
const NAME = `aom-e2e-sshd-${process.pid}`;
const DIR = join(E2E_DIR, 'deploy-connect');

const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inBox = (cmd: string) => docker('exec', NAME, 'sh', '-c', cmd);

let page: Page;
let api: APIRequestContext;
let projectId: string;
let sshPort = 0;
let fingerprint = '';

test.beforeAll(async ({ browser }) => {
  try {
    await inviteAndAccept(await apiAs(ADMIN.email, ADMIN.password), DEPLOYER);
  } catch {
    // the deploy-setup spec made this user already
  }
  api = await apiAs(DEPLOYER.email, DEPLOYER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test.afterAll(() => {
  // stop this spec's runner: a runner left behind is another computer of the same person and gets picked by the next spec
  killRunner('SIGTERM', HOME);
  try {
    docker('rm', '-f', NAME);
  } catch {
    // never started
  }
  rmSync(DIR, { recursive: true, force: true });
});

test('setup: a throwaway sshd container, a paired runner that can connect, and a project', async () => {
  docker('build', '-q', '-t', IMAGE, join(ROOT, 'apps/runner/test/fixtures/sshd'));
  docker('run', '-d', '--rm', '--name', NAME, '-p', '127.0.0.1::22', IMAGE);
  const mapped = docker('port', NAME, '22').split('\n')[0] ?? '';
  sshPort = Number(mapped.slice(mapped.lastIndexOf(':') + 1));
  fingerprint = /(SHA256:\S+)/.exec(inBox('ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'))?.[1] as string;
  expect(fingerprint).toMatch(/^SHA256:/);
  await waitFor(
    'sshd answers',
    async () => {
      try {
        return execFileSync('ssh-keyscan', ['-T', '1', '-p', String(sshPort), '-t', 'ed25519', '127.0.0.1'], {
          encoding: 'utf8',
        }).includes('ssh-ed25519');
      } catch {
        return false;
      }
    },
    (ok) => ok,
    30_000,
  );
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Connect PC', HOME);
  // HOME is an empty folder: the runner reads ssh aliases from it, so no real server of this computer is ever looked at
  mkdirSync(join(DIR, 'home'), { recursive: true });
  startRunner({ AOM_MOCK_STEP_MS: '100', HOME: join(DIR, 'home') }, HOME);
  await waitFor(
    'runner connected',
    async () =>
      ((await (await api.get('/api/workstations')).json()).workstations as any[]).find(
        (w) => w.name === 'Connect PC',
      ),
    (w) => w?.connected === true,
    30_000,
  );
  const proj = await api.post('/api/projects', { data: { key: 'DCN', name: 'Deploy connect project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const caps = await q<{ capabilities: string[] }>('SELECT capabilities FROM workstation_capabilities');
  expect(caps.some((c) => c.capabilities.includes('deploy-connect:1'))).toBe(true);
});

test('Connect a different server: the fingerprint is shown in plain words and must be confirmed; then the password is typed once', async () => {
  await page.goto('/p/DCN/environments');
  await page.getByTestId('setup-add').first().click();
  await page.getByTestId('role-live').click();
  await page.getByTestId('choose-add-server').click();
  await page.getByTestId('connect-different').click({ timeout: 60_000 });
  await page.getByTestId('connect-name').fill('Shop server');
  await page.getByTestId('connect-address').fill('127.0.0.1');
  await page.getByTestId('connect-user').fill('deploy');
  await page.getByText('The server uses a different port').click();
  await page.getByTestId('connect-port').fill(String(sshPort));
  await page.getByTestId('connect-continue').click();
  // what the server really says
  await expect(page.getByTestId('connect-fp')).toHaveText(fingerprint, { timeout: 60_000 });
  await expect(page.getByTestId('connect-fingerprint')).toContainText(
    'If your hosting company shows a fingerprint',
  );
  // nothing was written on the computer or the server yet
  expect(existsSync(join(HOME, 'keys', 'deploy'))).toBe(false);
  await page.getByTestId('connect-fp-matches').click();
  await expect(page.getByTestId('connect-password-promise')).toContainText('Guildwise never stores it');
  await page.getByTestId('connect-password').fill(PASSWORD);
  await page.screenshot({ path: join(DIR, 'connect-password.png') }).catch(() => undefined);
  await page.getByTestId('connect-go').click();
  await expect(page.getByTestId('connect-done')).toContainText('can sign in to 127.0.0.1', {
    timeout: 90_000,
  });
});

test('the key is on the server, the private half and the password are not anywhere they should not be', async () => {
  const ak = inBox('cat /home/deploy/.ssh/authorized_keys');
  expect(ak).toMatch(/^ssh-ed25519 \S+ guildwise-deploy:[0-9a-f]{8}:Connect-PC$/m);
  const target = (
    await q<{ id: string; host: string; kind: string; workstation_id: string }>(
      `SELECT id, host, kind, workstation_id FROM deploy_targets WHERE project_id=$1 AND removed_at IS NULL`,
      [projectId],
    )
  )[0];
  expect(target).toMatchObject({ host: 'aom-shop-server', kind: 'remote_ssh' });
  const keys = await q<any>('SELECT * FROM deploy_target_keys WHERE project_id=$1', [projectId]);
  expect(keys).toHaveLength(1);
  expect(keys[0]).toMatchObject({
    state: 'active',
    method: 'password',
    address: '127.0.0.1',
    ssh_user: 'deploy',
  });
  expect(ak).toContain(keys[0].public_key.split(' ')[1]);
  const conn = (
    await q<any>('SELECT state, method FROM deploy_target_connections WHERE target_id=$1', [target?.id])
  )[0];
  expect(conn).toMatchObject({ state: 'reachable', method: 'deploy_key' });
  // the runner holds the private key (0600); the server and the logs never saw it or the password
  const keyDir = join(HOME, 'keys', 'deploy', target?.id as string);
  expect(readdirSync(keyDir).sort()).toEqual([
    'id_ed25519',
    'id_ed25519.pub',
    'known_hosts',
    'meta.json',
    'ssh_config',
  ]);
  const priv = readFileSync(join(keyDir, 'id_ed25519'), 'utf8');
  const everything =
    JSON.stringify(await q('SELECT payload FROM events')) +
    JSON.stringify(await q('SELECT payload FROM runner_commands'));
  expect(everything).not.toContain(PASSWORD);
  expect(everything).not.toContain(priv.split('\n')[1] as string);
  expect(everything).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  // the person's own ssh folder on this computer was not touched
  expect(readFileSync(join(HOME, 'keys', 'deploy', target?.id as string, 'ssh_config'), 'utf8')).toContain(
    'IdentitiesOnly yes',
  );
});

test('the new server is looked at; "Set up this server" lists what it would add and tries it without changing anything', async () => {
  await page.getByTestId('connect-finish').click();
  // the new server is a place of its own now, looked at once; then it is chosen for the environment being added
  await expect(page.getByTestId('server-look')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('no-stacks')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('server-done').click();
  await expect(page.getByTestId('no-stacks')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('new-copy').click();
  const prepare = page.getByTestId('prepare-server');
  await expect(prepare).toBeVisible({ timeout: 60_000 });
  await expect(prepare.getByTestId('prepare-actions')).toContainText('Install Docker on the server');
  await prepare.getByTestId('prepare-dir').fill('/home/deploy/apps/shop');
  await prepare.getByTestId('prepare-dry').click();
  await expect(prepare.getByTestId('prepare-result')).toContainText('Would do', { timeout: 60_000 });
  expect(inBox('ls /home/deploy')).not.toContain('apps');
  // for real: the folder is made, Docker is not guessed at on a system Guildwise does not install it on
  await prepare.getByTestId('prepare-run').click();
  await expect(prepare.getByTestId('prepare-error')).toContainText('Debian and Ubuntu only', {
    timeout: 60_000,
  });
});

test('the key stops working: the card says so, Reconnect with a pasted key brings it back', async () => {
  inBox('rm -f /home/deploy/.ssh/authorized_keys');
  await page.goto('/p/DCN/environments#places');
  await page.reload(); // a hash change alone does not reload the page, and the dialog of the last test is still open
  const card = page.getByTestId('place-Shop server');
  await expect(card).toBeVisible();
  // one check a minute per server: press again until the server has looked
  await expect(async () => {
    await card
      .getByTestId('place-check-Shop server')
      .click({ timeout: 3_000 })
      .catch(() => undefined);
    await expect(card.getByTestId('reachability-state')).toHaveText('Needs a sign-in', { timeout: 5_000 });
  }).toPass({ timeout: 120_000, intervals: [5_000] });
  await card.getByTestId('place-reconnect-Shop server').click();
  await page.getByTestId('connect-method-panel').click();
  await page.getByTestId('connect-continue').click();
  await page.getByTestId('connect-fp-matches').click({ timeout: 60_000 });
  const pub = (
    await page.getByTestId('connect-public-key').textContent({ timeout: 60_000 })
  )?.trim() as string;
  expect(pub).toMatch(/^ssh-ed25519 \S+ guildwise-deploy:/);
  // before it is pasted the test says so in plain words
  await page.getByTestId('connect-go').click();
  await expect(page.getByTestId('connect-error')).toContainText('does not accept the Guildwise key yet', {
    timeout: 60_000,
  });
  // the person pastes it into the panel
  inBox(
    `mkdir -p /home/deploy/.ssh && printf '%s\\n' '${pub}' > /home/deploy/.ssh/authorized_keys && chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh && chmod 600 /home/deploy/.ssh/authorized_keys`,
  );
  await page.getByTestId('connect-go').click();
  await expect(page.getByTestId('connect-done')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('connect-finish').click();
  await expect(async () => {
    await card
      .getByTestId('place-check-Shop server')
      .click({ timeout: 3_000 })
      .catch(() => undefined);
    await expect(card.getByTestId('reachability-state')).toHaveText('Can sign in', { timeout: 5_000 });
  }).toPass({ timeout: 120_000, intervals: [5_000] });
});
