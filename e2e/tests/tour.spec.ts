import AxeBuilder from '@axe-core/playwright';
import { type Browser, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { pool, q } from '../support/db.ts';
import { ADMIN, TOURIST } from '../support/env.ts';

// The first-login tour, the Help centre (articles, search, glossary, replay), "What's on this page" and the ? hints.
// The suite runs with the tour switched off for everyone (AOM_TOUR_AUTOSTART=false); this spec switches it on for one user.
test.describe.configure({ mode: 'serial' });

const setTour = (state: 'new' | 'in_progress' | 'completed' | 'dismissed', step = 0) =>
  q('UPDATE users SET tour_status=$2, tour_step=$3 WHERE email=$1', [TOURIST.email, state, step]);
const tourRow = async () =>
  (
    await q<{ tour_status: string; tour_step: number }>(
      'SELECT tour_status, tour_step FROM users WHERE email=$1',
      [TOURIST.email],
    )
  )[0];

/** A browser context signed in as the tourist (API login, so the tour state is the only thing the page shows). */
async function signedIn(browser: Browser, opts: { mobile?: boolean } = {}): Promise<Page> {
  const state = await (await apiAs(TOURIST.email, TOURIST.password)).storageState();
  const ctx = await browser.newContext({
    storageState: state,
    ...(opts.mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {}),
  });
  return ctx.newPage();
}

test.beforeAll(async () => {
  await inviteAndAccept(await apiAs(ADMIN.email, ADMIN.password), TOURIST);
});
test.afterAll(async () => {
  await pool.end();
});

test('a new user is shown the tour on the first login, and Skip keeps it away on every device', async ({
  browser,
  page,
}) => {
  await setTour('new');
  await page.goto('/login');
  await page.getByLabel('Email').fill(TOURIST.email);
  await page.getByLabel('Password').fill(TOURIST.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  const tour = page.getByTestId('tour');
  await expect(tour).toBeVisible();
  await expect(page.getByTestId('tour-title')).toHaveText('Watch the 3-minute getting-started video');
  await expect(page.getByTestId('tour-progress')).toHaveText(/Step 1 of \d+/);
  await expect(page.getByTestId('tour-back')).toHaveCount(0);
  await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour-title')).toHaveText('Welcome to Guildwise HQ');

  // the next step lights up the Board entry of the real sidebar
  await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour-title')).toHaveText('Board');
  await expect(page.getByTestId('tour-spotlight')).toBeVisible();
  const lit = await page.getByTestId('tour-spotlight').boundingBox();
  const board = await page.locator('[data-tour="nav-board"]').boundingBox();
  expect(lit && board && lit.x <= board.x && lit.y <= board.y && lit.width >= board.width).toBeTruthy();
  await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour-title')).toHaveText('Desk');
  await page.getByTestId('tour-back').click();
  await expect(page.getByTestId('tour-title')).toHaveText('Board');
  await expect.poll(async () => (await tourRow())?.tour_step).toBe(2);

  // accessible: a named dialog with its text, and nothing serious for axe
  await expect(tour).toHaveAttribute('role', 'dialog');
  const axe = await new AxeBuilder({ page }).include('[data-testid="tour"]').analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);

  await page.getByTestId('tour-skip').click();
  await expect(tour).toHaveCount(0);
  await expect.poll(async () => (await tourRow())?.tour_status).toBe('dismissed');

  // not after a reload ...
  await page.reload();
  await expect(page.getByTestId('user-menu')).toBeVisible();
  await expect(page.getByTestId('tour')).toHaveCount(0);

  // ... and not on a new device (a fresh browser context)
  const other = await signedIn(browser);
  await other.goto('/');
  await expect(other.getByTestId('user-menu')).toBeVisible();
  await expect(other.getByTestId('tour')).toHaveCount(0);
  await other.context().close();
});

test('an interrupted tour does not pop up again on the next login; Escape closes a resumed tour like Skip', async ({
  browser,
}) => {
  await setTour('in_progress', 3);
  const page = await signedIn(browser);
  await page.goto('/');
  await expect(page.getByTestId('palette-button')).toBeVisible();
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await page.goto('/help');
  await page.getByTestId('help-resume-tour').click();
  await expect(page.getByTestId('tour-progress')).toHaveText(/Step 4 of/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tour')).toHaveCount(0);
  await expect.poll(async () => (await tourRow())?.tour_status).toBe('dismissed');
  expect((await tourRow())?.tour_step).toBe(3);
  await page.context().close();
});

test('Help replays the tour, which walks the whole sidebar and ends by offering Add a workstation', async ({
  browser,
}) => {
  await setTour('dismissed', 3);
  const page = await signedIn(browser);
  await page.goto('/help');
  await expect(page.getByTestId('help-resume-tour')).toBeVisible();
  await page.getByTestId('help-replay-tour').click();
  await expect(page.getByTestId('tour-progress')).toHaveText(/Step 1 of/);

  const seen: string[] = [];
  for (let i = 0; i < 40; i++) {
    seen.push((await page.getByTestId('tour-title').textContent()) ?? '');
    if (await page.getByTestId('tour-offer').count()) break;
    await page.getByTestId('tour-next').click();
  }
  for (const title of [
    'Board',
    'Backlog',
    'Environments',
    'Desk',
    'Intake',
    'Automations',
    'Projects and phases',
    'Agents',
    'Org chart',
    'CEO',
    'Roles & workflows',
    'Workstations',
    'Releases',
    'Integrations',
    'Metrics',
    'Costs',
    'Interests',
    'Ledger',
    'Vaults',
    'Settings',
    'Organization',
    'Search and jump anywhere',
    'What is on this page?',
    'Help centre',
    'You are set',
  ])
    expect(seen, title).toContain(title);
  await expect(page.getByTestId('tour-offer')).toHaveText('Add a workstation');
  await page.getByTestId('tour-offer').click();
  await expect(page).toHaveURL(/\/workstations\?add=1/);
  await expect(page.getByRole('dialog')).toContainText(/workstation/i);
  await expect.poll(async () => (await tourRow())?.tour_status).toBe('completed');
  await page.context().close();
});

test('the Help centre: entries in the sidebar, the user menu and Ctrl+K, search, an article and the glossary', async ({
  browser,
}) => {
  await setTour('completed', 20);
  const page = await signedIn(browser);
  await page.goto('/desk');
  await page.getByTestId('nav-help').click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByTestId('help-replay-tour')).toHaveText('Replay the tour');

  await page.getByTestId('user-menu').click();
  await expect(page.getByTestId('menu-help')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('help');
  await expect(page.getByRole('option', { name: 'Help', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByTestId('help-search').fill('allow-list');
  await expect(page.getByTestId('help-results')).toBeVisible();
  await page.locator('[data-testid="help-result"][href^="/help/agents#allow-lists"]').first().click();
  await expect(page).toHaveURL(/\/help\/agents#allow-lists$/);
  await expect(page.getByTestId('help-article-title')).toBeVisible();
  await expect(page.locator('#allow-lists')).toBeInViewport();

  await page.getByTestId('help-search').fill('qqzzxx');
  await expect(page.getByText(/Nothing found/)).toBeVisible();
  await page.getByTestId('help-search').fill('');
  await page.getByRole('link', { name: 'All articles' }).click();
  await page.getByTestId('help-glossary-link').click();
  await expect(page.getByTestId('help-glossary')).toContainText('Allow-list');
  await expect(page.getByTestId('help-glossary')).toContainText('Workstation');

  // light and dark, no serious accessibility problems
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']).analyze();
  expect(axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact ?? ''))).toEqual([]);
  await page.context().close();
});

test('"What is on this page" explains the page behind it and closes with Escape', async ({ browser }) => {
  const page = await signedIn(browser);
  await page.goto('/desk');
  const button = page.getByTestId('page-help-button');
  await button.click();
  const panel = page.getByTestId('page-help');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: /desk/i }).first()).toBeVisible();
  expect(await panel.getByTestId('page-help-controls').locator('> div').count()).toBeGreaterThan(2);
  await panel.getByTestId('page-help-article').click();
  await expect(page).toHaveURL(/\/help\/desk/);
  await page.goto('/agents');
  await button.click();
  await expect(panel).toContainText(/hire/i);
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(button).toBeFocused();
  await page.context().close();
});

test('a ? hint explains a control and links to its article', async ({ browser }) => {
  const page = await signedIn(browser);
  await page.goto('/settings/org');
  await page.getByRole('button', { name: 'About requiring two-factor login' }).click();
  await expect(page.getByText(/authenticator app/).first()).toBeVisible();
  const [article] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByTestId('help-hint-link').click(),
  ]);
  await expect(article).toHaveURL(/\/help\/two-factor#enforcement$/);
  await expect(article.getByTestId('help-article-title')).toContainText(/two-factor/i);
  await article.close();
  await page.context().close();
});

test('on a phone the tour opens the menu for the sidebar steps', async ({ browser }) => {
  await setTour('new');
  const page = await signedIn(browser, { mobile: true });
  await page.goto('/');
  const tour = page.getByTestId('tour');
  await expect(tour).toBeVisible();
  await page.getByTestId('tour-next').click();
  await page.getByTestId('tour-next').click();
  await expect(page.getByTestId('tour-title')).toHaveText('Board');
  await expect(page.getByRole('dialog', { name: 'Main menu' })).toBeVisible();
  await expect(page.getByTestId('tour-spotlight')).toBeVisible();
  // the card stays on screen, and nothing scrolls sideways
  const box = await tour.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();
  expect(await page.locator('html').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // the menu is shut again for a step that is not in it
  for (let i = 0; i < 40; i++) {
    if ((await page.getByTestId('tour-title').textContent()) === 'Search and jump anywhere') break;
    await page.getByTestId('tour-next').click();
  }
  await expect(page.getByRole('dialog', { name: 'Main menu' })).toHaveCount(0);
  await page.getByTestId('tour-skip').click();
  await expect(tour).toHaveCount(0);
  await expect.poll(async () => (await tourRow())?.tour_status).toBe('dismissed');
  await page.context().close();
});
