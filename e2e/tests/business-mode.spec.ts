import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q } from '../support/db.ts';
import { ADMIN, BASE_URL, MODESW, paths } from '../support/env.ts';
import { pairRunner } from '../support/runner.ts';

// Views: Software and Business are presentation only. The organization holds a default view; each member can override
// it from the user menu. Switching is instant and never refused (even with a repository and a builder), changes no
// data, hides only test environments and releases (direct URLs show a gentle "switch to Software view" note), keeps
// workstations and Ask DevOps, and the server refuses nothing in either view. Standalone: one user, a paired mock
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

const viewEvents = () =>
  q<{ type: string }>(`SELECT type FROM events WHERE type='OrgMemberViewSet' AND payload->>'orgId'=$1`, [
    orgId,
  ]);

/** Picks a view from the user menu (the toggle is one click away from anywhere). */
async function pickView(id: 'dev' | 'business' | 'default'): Promise<void> {
  await page.getByTestId('user-menu').first().click();
  await page.getByTestId(`view-${id}`).click();
  await page.keyboard.press('Escape');
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

const hire = (name: string, roleKey: string, seniority = 'junior') =>
  api.post('/api/agents', {
    data: { name, roleKey, seniority, workstationId, runtime: 'mock' },
  });

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, MODESW);
  api = await apiAs(MODESW.email, MODESW.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  orgId = (await (await api.get('/api/org')).json()).id;
});

test('setup: a new organization defaults to the Software view; project BIZ with a repository and a builder', async () => {
  const org = await (await api.get('/api/org')).json();
  expect(org.mode).toBe('dev');
  expect(org.viewOverride).toBeNull();
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
  await page.goto('/projects');
  await expect(page.getByTestId('nav-releases')).toBeVisible();
});

test('the default view switches to Business at once although a repository and a builder exist, and only the preference is recorded', async () => {
  const before = (await (await api.get('/api/agents')).json()).agents.length;
  await openGeneral();
  await page.getByTestId('org-mode-business').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Make Business view the default' }).click();
  await expect(page.getByText('The default view is now the Business view')).toBeVisible();
  await expect(page.getByTestId('org-mode-business')).toBeChecked();
  expect((await (await api.get('/api/org')).json()).mode).toBe('business');
  expect(await modeEvents()).toEqual([
    expect.objectContaining({ payload: expect.objectContaining({ mode: 'business', previous: 'dev' }) }),
  ]);
  // nothing else changed
  expect((await (await api.get('/api/agents')).json()).agents.length).toBe(before);
  const repos = (await (await api.get(`/api/projects/${projectId}`)).json()).repos as any[];
  expect(repos.filter((r) => !r.removedAt)).toHaveLength(1);
});

test('in the Business view test environments and releases are tucked away with a gentle note; workstations and Ask for technical help stay', async () => {
  await page.goto('/projects');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByTestId('nav-releases')).toHaveCount(0);
  await expect(page.getByTestId('nav-organization')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Workstations' }).first()).toBeVisible();
  await expect(page.getByTestId('ask-devops-button')).toBeVisible();
  await expect(page.getByTestId('ask-devops-button')).toHaveAttribute('aria-label', 'Ask for technical help');
  for (const url of ['/delivery/releases', '/p/BIZ/environments']) {
    await page.goto(url);
    await expect(page.getByTestId('not-available-business')).toContainText(
      'Switch to Software view to see this',
    );
  }
  await page.goto('/workstations');
  await expect(page.getByText('Mode PC').first()).toBeVisible();

  // developer roles are under More, not removed
  const roles = await hireRoleOptions();
  for (const dev of ['Builder', 'Reviewer', 'Tester']) expect(roles).toContain(dev);

  await page.goto('/settings/capabilities?tab=packs');
  await expect(page.getByRole('button', { name: 'Add a pack by git URL' })).toBeVisible();

  await page.goto('/automations');
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const wizard = page.getByTestId('schedule-wizard');
  await page.getByTestId('wizard-next').click();
  await expect(wizard.getByTestId('tile-create_card')).toBeVisible();
  await wizard.getByTestId('more-actions').locator('summary').click();
  await expect(wizard.getByTestId('tile-devops_request')).toBeVisible();
  await expect(wizard.getByTestId('tile-regression_run')).toBeVisible();
  await page.keyboard.press('Escape');
});

test('a Business-view user can still do every software action on the server', async () => {
  const repo = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy2', remoteUrl: 'https://github.com/acme/toy2.git', workingBranch: 'main' }, // the first one is already added
  });
  expect(repo.status(), await repo.text()).toBe(201);
  for (const roleKey of ['reviewer', 'tester']) {
    const r = await hire(`Dev ${roleKey}`, roleKey, 'senior'); // the Reviewer and Tester are only available as senior
    expect(r.status(), `${roleKey}: ${await r.text()}`).toBe(201);
  }
  expect((await hire('Anna', 'architect', 'senior')).status()).toBe(201);
});

test('a member override beats the organization default, from the user menu, and the event is only the preference', async () => {
  const seq = Number((await q<{ s: number }>('SELECT max(seq) AS s FROM events'))[0]?.s);
  await page.goto('/projects');
  await pickView('dev');
  await expect(page.getByTestId('nav-releases')).toBeVisible();
  await page.goto('/delivery/releases');
  await expect(page.getByTestId('not-available-business')).toHaveCount(0);
  expect((await (await api.get('/api/org')).json()).viewOverride).toBe('dev');
  expect((await (await api.get('/api/org')).json()).mode).toBe('business');
  const types = await q<{ type: string }>('SELECT type FROM events WHERE seq > $1', [seq]);
  expect(types.map((t) => t.type)).toEqual(['OrgMemberViewSet']);
  await pickView('default');
  await expect(page.getByTestId('nav-releases')).toHaveCount(0);
  expect((await viewEvents()).length).toBe(2);
});

test('switching the default back to the Software view always works and shows every surface again', async () => {
  await openGeneral();
  await page.getByTestId('org-mode-dev').click();
  await expect(page.getByText('The default view is now the Software view')).toBeVisible();
  expect((await (await api.get('/api/org')).json()).mode).toBe('dev');
  expect((await modeEvents()).at(-1)?.payload).toMatchObject({ mode: 'dev', previous: 'business' });

  await page.goto('/projects');
  await expect(page.getByTestId('nav-releases')).toBeVisible();
  await page.goto('/delivery/releases');
  await expect(page.getByTestId('not-available-business')).toHaveCount(0);
  await page.goto('/p/BIZ/environments');
  await expect(page.getByTestId('not-available-business')).toHaveCount(0);
  expect(await hireRoleOptions()).toContain('Builder');
  const agents = (await (await api.get('/api/agents')).json()).agents as any[];
  expect(agents.map((a) => a.name)).toContain('Anna');
});
