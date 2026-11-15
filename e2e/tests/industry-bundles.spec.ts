import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { ADMIN } from '../support/env.ts';

// Industry bundles: a manager opens "Industry bundles" on Rules & decisions, previews the accounting and law bundles,
// installs one in a single action (rules, playbooks, documents appear in their usual screens), then uninstalls it
// behind a confirmation. Journey templates are global on the server: they stay in the Journeys gallery by design.
test.describe.configure({ mode: 'serial' });

const OWNER = { email: 'bundles@e2e.test', name: 'E2E Bundles', password: 'bundles-password-12345' };

let page: Page;
let api: APIRequestContext;

const openBundles = async () => {
  await page.goto('/ledger');
  await page.getByRole('button', { name: 'Industry bundles' }).click();
  return page.getByRole('dialog', { name: 'Industry bundles' });
};
const row = (dialog: ReturnType<Page['getByRole']>, name: RegExp) =>
  dialog.getByTestId('industry-bundle').filter({ hasText: name });

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, OWNER);
  api = await apiAs(OWNER.email, OWNER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  const proj = await api.post('/api/projects', { data: { key: 'BUN', name: 'Bundles' } });
  expect(proj.status(), await proj.text()).toBe(201);
  const mode = await api.patch('/api/org', { data: { mode: 'business' } });
  expect(mode.ok(), await mode.text()).toBeTruthy();
});

test('the dialog lists the accounting and law bundles with contents, not installed', async () => {
  const dialog = await openBundles();
  await expect(dialog.getByTestId('industry-bundle')).toHaveCount(2);
  await expect(row(dialog, /accounting/i)).toBeVisible();
  await expect(row(dialog, /law/i)).toBeVisible();
  await expect(dialog.getByTestId('bundle-contents').first()).not.toBeEmpty();
  await expect(dialog.getByText('Installed', { exact: true })).toHaveCount(0);
});

for (const [name, pattern] of [
  ['accounting', /accounting/i],
  ['law', /law/i],
] as const) {
  test(`${name}: preview, install once, then uninstall behind a confirmation`, async () => {
    const dialog = await openBundles();
    await row(dialog, pattern).first().click();
    await expect(dialog.getByTestId('bundle-item').first()).toBeVisible();
    await expect(dialog.getByRole('region', { name: 'Journey templates' })).toBeVisible();

    const countOf = async (path: string) => {
      const body = await (await api.get(path)).json();
      const arr = (Object.values(body).find(Array.isArray) ?? []) as { status?: string }[];
      // uninstall archives documents rather than deleting them
      return arr.filter((x) => x.status !== 'archived').length;
    };
    const before = { ledger: await countOf('/api/ledger'), docs: await countOf('/api/documents') };
    const installs: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().includes('/install')) installs.push(r.url());
    });
    await dialog.getByRole('button', { name: 'Install bundle' }).click();
    await expect(dialog.getByTestId('bundle-result')).toContainText('Bundle installed');
    expect(installs).toHaveLength(1);
    await expect(dialog.getByRole('button', { name: 'Uninstall bundle' })).toBeVisible();

    const list = (await (await api.get('/api/industry-bundles')).json()).bundles as {
      id: string;
      installed: boolean;
    }[];
    expect(list.filter((b) => b.installed)).toHaveLength(1);

    // rules show in Rules & decisions without a reload
    await page.keyboard.press('Escape');
    expect(await countOf('/api/ledger')).toBeGreaterThan(before.ledger);
    expect(await countOf('/api/documents')).toBeGreaterThan(before.docs);

    // journey templates are in the gallery
    const tpl = (await (await api.get('/api/journey-templates')).json()).items as { industry: string | null }[];
    expect(tpl.some((t) => t.industry === name)).toBe(true);

    const d2 = await openBundles();
    await row(d2, pattern).first().click();
    await d2.getByRole('button', { name: 'Uninstall bundle' }).click();
    const confirm = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: /Uninstall/ }));
    await expect(confirm.last()).toContainText('created or edited is kept');
    await confirm.last().getByRole('button', { name: 'Uninstall bundle' }).click();
    await expect(d2.getByTestId('bundle-result')).toContainText('Bundle uninstalled');
    await expect(d2.getByRole('button', { name: 'Install bundle' })).toBeVisible();
    const after = (await (await api.get('/api/industry-bundles')).json()).bundles as { installed: boolean }[];
    expect(after.some((b) => b.installed)).toBe(false);
    expect(await countOf('/api/ledger')).toBe(before.ledger);
    expect(await countOf('/api/documents')).toBe(before.docs);
    page.removeAllListeners('request');
  });
}
