import { expect, test } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { ADMIN, paths } from '../support/env.ts';

// AC1: without a recorded replay the owner cannot switch the second (Opus) reviewer on, in the settings or by the API.
let projectId: string;

test.beforeAll(async () => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const proj = await admin.post('/api/projects', { data: { key: 'SRV', name: 'Second reviewer project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const add = await admin.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status(), await add.text()).toBe(201);
  const repoId = (await add.json()).repos[0].id;
  const on = await admin.patch(`/api/projects/${projectId}/repos/${repoId}`, { data: { prOnly: true } });
  expect(on.status(), await on.text()).toBe(200);
});

test('AC1: no recorded replay: the switch is refused with replay_required and the settings show it', async ({
  browser,
}) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  const res = await admin.put(`/api/projects/${projectId}/second-reviewer`, { data: { enabled: true } });
  expect(res.status(), await res.text()).toBe(409);
  expect(await res.text()).toContain('replay_required');

  const page = await (await browser.newContext({ storageState: await admin.storageState() })).newPage();
  await page.goto(`/projects/${projectId}/settings`);
  await expect(page.getByTestId('second-reviewer-panel')).toBeVisible();
  await expect(page.getByTestId('second-reviewer-replay-required')).toBeVisible();
  await expect(page.getByTestId('second-reviewer-switch')).toBeDisabled();
});
