import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, E2E_DIR, paths } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';
import { git, makeVault } from '../support/vault.ts';

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

// ------------------------------------------------------------------------------------------------ helpers for the other kinds

/** The sealed store of the workstation; it is encrypted, so a change of its bytes is what the specs can see. */
const STORE = join(HOME, 'secrets', 'storage.json');
const sealedStore = () => (existsSync(STORE) ? readFileSync(STORE, 'utf8') : '');

/** Step 1 of the add dialog: the kind and the display name; returns the new connection id once the server has it. */
async function addConnection(kind: string, label: string): Promise<string> {
  await page.goto(SETTINGS);
  await page.getByTestId('storage-new').click();
  const add = page.getByTestId('storage-add-dialog');
  await add.getByLabel('Type').selectOption(kind);
  await add.getByLabel('Display name').fill(label);
  await expect(add.getByLabel('Workstation')).toHaveValue(workstationId);
  await page.getByTestId('storage-add-next').click();
  await expect(page.getByTestId('storage-connect-dialog')).toBeVisible();
  const row = await waitFor(
    `the ${kind} connection is listed`,
    async () => (await connections()).find((c) => c.label === label),
    (c) => !!c,
    10_000,
  );
  expect(row?.kind).toBe(kind);
  return row?.id as string;
}

/** Clicks Test connection and returns the finished request as the server reports it (state, typed code). */
async function runTest(id: string): Promise<{ state: string; errorCode: string | null; ms: number }> {
  const started = Date.now();
  const [req] = await Promise.all([
    page.waitForRequest((r) => r.method() === 'POST' && r.url().endsWith(`/connections/${id}/test`)),
    page.getByTestId(`storage-test-${id}`).click(),
  ]);
  const rid = (req.postDataJSON() as { requestId: string }).requestId;
  type Req = { state: string; errorCode?: string | null };
  const r = await waitFor(
    'the test finished',
    async () =>
      ((await (await api.get(`/api/org/storage/requests/${rid}`)).json()) as { request: Req | null }).request,
    (x) => !!x && ['done', 'failed', 'expired', 'cancelled'].includes(x.state),
    60_000,
  );
  return { state: r?.state ?? '', errorCode: r?.errorCode ?? null, ms: Date.now() - started };
}

async function removeConnection(id: string): Promise<void> {
  const before = sealedStore();
  await page.getByTestId(`storage-remove-${id}`).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).last().click();
  await expect(page.getByTestId(`storage-row-${id}`)).toHaveCount(0);
  expect((await connections()).some((c) => c.id === id)).toBe(false);
  if (before)
    await waitFor(
      'the sealed store dropped the entry on the workstation',
      async () => sealedStore(),
      (t) => t !== before,
      20_000,
    );
}

/** Every text the server keeps about storage, its log and its API answer: none of it may hold a typed secret. */
async function serverSideText(): Promise<string> {
  const tables = await q<{ t: string }>(
    `SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema='public' AND (table_name LIKE 'storage%' OR table_name IN ('events','workstation_capabilities'))`,
  );
  const parts: string[] = [];
  for (const { t } of tables) parts.push(JSON.stringify(await q(`SELECT * FROM ${t}`)));
  parts.push(existsSync(paths.serverLog) ? readFileSync(paths.serverLog, 'utf8') : '');
  parts.push(await (await api.get('/api/org/storage/connections')).text());
  return parts.join('\n');
}

// ------------------------------------------------------------------------------------------------ S3-compatible
// A small S3-compatible store on this machine stands in for MinIO: it keeps objects in memory, checks that every call is
// signed with SigV4 and can refuse the key, hang, or go away.

type S3Mode = 'ok' | 'badkey' | 'hang';
const s3 = {
  mode: 'ok' as S3Mode,
  objects: new Map<string, Buffer>(),
  calls: [] as Array<{ method: string; path: string; auth: string }>,
};
let s3Server: Server | null = null;
let s3Port = 0;

function startS3(port = 0): Promise<number> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
      const auth = String(req.headers.authorization ?? '');
      s3.calls.push({ method: req.method ?? '', path, auth });
      if (s3.mode === 'hang') return; // accepts the call and never answers
      const xml = (status: number, code: string) => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(
          `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>x</Message></Error>`,
        );
      };
      if (s3.mode === 'badkey') return xml(403, 'InvalidAccessKeyId');
      if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=')) return xml(403, 'AccessDenied');
      if (req.method === 'PUT') {
        s3.objects.set(path, Buffer.concat(chunks));
        res.writeHead(200, { etag: '"e2e"' });
        res.end();
      } else if (req.method === 'DELETE') {
        s3.objects.delete(path);
        res.writeHead(204);
        res.end();
      } else if (req.method === 'HEAD') {
        res.writeHead(s3.objects.has(path) ? 200 : 404);
        res.end();
      } else xml(405, 'MethodNotAllowed');
    });
  });
  s3Server = server;
  return new Promise((ok) =>
    server.listen(port, '127.0.0.1', () => ok((server.address() as AddressInfo).port)),
  );
}

