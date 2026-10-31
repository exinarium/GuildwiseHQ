import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { ADMIN, paths } from '../support/env.ts';

// Business mode wording: in a Business-mode organization no main page says "Vault", "Ledger" or "standing order"
// (the vault is "Knowledge", the ledger "Rules & decisions", standing orders "rules"). Routes, test-ids and API paths
// keep their names. Switching back to Developer mode shows the old words again. Standalone: one user, own org.
test.describe.configure({ mode: 'serial' });

const TERMS = { email: 'terms@e2e.test', name: 'E2E Wording', password: 'terms-password-12345' };
const FORBIDDEN = /\b(vaults?|ledgers?|standing orders?)\b/i;

let page: Page;
let api: APIRequestContext;
let projectId: string;

const MAIN_PAGES = [
  '/desk',
  '/projects',
  '/ledger',
  '/settings/vaults',
  '/documents',
  '/interests',
  '/settings/capabilities',
  '/agents',
  '/automations',
  '/settings/org',
  '/help',
  '/help/ledger-and-vaults',
  '/help/glossary',
];

/** Visible text plus aria-label, title and placeholder attributes of the page, minus the aom command line. */
async function shownText(): Promise<string> {
  const raw = await page.evaluate(() => {
    const parts = [document.body.innerText];
    for (const el of Array.from(document.querySelectorAll('[aria-label],[title],[placeholder]'))) {
      for (const a of ['aria-label', 'title', 'placeholder']) {
        const v = el.getAttribute(a);
        if (v) parts.push(v);
      }
    }
    return parts.join('\n');
  });
  // the aom command line keeps its name, as do `vault:<path>` references
  return raw.replace(/aom ledger( \w+)?/g, '').replace(/vault:\S+/g, '');
}

async function visit(url: string): Promise<string> {
  await page.goto(url);
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  return shownText();
}

const offending = (text: string) =>
  text
    .split('\n')
    .filter((l) => FORBIDDEN.test(l))
    .slice(0, 5);

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, TERMS);
  api = await apiAs(TERMS.email, TERMS.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a project, a standing order, a decision and an org and project vault with default names', async () => {
  const proj = await api.post('/api/projects', { data: { key: 'WRD', name: 'Wording' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const so = await api.post('/api/ledger', {
    data: { scope: 'standing_order', title: 'Reply in English', body: 'Write every reply in English.' },
  });
  expect(so.status(), await so.text()).toBe(201);
  const dec = await api.post('/api/ledger', {
    data: { scope: 'decision', projectId, title: 'Pick the blue logo', body: 'We use the blue logo.' },
  });
  expect(dec.status(), await dec.text()).toBe(201);
  const ov = await api.post('/api/vaults', { data: { kind: 'org', remoteUrl: paths.origin } });
  expect(ov.status(), await ov.text()).toBe(201);
  const pv = await api.post('/api/vaults', { data: { kind: 'project', projectId, remoteUrl: paths.origin } });
  expect(pv.status(), await pv.text()).toBe(201);
});

test('dev org: the old words are shown', async () => {
  expect((await (await api.get('/api/org')).json()).mode).toBe('dev');
  await visit('/ledger');
  await expect(page.getByTestId('nav-ledger')).toHaveText(/Ledger/);
  await expect(page.getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();
  await expect(page.getByText('Reply in English')).toBeVisible();
  await visit('/settings/vaults');
  await expect(page.getByRole('heading', { name: 'Vaults', exact: true })).toBeVisible();
  await expect(page.getByText('Organization vault').first()).toBeVisible();
});

test('switching to Business mode', async () => {
  const r = await api.patch('/api/org', { data: { mode: 'business' } });
  expect(r.ok(), await r.text()).toBeTruthy();
  expect((await (await api.get('/api/org')).json()).mode).toBe('business');
});

test('business org: the main pages never say Vault, Ledger or standing order', async () => {
  const bad: Record<string, string[]> = {};
  for (const url of MAIN_PAGES) {
    const found = offending(await visit(url));
    if (found.length) bad[url] = found;
  }
  expect(bad).toEqual({});
});

test('business org: Rules & decisions and Knowledge pages, same routes and test-ids, user content unchanged', async () => {
  await visit('/ledger');
  expect(new URL(page.url()).pathname).toBe('/ledger');
  await expect(page.getByTestId('nav-ledger')).toHaveText(/Rules & decisions/);
  await expect(page.getByRole('heading', { name: 'Rules & decisions', exact: true })).toBeVisible();
  await expect(page.getByText('Reply in English')).toBeVisible();
  await expect(page.getByText('Pick the blue logo')).toBeVisible();

  await visit('/settings/vaults');
  expect(new URL(page.url()).pathname).toBe('/settings/vaults');
  await expect(page.getByRole('heading', { name: 'Knowledge', exact: true })).toBeVisible();
  await expect(page.getByText('Organization knowledge').first()).toBeVisible();
  await expect(page.getByText('Project knowledge').first()).toBeVisible();

  // the API keeps its names and the stored vault names are not changed
  const vaults = (await (await api.get('/api/vaults')).json()).vaults as { name: string }[];
  expect(vaults.map((v) => v.name).sort()).toEqual(['Organization vault', 'Project vault']);
  const ledger = await api.get('/api/ledger');
  expect(ledger.ok()).toBeTruthy();
});

test('business org: the add dialog on Rules & decisions reads rule, not standing order', async () => {
  await visit('/ledger');
  await page.getByRole('button', { name: /Add/ }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const text = await shownText();
  expect(offending(text)).toEqual([]);
  await page.keyboard.press('Escape');
});

test('switching back to Developer mode shows the old words again', async () => {
  const r = await api.patch('/api/org', { data: { mode: 'dev' } });
  expect(r.ok(), await r.text()).toBeTruthy();
  await visit('/ledger');
  await expect(page.getByRole('heading', { name: 'Ledger', exact: true })).toBeVisible();
  await visit('/settings/vaults');
  await expect(page.getByRole('heading', { name: 'Vaults', exact: true })).toBeVisible();
  await expect(page.getByText('Organization vault').first()).toBeVisible();
});
