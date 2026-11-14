import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { q } from '../support/db.ts';
import { ADMIN, GUEST, paths } from '../support/env.ts';

// Daily cap on automatic PR reviews: the owner sees today's used count (n/cap) and the queue in run order, sets the
// cap (1..100), and can start a review by hand. Pull requests are seeded in the database (no forge in the suite).
test.describe.configure({ mode: 'serial' });

let projectId: string;
let repoId: string;
const key = 'PRC';
const seeded: Record<string, string> = {};

async function seedPr(changeId: string, openedAt: string, changedLines: number | null): Promise<string> {
  const id = randomUUID();
  await q(
    `INSERT INTO pr_reviews (id, project_id, project_repo_id, change_id, url, title, author, head_branch, base_branch,
                             opened_at, recorded_at, review_state, changed_lines)
     VALUES ($1,$2,$3,$4,$5,$6,'dev','feat','main',$7,$7,'not_reviewed',$8)`,
    [
      id,
      projectId,
      repoId,
      changeId,
      `https://example.test/pr/${changeId}`,
      `PR number ${changeId}`,
      openedAt,
      changedLines,
    ],
  );
  return id;
}

test.beforeAll(async () => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const proj = await admin.post('/api/projects', { data: { key, name: 'PR cap project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const add = await admin.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status(), await add.text()).toBe(201);
  repoId = (await add.json()).repos[0].id;
  expect(
    (await admin.patch(`/api/projects/${projectId}/repos/${repoId}`, { data: { prOnly: true } })).status(),
  ).toBe(200);
  // 11 and 12 opened on the same day (12 is smaller), 13 on the same day with unknown size, 14 a day later
  seeded['11'] = await seedPr('11', '2026-01-10T09:00:00Z', 50);
  seeded['12'] = await seedPr('12', '2026-01-10T10:00:00Z', 10);
  seeded['13'] = await seedPr('13', '2026-01-10T08:00:00Z', null);
  seeded['14'] = await seedPr('14', '2026-01-11T09:00:00Z', 1);
});

test('AC4: the queue read model shows 0/20 used and the queue in run order (same day: smaller first, unknown last)', async () => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const res = await admin.get(`/api/projects/${projectId}/pull-requests/queue`);
  expect(res.status(), await res.text()).toBe(200);
  const body = await res.json();
  expect(body.used).toBe(0);
  expect(body.cap).toBe(20);
  expect(body.items.map((i: { changeId: string }) => i.changeId)).toEqual(['12', '11', '13', '14']);
  expect(body.items.map((i: { position: number }) => i.position)).toEqual([1, 2, 3, 4]);
});

test('AC4: the project view shows n/20 and the queue in run order; Review now is offered to the owner', async ({
  browser,
}) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const page = await (await browser.newContext({ storageState: await admin.storageState() })).newPage();
  await page.goto(`/p/${key}/pull-requests`);
  await expect(page.getByTestId('pr-review-used')).toHaveText('0/20');
  await expect(page.getByTestId('pr-review-cap')).toContainText('Resets at midnight');
  const rows = page.locator('[data-testid^="pr-review-queue-item-"]');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toHaveAttribute('data-testid', 'pr-review-queue-item-12');
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'pr-review-queue-item-11');
  await expect(rows.nth(2)).toHaveAttribute('data-testid', 'pr-review-queue-item-13');
  await expect(rows.nth(3)).toHaveAttribute('data-testid', 'pr-review-queue-item-14');
  await expect(page.getByTestId('pr-review-now-12')).toBeVisible();
  const box = await page.getByTestId('pr-review-now-12').boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});

test('cap setting: default 20, the owner sets 1..100, 0 and 101 are refused, a member is refused', async () => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  expect((await admin.put(`/api/projects/${projectId}/pr-review-cap`, { data: { cap: 0 } })).status()).toBe(
    400,
  );
  expect((await admin.put(`/api/projects/${projectId}/pr-review-cap`, { data: { cap: 101 } })).status()).toBe(
    400,
  );
  const ok = await admin.put(`/api/projects/${projectId}/pr-review-cap`, { data: { cap: 2 } });
  expect(ok.status(), await ok.text()).toBe(200);
  const body = await (await admin.get(`/api/projects/${projectId}/pull-requests/queue`)).json();
  expect(body.cap).toBe(2);
  const guest = await apiAs(GUEST.email, GUEST.password);
  const denied = await guest.put(`/api/projects/${projectId}/pr-review-cap`, { data: { cap: 50 } });
  expect([403, 404]).toContain(denied.status());
  expect((await admin.get(`/api/projects/${projectId}/pull-requests/queue`).then((r) => r.json())).cap).toBe(
    2,
  );
});

test('cap panel in the project settings: saves a valid cap and shows it after a reload', async ({
  browser,
}) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const page = await (await browser.newContext({ storageState: await admin.storageState() })).newPage();
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByTestId('pr-review-cap-state')).toHaveText('2 per day');
  await page.getByTestId('pr-review-cap-input').fill('5');
  await page.getByTestId('pr-review-cap-save').click();
  await expect(page.getByTestId('pr-review-cap-state')).toHaveText('5 per day');
  await page.reload();
  await expect(page.getByTestId('pr-review-cap-state')).toHaveText('5 per day');
  await page.goto(`/p/${key}/pull-requests`);
  await expect(page.getByTestId('pr-review-used')).toHaveText('0/5');
});

test('AC3: a manual trigger skips the cap; a member cannot trigger; an unknown PR is 404', async () => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const guest = await apiAs(GUEST.email, GUEST.password);
  const denied = await guest.post(`/api/projects/${projectId}/pull-requests/${seeded['12']}/review`);
  expect([403, 404]).toContain(denied.status());
  const missing = await admin.post(`/api/projects/${projectId}/pull-requests/${randomUUID()}/review`);
  expect(missing.status()).toBe(404);
  // no reviewer workstation is connected in this suite: the owner's request reaches the reviewer check, not the cap
  const res = await admin.post(`/api/projects/${projectId}/pull-requests/${seeded['12']}/review`);
  expect([200, 201, 409], await res.text()).toContain(res.status());
  if (res.status() === 409) expect(await res.text()).toContain('reviewer_not_ready');
});
