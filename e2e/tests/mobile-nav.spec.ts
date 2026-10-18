import { type APIRequestContext, expect, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { BASE_URL, MOBILER } from '../support/env.ts';

// The phone shell: a bottom tab bar instead of the sidebar, a More menu with every other destination, the PWA files.
// Runs on the project's device (WebKit iPhone 15 by default, see playwright.config.ts).

test.beforeAll(async () => {
  // The first argument is unused by the helper (it runs the server's admin:create); this spec has no admin session.
  await inviteAndAccept(null as unknown as APIRequestContext, MOBILER);
});

test('the bottom tab bar replaces the sidebar and reaches Desk, Intake and Projects', async ({
  browser,
}, info) => {
  const state = await (await apiAs(MOBILER.email, MOBILER.password)).storageState();
  const ctx = await browser.newContext({ ...info.project.use, storageState: state });
  const page = await ctx.newPage();
  await page.goto('/desk');
  const bar = page.getByTestId('mobile-tabbar');
  await expect(bar).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  for (const name of ['Desk', 'Chats', 'Intake', 'Projects', 'More'])
    await expect(bar.getByText(name, { exact: true })).toBeVisible();
  // tap targets are at least 44px, the bar sits on the bottom edge
  for (const id of ['tab-desk', 'tab-chats', 'tab-intake', 'tab-projects', 'tab-more']) {
    const box = await page.getByTestId(id).boundingBox();
    expect(box && box.height >= 44 && box.width >= 44, id).toBeTruthy();
  }
  const viewport = page.viewportSize();
  const barBox = await bar.boundingBox();
  expect(barBox && viewport && Math.abs(barBox.y + barBox.height - viewport.height) < 2).toBeTruthy();
  await expect(page.getByTestId('tab-desk')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('tab-projects').click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByTestId('tab-projects')).toHaveAttribute('aria-current', 'page');
  await page.getByTestId('tab-intake').click();
  await expect(page).toHaveURL(/\/intake$/);
  await page.getByTestId('tab-desk').click();
  await expect(page).toHaveURL(/\/desk$/);
  // nothing scrolls sideways
  expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await page.getByTestId('tab-chats').click();
  await expect(page.getByRole('dialog').first()).toBeVisible();
  await ctx.close();
});

test('every destination in More opens, and the menu offers sign out', async ({ browser }, info) => {
  const state = await (await apiAs(MOBILER.email, MOBILER.password)).storageState();
  const ctx = await browser.newContext({ ...info.project.use, storageState: state });
  const page = await ctx.newPage();
  await page.goto('/projects');
  await page.getByTestId('tab-more').click();
  const menu = page.getByRole('dialog', { name: 'Main menu' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: /sign out/i })).toBeVisible();
  const hrefs = await menu
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link')
    .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  expect(hrefs.length).toBeGreaterThan(10);
  const footer = await menu
    .getByRole('link', { name: /^(Settings|Organization|Help)$/ })
    .evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? ''));
  const targets = [...new Set([...hrefs, ...footer])].filter((h) => h.startsWith('/'));
  for (const href of targets) {
    await page.goto('/projects');
    await page.getByTestId('tab-more').click();
    const dialog = page.getByRole('dialog', { name: 'Main menu' });
    await dialog.locator(`a[href="${href}"]`).first().click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('main')).toBeVisible();
    // the page rendered (no crash screen) and the phone layout still has its bar
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await expect(page.getByTestId('mobile-tabbar')).toBeVisible();
  }
  await ctx.close();
});

test('the top bar shows the page title, and a card has a way back', async ({ browser }, info) => {
  const state = await (await apiAs(MOBILER.email, MOBILER.password)).storageState();
  const ctx = await browser.newContext({ ...info.project.use, storageState: state });
  const page = await ctx.newPage();
  await page.goto('/desk');
  await expect(page.getByTestId('mobile-title')).toHaveText(/desk/i);
  await expect(page.getByTestId('mobile-back')).toHaveCount(0);
  await page.goto('/cards/NOPE-1');
  await expect(page.getByTestId('mobile-back')).toBeVisible();
  await ctx.close();
});

test('on a desktop the sidebar stays and there is no tab bar', async ({ browser }) => {
  const state = await (await apiAs(MOBILER.email, MOBILER.password)).storageState();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, storageState: state });
  const page = await ctx.newPage();
  await page.goto('/desk');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByTestId('mobile-tabbar')).toHaveCount(0);
  await ctx.close();
});

test('the manifest and the service worker are served for installing', async ({ request }) => {
  const manifest = await request.get(`${BASE_URL}/manifest.webmanifest`);
  expect(manifest.ok()).toBeTruthy();
  expect(manifest.headers()['content-type']).toMatch(/application\/manifest\+json/);
  const m = await manifest.json();
  expect(m.display).toBe('standalone');
  for (const icon of m.icons)
    expect((await request.get(`${BASE_URL}${icon.src}`)).ok(), icon.src).toBeTruthy();
  const sw = await request.get(`${BASE_URL}/sw.js`);
  expect(sw.ok()).toBeTruthy();
  expect(sw.headers()['content-type']).toMatch(/javascript/);
  expect(sw.headers()['cache-control']).toMatch(/no-cache|no-store/);
  expect((await request.get(`${BASE_URL}/offline.html`)).ok()).toBeTruthy();
});

test('the service worker registers in a production build', async ({ browser }, info) => {
  const state = await (await apiAs(MOBILER.email, MOBILER.password)).storageState();
  const ctx = await browser.newContext({ ...info.project.use, storageState: state });
  const page = await ctx.newPage();
  await page.goto('/desk');
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const sw = (
          navigator as unknown as { serviceWorker?: { getRegistration(scope: string): Promise<unknown> } }
        ).serviceWorker;
        return !!(await sw?.getRegistration('/'));
      }),
    )
    .toBe(true);
  await ctx.close();
});
