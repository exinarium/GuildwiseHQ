import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, E2E_DIR, paths } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';

// Storage connections (Organization settings > Storage): an Owner adds a local folder on their own workstation, connects
// it, tests it, renames and removes it. The folder path is sealed in the browser for the workstation and the runner keeps
// it in its sealed secrets/storage.json; the server only knows the name, the type and the health. Standalone: one user,
// one mock runner. No cloud storage is contacted.
test.describe.configure({ mode: 'serial' });

const STORER = { email: 'storer@e2e.test', name: 'E2E Storer', password: 'storer-password-12345' };
const HOME = paths.runnerHome('storage');
const FOLDER = join(E2E_DIR, 'storage-local');
const LABEL = 'Client documents';
const RENAMED = 'Client files (NAS)';
const SETTINGS = '/settings/org?tab=storage';

let page: Page;
let api: APIRequestContext;
let workstationId: string;
let connectionId: string;

const connections = async () =>
  (await (await api.get('/api/org/storage/connections')).json()).connections as Array<{
    id: string;
    label: string;
    kind: string;
    health: { state: string; errorCode?: string };
  }>;

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, STORER);
  api = await apiAs(STORER.email, STORER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  // Global setup may pin the server's test clock hours ahead (a run between 22:00 and 08:30 UTC), while the runner checks
  // the sealed values' expiry against the workstation's real clock. Seal with the real time, as a live server would give.
  await page.route('**/api/workstations/*/integrations', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (typeof body?.serverTime === 'string') body.serverTime = new Date().toISOString();
    await route.fulfill({ response: res, json: body });
  });
  mkdirSync(FOLDER, { recursive: true });
});

test('setup: a paired mock runner that announces storage', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Office PC', HOME);
  startRunner({}, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id;
  await waitFor(
    'the workstation announced storage:1',
    () =>
      q<{ capabilities: string[] }>(
        'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
        [workstationId],
      ),
    (rows) => rows.some((r) => r.capabilities.includes('storage:1')),
    30_000,
  );
});

test('an empty Storage tab explains that files go to your own storage', async () => {
  await page.goto(SETTINGS);
  await expect(page.getByTestId('storage-tab')).toBeVisible();
  await expect(page.getByText('No storage connected yet')).toBeVisible();
  await expect(page.getByTestId('storage-new')).toBeEnabled();
});

test('add a local folder connection and connect it: the row shows Connected', async () => {
  await page.getByTestId('storage-new').click();
  const add = page.getByTestId('storage-add-dialog');
  await add.getByLabel('Type').selectOption('local');
  await add.getByLabel('Display name').fill(LABEL);
  await expect(add.getByLabel('Workstation')).toHaveValue(workstationId);
  await page.getByTestId('storage-add-next').click();

  // step 2: the folder path is sealed for the workstation
  const dialog = page.getByTestId('storage-connect-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('storage-insecure-context')).toHaveCount(0);
  await dialog.getByLabel('Folder on the workstation').fill(FOLDER);
  await expect(page.getByTestId('storage-seal-connect')).toBeEnabled();
  await page.getByTestId('storage-seal-connect').click();
  // the dialog closes once the workstation answered "done"
  await expect(dialog).toBeHidden({ timeout: 30_000 });

  const row = (await connections()).find((c) => c.label === LABEL);
  expect(row?.kind).toBe('local');
  connectionId = row?.id as string;
  // the server holds no path: only the name, the type and the health
  const stored = JSON.stringify(await q('SELECT * FROM storage_connections WHERE id=$1', [connectionId]));
  expect(stored).not.toContain(FOLDER);

  // the health the runner reported reaches the page
  await expect(page.getByTestId(`storage-state-${connectionId}`)).toHaveText('Connected', {
    timeout: 20_000,
  });
  expect((await connections()).find((c) => c.id === connectionId)?.health.state).toBe('connected');
});

test('Test connection writes and deletes a probe file and says it passed', async () => {
  await page.getByTestId(`storage-test-${connectionId}`).click();
  await expect(page.getByTestId('storage-test-ok')).toHaveText('Test passed.', { timeout: 30_000 });
  // the probe is gone again: the folder holds nothing the test left behind
  expect(readdirSync(FOLDER)).toEqual([]);
  await expect(page.getByTestId(`storage-state-${connectionId}`)).toHaveText('Connected');
});

test('a test that cannot reach the folder reports the typed error', async () => {
  // the folder disappears from the workstation (an unplugged NAS share)
  rmSync(FOLDER, { recursive: true, force: true });
  await page.reload();
  await page.getByTestId(`storage-test-${connectionId}`).click();
  await expect(page.getByTestId('storage-test-failed')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId(`storage-state-${connectionId}`)).not.toHaveText('Connected', {
    timeout: 20_000,
  });
  mkdirSync(FOLDER, { recursive: true });
});

test('rename keeps the connection and shows the new name', async () => {
  const row = page.getByTestId(`storage-row-${connectionId}`);
  await row.getByRole('button', { name: 'Rename' }).click();
  const name = page.getByRole('dialog', { name: 'Rename storage' }).getByLabel('Display name');
  await name.fill(RENAMED);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText(RENAMED);
  expect((await connections()).find((c) => c.id === connectionId)?.label).toBe(RENAMED);
});

test('the Storage tab and the add dialog work at phone size', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(SETTINGS);
  await expect(page.getByTestId(`storage-row-${connectionId}`)).toBeVisible();
  const box = await page.getByTestId(`storage-test-${connectionId}`).boundingBox();
  expect(box && box.x + box.width).toBeLessThanOrEqual(390);
  await page.getByTestId('storage-new').click();
  const add = page.getByTestId('storage-add-dialog');
  await expect(add.getByLabel('Display name')).toBeVisible();
  await expect(page.getByTestId('storage-add-next')).toBeInViewport();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('remove deletes the connection and its sealed entry on the workstation', async () => {
  const store = join(HOME, 'secrets', 'storage.json');
  const before = existsSync(store) ? statSync(store).mtimeMs : 0;
  const sealedBefore = existsSync(store) ? readFileSync(store, 'utf8') : '';
  await page.getByTestId(`storage-remove-${connectionId}`).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
  await expect(page.getByTestId(`storage-row-${connectionId}`)).toHaveCount(0);
  await expect(page.getByText('No storage connected yet')).toBeVisible();
  expect((await connections()).some((c) => c.id === connectionId)).toBe(false);
  // the runner rewrote its sealed store without the entry
  await waitFor(
    'the sealed store changed on the workstation',
    async () => (existsSync(store) ? { m: statSync(store).mtimeMs, t: readFileSync(store, 'utf8') } : null),
    (s) => s === null || (s.m !== before && s.t !== sealedBefore),
    20_000,
  );
});