async function stopS3(): Promise<void> {
  const server = s3Server;
  s3Server = null;
  if (!server) return;
  server.closeAllConnections();
  await new Promise<void>((ok) => server.close(() => ok()));
}

test.afterAll(async () => {
  await stopS3();
});

const S3_LABEL = 'Client bucket (S3)';
const S3_BUCKET = 'firm-docs';
const S3_PREFIX = 'uploads';
const KEY_ID = 'AKIAE2ESTORAGE00001';
const SECRET = 'e2e-secret-access-key-7f3a9c1d0b';
const KEY_ID_2 = 'AKIAE2ESTORAGE00002';
const SECRET_2 = 'e2e-secret-access-key-rotated-55aa';
let s3Id: string;

async function fillS3(keyId: string, secret: string): Promise<void> {
  const dialog = page.getByTestId('storage-connect-dialog');
  await dialog.getByLabel('Endpoint').fill(`http://127.0.0.1:${s3Port}`);
  await dialog.getByLabel('Region').fill('eu-west-1');
  await dialog.getByLabel('Bucket').fill(S3_BUCKET);
  await dialog.getByLabel('Folder prefix (optional)').fill(S3_PREFIX);
  await dialog.getByLabel('Use path-style addresses (MinIO and most self-hosted stores)').check();
  await dialog.getByLabel('Access key id').fill(keyId);
  await dialog.getByLabel('Secret access key').fill(secret);
  await page.getByTestId('storage-seal-connect').click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

test('S3: add an S3-compatible bucket with keys; the probe is signed, written and deleted; the row shows Connected', async () => {
  s3Port = await startS3();
  s3.calls = [];
  s3Id = await addConnection('s3', S3_LABEL);
  await fillS3(KEY_ID, SECRET);
  await expect(page.getByTestId(`storage-state-${s3Id}`)).toHaveText('Connected', { timeout: 20_000 });

  // the probe went to the bucket under the prefix, signed with the key id (never with the secret itself), and is gone
  const put = s3.calls.find((c) => c.method === 'PUT');
  expect(put?.path.startsWith(`/${S3_BUCKET}/${S3_PREFIX}/`)).toBe(true);
  expect(put?.auth).toContain(`Credential=${KEY_ID}/`);
  expect(put?.auth).not.toContain(SECRET);
  expect(s3.calls.some((c) => c.method === 'DELETE' && c.path === put?.path)).toBe(true);
  expect([...s3.objects.keys()]).toEqual([]);

  // the server holds no endpoint, key id or secret: the storage tables, the event log, the server log and the API
  const text = await serverSideText();
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(KEY_ID);
  expect(text).not.toContain(`127.0.0.1:${s3Port}`);
});

test('S3: Test connection writes and deletes a probe object and passes', async () => {
  s3.calls = [];
  const r = await runTest(s3Id);
  expect(r).toMatchObject({ state: 'done', errorCode: null });
  await expect(page.getByTestId('storage-test-ok')).toHaveText('Test passed.');
  expect(s3.calls.map((c) => c.method)).toEqual(['PUT', 'DELETE']);
  expect([...s3.objects.keys()]).toEqual([]);
});

test('S3: a refused key is auth_expired, the row needs re-authentication and Reconnect with new keys works', async () => {
  s3.mode = 'badkey';
  const r = await runTest(s3Id);
  expect(r).toMatchObject({ state: 'failed', errorCode: 'auth_expired' });
  await expect(page.getByTestId('storage-test-failed')).toBeVisible();
  await expect(page.getByTestId(`storage-state-${s3Id}`)).toHaveText('Needs re-authentication', {
    timeout: 20_000,
  });
  const reconnect = page.getByTestId(`storage-connect-${s3Id}`);
  await expect(reconnect).toHaveText('Reconnect');

  // the keys are rotated at the store; Reconnect seals the new ones for the workstation
  s3.mode = 'ok';
  s3.calls = [];
  await reconnect.click();
  await fillS3(KEY_ID_2, SECRET_2);
  await expect(page.getByTestId(`storage-state-${s3Id}`)).toHaveText('Connected', { timeout: 20_000 });
  await expect(page.getByTestId(`storage-connect-${s3Id}`)).toHaveCount(0);
  expect(s3.calls.length).toBeGreaterThan(0);
  expect(s3.calls.every((c) => c.auth.includes(`Credential=${KEY_ID_2}/`))).toBe(true);
  expect(await serverSideText()).not.toContain(SECRET_2);
});

test('S3: a store that never answers fails as unavailable within the bounded time', async () => {
  s3.mode = 'hang';
  const r = await runTest(s3Id);
  // a connector call that runs out of time is a retryable `unavailable` (design section 4.3)
  expect(r).toMatchObject({ state: 'failed', errorCode: 'unavailable' });
  // the probe bound is 30 s on the runner; allow for polling, never an open-ended wait
  expect(r.ms).toBeLessThan(50_000);
  await expect(page.getByTestId('storage-test-failed')).toBeVisible();
  await expect(page.getByTestId(`storage-state-${s3Id}`)).toHaveText('Unavailable', { timeout: 20_000 });
});

test('S3: a stopped store fails at once as unavailable and the server keeps nothing of the probe', async () => {
  await stopS3();
  s3.mode = 'ok';
  const r = await runTest(s3Id);
  expect(r).toMatchObject({ state: 'failed', errorCode: 'unavailable' });
  expect(r.ms).toBeLessThan(20_000);
  await expect(page.getByTestId(`storage-state-${s3Id}`)).toHaveText('Unavailable', { timeout: 20_000 });
  // the server stores no content: no storage table has a column for bytes and nothing of the probe text is there
  const cols = await q<{ c: string; t: string }>(
    `SELECT table_name AS t, column_name AS c FROM information_schema.columns
      WHERE table_schema='public' AND table_name LIKE 'storage%' AND data_type='bytea'`,
  );
  expect(cols).toEqual([]);
});

test('S3: the store is back, rename and remove the connection; the sealed keys leave the workstation', async () => {
  s3Port = await startS3(s3Port);
  expect((await runTest(s3Id)).state).toBe('done');
  const row = page.getByTestId(`storage-row-${s3Id}`);
  await row.getByRole('button', { name: 'Rename' }).click();
  await page
    .getByRole('dialog', { name: 'Rename storage' })
    .getByLabel('Display name')
    .fill('Archive bucket');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('Archive bucket');
  await removeConnection(s3Id);
  await stopS3();
});

// ------------------------------------------------------------------------------------------------ vault folder

test('vault: a folder in the organization vault connects, tests without leaving a commit, and is removed', async () => {
  const fixture = makeVault('storage', { 'README.md': 'storage vault\n' });
  const reg = await api.post('/api/vaults', {
    data: { kind: 'org', name: 'Firm vault', remoteUrl: fixture.origin, syncIntervalSec: 2 },
  });
  expect(reg.status(), await reg.text()).toBe(201);
  const vaultId = (await q<{ id: string }>('SELECT id FROM vaults WHERE remote_url=$1', [fixture.origin]))[0]
    ?.id as string;
  const clone = join(HOME, 'vaults', vaultId);
  await waitFor(
    'the vault is cloned on the workstation',
    async () => existsSync(join(clone, 'README.md')),
    (b) => b,
    60_000,
  );
  const head = git(fixture.origin, 'rev-parse', 'main').trim();

  const id = await addConnection('vault', 'Firm vault documents');
  const dialog = page.getByTestId('storage-connect-dialog');
  await dialog.getByLabel('Vault', { exact: true }).selectOption({ label: 'Firm vault' });
  await dialog.getByLabel('Folder inside the vault').fill('client-documents');
  await page.getByTestId('storage-seal-connect').click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(page.getByTestId(`storage-state-${id}`)).toHaveText('Connected', { timeout: 20_000 });

  expect((await runTest(id)).state).toBe('done');
  await expect(page.getByTestId('storage-test-ok')).toHaveText('Test passed.');
  // the probe file is gone and was never committed or pushed
  const probeDir = join(clone, 'client-documents');
  expect(existsSync(probeDir) ? readdirSync(probeDir) : []).toEqual([]);
  expect(git(fixture.origin, 'rev-parse', 'main').trim()).toBe(head);

  await removeConnection(id);
});

// ------------------------------------------------------------------------------------------------ OAuth kinds
// The sign-in itself runs against Microsoft or Google from the workstation (mocked HTTP in the runner and server suites).
// This runner has no app registered for either, so the flow must stop with a clear message and keep nothing.

for (const [kind, label, extra] of [
  ['google_drive', 'Client Drive', 'Folder name'],
  ['onedrive', 'Firm SharePoint', 'SharePoint site address (optional)'],
] as const) {
  test(`${kind}: add, ask for a sign-in code on a runner without an app, rename and remove`, async () => {
    const id = await addConnection(kind, label);
    const dialog = page.getByTestId('storage-connect-dialog');
    await expect(dialog.getByLabel(extra)).toBeVisible();
    // OAuth kinds never ask for typed secrets in the browser
    await expect(page.getByTestId('storage-seal-connect')).toHaveCount(0);
    await page.getByTestId('storage-signin').click();
    await expect(page.getByTestId('storage-device-error')).toContainText(
      kind === 'onedrive' ? 'no Microsoft app configured' : 'no Google app configured',
      { timeout: 30_000 },
    );
    // the footer Close and the dialog's own close button both end the dialog
    await page.getByRole('button', { name: 'Close' }).first().click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId(`storage-state-${id}`)).toHaveText('Not connected yet');
    await expect(page.getByTestId(`storage-connect-${id}`)).toHaveText('Connect');

    const row = page.getByTestId(`storage-row-${id}`);
    await row.getByRole('button', { name: 'Rename' }).click();
    await page.getByRole('dialog', { name: 'Rename storage' }).getByLabel('Display name').fill(`${label} 2`);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(row).toContainText(`${label} 2`);
    await removeConnection(id);
  });
}
