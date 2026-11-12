import { expect, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q } from '../support/db.ts';
import { ADMIN, OTHER, paths } from '../support/env.ts';

// Per-project review settings: the owner sets a size budget, a unit and a path-to-risk map; nothing is set by default;
// the UI names what is missing; only the owner may change them.
test.describe.configure({ mode: 'serial' });

let projectId: string;
const url = () => `/api/projects/${projectId}/review-settings`;
const events = async () =>
  Number(
    (await q<{ n: string }>(
      `SELECT count(*) AS n FROM events WHERE type='ProjectReviewSettingsSet' AND payload->>'projectId'=$1`,
      [projectId],
    ))[0]?.n,
  );

test.beforeAll(async () => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const proj = await admin.post('/api/projects', { data: { key: 'RVS', name: 'Review settings project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const add = await admin.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status(), await add.text()).toBe(201);
});

test('AC2/AC3: a new project has nothing set and the panel says what is missing', async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const dto = (await (await admin.get(`/api/projects/${projectId}`)).json()).project;
  expect(dto.reviewSettings).toMatchObject({ sizeBudget: null, sizeUnit: null, riskMap: null });
  const row = (await q('SELECT size_budget, size_unit, risk_map FROM projects WHERE id=$1', [projectId]))[0];
  expect(row).toMatchObject({ size_budget: null, size_unit: null, risk_map: null });

  const page = await (await browser.newContext({ storageState: await admin.storageState() })).newPage();
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByTestId('review-settings-budget')).toHaveValue('');
  await expect(page.getByTestId('review-settings-unit')).toHaveValue('');
  await expect(page.getByTestId('review-settings-status-size')).toContainText('inactive: no size budget set');
  await expect(page.getByTestId('review-settings-status-risk')).toContainText(
    'inactive: no path-to-risk map set',
  );
});

test('AC1: the owner saves budget, unit and map; they show after reload; an identical save records nothing', async ({
  browser,
}) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const page = await (await browser.newContext({ storageState: await admin.storageState() })).newPage();
  await page.goto(`/projects/${projectId}/settings`);
  await page.getByTestId('review-settings-budget').fill('400');
  await page.getByTestId('review-settings-unit').selectOption('changed_lines');
  await page.getByTestId('review-settings-add').click();
  await page.getByTestId('review-settings-pattern').nth(0).fill('apps/server/src/auth');
  await page.getByTestId('review-settings-risk').nth(0).selectOption('high');
  await page.getByTestId('review-settings-add').click();
  await page.getByTestId('review-settings-pattern').nth(1).fill('docs/**');
  await page.getByTestId('review-settings-risk').nth(1).selectOption('low');
  await page.getByTestId('review-settings-save').click();
  await expect.poll(events).toBe(1);

  await page.reload();
  await expect(page.getByTestId('review-settings-budget')).toHaveValue('400');
  await expect(page.getByTestId('review-settings-unit')).toHaveValue('changed_lines');
  await expect(page.getByTestId('review-settings-row')).toHaveCount(2);
  await expect(page.getByTestId('review-settings-pattern').nth(0)).toHaveValue('apps/server/src/auth');
  await expect(page.getByTestId('review-settings-risk').nth(1)).toHaveValue('low');
  await expect(page.getByTestId('review-settings-status-size')).toContainText('active');
  await expect(page.getByTestId('review-settings-status-size')).not.toContainText('inactive');

  await page.getByTestId('review-settings-save').click();
  await page.waitForTimeout(1500);
  expect(await events()).toBe(1);
});

test('inline errors for "..", a leading "/" and a duplicate path; nothing is saved', async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const page = await (await browser.newContext({ storageState: await admin.storageState() })).newPage();
  await page.goto(`/projects/${projectId}/settings`);
  await page.getByTestId('review-settings-pattern').nth(0).fill('../secrets');
  await page.getByTestId('review-settings-save').click();
  await expect(page.getByTestId('review-settings-row').nth(0)).toContainText(/\.\./);
  await page.getByTestId('review-settings-pattern').nth(0).fill('/etc');
  await page.getByTestId('review-settings-save').click();
  await expect(page.getByTestId('review-settings-row').nth(0)).toContainText(/\//);
  await page.getByTestId('review-settings-pattern').nth(0).fill('docs/**');
  await page.getByTestId('review-settings-save').click();
  await expect(page.getByTestId('review-settings-row').nth(1)).toContainText(/duplicate|already/i);
  expect(await events()).toBe(1);
});

test('AC3: clearing the budget shows "inactive: no size budget set"', async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const page = await (await browser.newContext({ storageState: await admin.storageState() })).newPage();
  await page.goto(`/projects/${projectId}/settings`);
  await page.getByTestId('review-settings-budget').fill('');
  await page.getByTestId('review-settings-save').click();
  await expect.poll(events).toBe(2);
  await page.reload();
  await expect(page.getByTestId('review-settings-status-size')).toContainText('inactive: no size budget set');
});

test('touch: numeric keypad, Add path focuses the new row, 44px targets on a phone', async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const ctx = await browser.newContext({
    storageState: await admin.storageState(),
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByTestId('review-settings-budget')).toHaveAttribute('inputmode', 'numeric');
  const add = page.getByTestId('review-settings-add');
  await add.scrollIntoViewIfNeeded();
  expect((await add.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  expect((await page.getByTestId('review-settings-save').boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
  const before = await page.getByTestId('review-settings-row').count();
  await add.tap();
  await expect(page.getByTestId('review-settings-row')).toHaveCount(before + 1);
  await expect(page.getByTestId('review-settings-pattern').nth(before)).toBeFocused();
  await expect(page.getByTestId('review-settings-pattern').nth(before)).toBeInViewport();
  await ctx.close();
});

test('AC5: a manager sees a read-only panel and the PUT is refused; the owner can still save', async ({
  browser,
}) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, OTHER).catch(() => undefined); // the account may exist already
  await q(
    `INSERT INTO project_members (project_id, user_id, role, status, joined_at)
     SELECT $1, id, 'manager', 'active', now() FROM users WHERE email=$2`,
    [projectId, OTHER.email],
  );
  const other = await apiAs(OTHER.email, OTHER.password);
  const before = await events();
  const denied = await other.put(url(), { data: { sizeBudget: 1, sizeUnit: 'changed_files', riskMap: null } });
  expect(denied.status()).toBe(403);
  expect(await events()).toBe(before);

  const page = await (await browser.newContext({ storageState: await other.storageState() })).newPage();
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByTestId('review-settings-readonly')).toBeVisible();
  await expect(page.getByTestId('review-settings-budget')).toHaveCount(0);
  await expect(page.getByTestId('review-settings-save')).toHaveCount(0);

  const ok = await admin.put(url(), { data: { sizeBudget: 12, sizeUnit: 'changed_files', riskMap: null } });
  expect(ok.status(), await ok.text()).toBe(200);
});
