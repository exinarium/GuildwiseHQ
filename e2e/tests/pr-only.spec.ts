import { expect, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q } from '../support/db.ts';
import { ADMIN, GUEST, paths } from '../support/env.ts';

// PR-only review per project repository: the owner switches it on and off in the project settings, the state is
// saved and shown after a reload, only the owner may change it, and a repository that is not PR-only is untouched.
test.describe.configure({ mode: 'serial' });

let projectId: string;
const repoName = 'toy';
let repoId: string;

const prOnlyRow = async () =>
  (await q<{ pr_only: boolean; pr_only_since: string | null }>(
    'SELECT pr_only, pr_only_since FROM project_repos WHERE id=$1',
    [repoId],
  ))[0];

test.beforeAll(async () => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const proj = await admin.post('/api/projects', { data: { key: 'PRO', name: 'PR only project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const add = await admin.post(`/api/projects/${projectId}/repos`, {
    data: { name: repoName, remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status(), await add.text()).toBe(201);
  repoId = (await add.json()).repos[0].id;
});

test('AC4: a new repository is not PR-only and nothing is queued for review', async () => {
  expect(await prOnlyRow()).toMatchObject({ pr_only: false, pr_only_since: null });
  const eligible = await q('SELECT 1 FROM pr_reviews WHERE project_repo_id=$1', [repoId]);
  expect(eligible).toHaveLength(0);
});

test('AC1/AC2: the owner turns PR-only on and off in the project settings; it survives a reload', async ({
  browser,
}) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const page = await (await browser.newContext({ storageState: await admin.storageState() })).newPage();
  await page.goto(`/projects/${projectId}/settings`);
  const toggle = page.getByTestId(`repo-pr-only-${repoName}`);
  const state = page.getByTestId(`repo-pr-only-state-${repoName}`);
  await expect(toggle).not.toBeChecked();
  await expect(state).toHaveText('Off');

  await toggle.click();
  await expect(state).toHaveText('On');
  await expect.poll(async () => (await prOnlyRow())?.pr_only).toBe(true);
  expect((await prOnlyRow())?.pr_only_since).not.toBeNull();

  await page.reload();
  await expect(page.getByTestId(`repo-pr-only-${repoName}`)).toBeChecked();
  await expect(page.getByTestId(`repo-pr-only-state-${repoName}`)).toHaveText('On');
  const dto = (await (await admin.get(`/api/projects/${projectId}`)).json()).repos;
  expect(JSON.stringify(dto)).toContain('"prOnly":true');

  await page.getByTestId(`repo-pr-only-${repoName}`).click();
  await expect(page.getByTestId(`repo-pr-only-state-${repoName}`)).toHaveText('Off');
  await expect.poll(async () => (await prOnlyRow())?.pr_only).toBe(false);
  await page.reload();
  await expect(page.getByTestId(`repo-pr-only-${repoName}`)).not.toBeChecked();
});

test('touch: the toggle is a labelled checkbox with a tall touch target on a phone-sized screen', async ({
  browser,
}) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const ctx = await browser.newContext({
    storageState: await admin.storageState(),
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await ctx.newPage();
  await page.goto(`/projects/${projectId}/settings`);
  const toggle = page.getByTestId(`repo-pr-only-${repoName}`);
  await toggle.scrollIntoViewIfNeeded();
  const box = await page.locator('label', { has: toggle }).boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  await page.locator('label', { has: toggle }).tap();
  await expect(page.getByTestId(`repo-pr-only-state-${repoName}`)).toHaveText('On');
  await expect.poll(async () => (await prOnlyRow())?.pr_only).toBe(true);
  await page.locator('label', { has: toggle }).tap();
  await expect.poll(async () => (await prOnlyRow())?.pr_only).toBe(false);
  await ctx.close();
});

test('AC5: a user who is not the owner is refused and the setting does not change', async () => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, GUEST);
  const guest = await apiAs(GUEST.email, GUEST.password);
  const res = await guest.patch(`/api/projects/${projectId}/repos/${repoId}`, { data: { prOnly: true } });
  expect([403, 404]).toContain(res.status());
  expect((await prOnlyRow())?.pr_only).toBe(false);
  // the owner's request is accepted through the same route, and a non-boolean is a 400
  expect(
    (await admin.patch(`/api/projects/${projectId}/repos/${repoId}`, { data: { prOnly: 'yes' } })).status(),
  ).toBe(400);
  const ok = await admin.patch(`/api/projects/${projectId}/repos/${repoId}`, { data: { prOnly: true } });
  expect(ok.status(), await ok.text()).toBe(200);
  expect((await prOnlyRow())?.pr_only).toBe(true);
  expect(
    (await admin.patch(`/api/projects/${projectId}/repos/${repoId}`, { data: { prOnly: false } })).status(),
  ).toBe(200);
  expect((await prOnlyRow())?.pr_only).toBe(false);
});
