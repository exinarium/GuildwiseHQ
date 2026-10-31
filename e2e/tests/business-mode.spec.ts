import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q } from '../support/db.ts';
import { ADMIN, BASE_URL, MODESW, paths } from '../support/env.ts';
import { pairRunner } from '../support/runner.ts';

// Business mode (organization mode flag): a dev organization with a repository and a builder cannot switch; once both
// are gone it switches, the delivery surfaces leave the app (direct URLs show "not available"), the server refuses the
// dev-only actions, and switching back to Developer mode shows everything again. Standalone: one user, a paired mock
// workstation (no runner process), project BIZ on the toy repo.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('business-mode');
let page: Page;
let api: APIRequestContext;
let orgId: string;
let projectId: string;
let repoId: string;
let workstationId: string;

const modeEvents = () =>
  q<{ payload: { mode: string; previous: string; by: string } }>(
    `SELECT payload FROM events WHERE type='OrgModeSet' AND payload->>'orgId'=$1 ORDER BY seq`,
    [orgId],
  );

async function openGeneral(): Promise<void> {
  await page.goto('/settings/org');
  await expect(page.getByTestId('org-mode-panel')).toBeVisible();
}

async function hireRoleOptions(): Promise<string[]> {
  await page.goto('/agents');
  await page.getByRole('button', { name: 'Hire agent' }).first().click();
  const form = page.getByRole('form', { name: 'Hire agent' });
  const role = form.getByLabel('Role');
  await expect(role.locator('option').first()).toBeAttached();
  const options = await role.locator('option').allInnerTexts();
  await page.keyboard.press('Escape');
  return options;
}

const hire = (name: string, roleKey: string) =>
  api.post('/api/agents', {
    data: { name, roleKey, seniority: 'junior', workstationId, runtime: 'mock' },
  });

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, MODESW);
  api = await apiAs(MODESW.email, MODESW.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  orgId = (await (await api.get('/api/org')).json()).id;
});

test('setup: a new organization is in Developer mode; project BIZ with a repository and a builder', async () => {
  const org = await (await api.get('/api/org')).json();
  expect(org.mode).toBe('dev');
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Mode PC', HOME);
  workstationId = ((await (await api.get('/api/workstations')).json()).workstations as any[])[0].id;
  const proj = await api.post('/api/projects', { data: { key: 'BIZ', name: 'Business switch' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const add = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status(), await add.text()).toBe(201);
  repoId = (await add.json()).repos[0].id;
  const h = await hire('Kenji', 'builder');
  expect(h.status(), await h.text()).toBe(201);
  // Developer mode shows the delivery surfaces as before
  await page.goto('/projects');
  await expect(page.getByTestId('nav-releases')).toBeVisible();
});

test('switching to Business mode is refused and lists the repository and the builder', async () => {
  await openGeneral();
  await page.getByTestId('org-mode-business').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Switch to Business mode' }).click();
  const blocked = page.getByTestId('org-mode-blocked');
  await expect(blocked).toBeVisible();
  await expect(blocked).toContainText('Repository toy (project BIZ)');
  await expect(blocked).toContainText('Kenji (builder)');
  expect((await (await api.get('/api/org')).json()).mode).toBe('dev');
  expect(await modeEvents()).toHaveLength(0);
});

test('with the repository and the builder gone it switches, and the event is recorded', async () => {
  const agents = (await (await api.get('/api/agents')).json()).agents as any[];
  const kenji = agents.find((a) => a.name === 'Kenji');
  expect((await api.post(`/api/agents/${kenji.id}/fire`, { data: {} })).ok()).toBeTruthy();
  const del = await api.delete(`/api/projects/${projectId}/repos/${repoId}`);
  expect(del.ok(), await del.text()).toBeTruthy();

  await openGeneral();
  await page.getByTestId('org-mode-business').check();
  await page.getByRole('dialog').getByRole('button', { name: 'Switch to Business mode' }).click();
  await expect(page.getByText('Business mode is on')).toBeVisible();
  await expect(page.getByTestId('org-mode-business')).toBeChecked();
  expect((await (await api.get('/api/org')).json()).mode).toBe('business');
  const events = await modeEvents();
  expect(events.map((e) => e.payload)).toEqual([
    expect.objectContaining({ mode: 'business', previous: 'dev' }),
  ]);
});

test('in Business mode the delivery surfaces are gone and direct URLs show "not available"', async () => {
  await page.goto('/projects');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByTestId('nav-releases')).toHaveCount(0);
  await expect(page.getByTestId('ask-devops-button')).toHaveCount(0);
  for (const url of ['/releases', '/p/BIZ/environments']) {
    await page.goto(url);
    await expect(page.getByTestId('not-available-business')).toBeVisible();
  }

  const roles = await hireRoleOptions();
  expect(roles.length).toBeGreaterThan(0);
  for (const dev of ['Builder', 'Reviewer', 'Tester', 'DevOps engineer']) expect(roles).not.toContain(dev);

  await page.goto('/settings/capabilities?tab=packs');
  await expect(page.getByRole('tabpanel')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a pack by git URL' })).toHaveCount(0);

  await page.goto('/automations');
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const wizard = page.getByTestId('schedule-wizard');
  await wizard.getByTestId('wizard-next').click();
  await expect(wizard.getByTestId('tile-create_card')).toBeVisible();
  await expect(wizard.getByTestId('tile-devops_request')).toHaveCount(0);
  await expect(wizard.getByTestId('tile-regression_run')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('in Business mode the server refuses a repository, dev hires and a pack by git URL with a readable 409', async () => {
  const repo = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(repo.status(), await repo.text()).toBe(409);
  expect((await repo.json()).error).toMatchObject({ code: 'business_mode' });
  expect((await repo.json()).error.message).toMatch(/Business mode/);
  for (const roleKey of ['builder', 'reviewer', 'tester', 'devops']) {
    const r = await hire(`Dev ${roleKey}`, roleKey);
    expect(r.status(), `${roleKey}: ${await r.text()}`).toBe(409);
    expect((await r.json()).error.code).toBe('business_mode');
  }
  const pack = await api.post('/api/packs', {
    data: { url: 'https://github.com/acme/skills.git', ref: 'v1' },
  });
  expect(pack.status(), await pack.text()).toBe(409);
  expect((await pack.json()).error.message).toMatch(/git URL/);
  // a business role is still hired
  const ok = await hire('Anna', 'architect');
  expect(ok.status(), await ok.text()).toBe(201);
});

test('switching back to Developer mode always works and shows every surface again', async () => {
  await openGeneral();
  await page.getByTestId('org-mode-dev').check();
  await expect(page.getByText('Developer mode is on')).toBeVisible();
  expect((await (await api.get('/api/org')).json()).mode).toBe('dev');
  expect((await modeEvents()).at(-1)?.payload).toMatchObject({ mode: 'dev', previous: 'business' });

  await page.goto('/projects');
  await expect(page.getByTestId('nav-releases')).toBeVisible();
  await page.goto('/releases');
  await expect(page.getByTestId('not-available-business')).toHaveCount(0);
  await page.goto('/p/BIZ/environments');
  await expect(page.getByTestId('not-available-business')).toHaveCount(0);
  expect(await hireRoleOptions()).toContain('Builder');
  // nothing was lost: Anna is still there, and a repository can be added again
  const agents = (await (await api.get('/api/agents')).json()).agents as any[];
  expect(agents.map((a) => a.name)).toContain('Anna');
  const repo = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy2', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(repo.status(), await repo.text()).toBe(201);
});
