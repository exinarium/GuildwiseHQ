import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { waitFor } from '../support/db.ts';
import { ADMIN, ALLOWER, BASE_URL, paths } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';

// Part A of the restructure: agents belong to the organization; the manager decides per agent where it may work
// (an allow-list or any project), which projects it prefers, and a project may cap the shifts running at once.
// One user and one mock runner (the Hire form lists the runtimes a connected workstation reports).
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('allower');
let page: Page;
let api: APIRequestContext;
let alpha: string;
let beta: string;

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, ALLOWER);
  api = await apiAs(ALLOWER.email, ALLOWER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Allower Box', HOME);
  startRunner({}, HOME);
  await waitFor(
    'workstation connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0],
    (w) => w?.connected === true,
    30_000,
  );
  for (const [key, name] of [
    ['ALA', 'Alpha'],
    ['ALB', 'Beta'],
  ] as const) {
    const p = await api.post('/api/projects', { data: { key, name, workflowKey: 'code' } });
    expect(p.status(), await p.text()).toBe(201);
    const id = (await p.json()).project.id as string;
    if (key === 'ALA') alpha = id;
    else beta = id;
  }
});

test('hire an agent for two projects and prefer one: the card shows where it works', async () => {
  await page.goto('/agents');
  await page.getByRole('button', { name: 'Hire agent' }).first().click();
  const form = page.getByRole('form', { name: 'Hire agent' });
  await form.getByLabel('Runtime').selectOption('mock');
  await form.getByLabel('Name', { exact: true }).fill('Alba');
  await form.getByRole('button', { name: 'Selected projects' }).click();
  await form.getByRole('checkbox', { name: 'Allow ALA' }).check();
  await form.getByRole('checkbox', { name: 'Allow ALB' }).check();
  await form.getByRole('button', { name: 'Prefer ALB' }).click();
  await form.getByRole('button', { name: 'Hire', exact: true }).click();
  const card = page.getByTestId('agent-Alba');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('agent-works-on')).toContainText('ALA');
  await expect(card.getByTestId('agent-works-on')).toContainText('ALB');

  const agents = (await (await api.get('/api/agents')).json()).agents as Array<{
    name: string;
    allowedProjectIds: string[] | null;
    focusProjectIds: string[];
  }>;
  const alba = agents.find((a) => a.name === 'Alba');
  expect(alba?.allowedProjectIds?.sort()).toEqual([alpha, beta].sort());
  expect(alba?.focusProjectIds).toEqual([beta]);
});

test('change the allow-list in the dialog: only one project, then any project', async () => {
  const card = page.getByTestId('agent-Alba');
  await card.getByRole('button', { name: 'Allowed projects of Alba' }).click();
  const dialog = page.getByRole('form', { name: 'Allowed projects' });
  await dialog.getByRole('checkbox', { name: 'Allow ALB' }).uncheck();
  await dialog.getByTestId('allowed-save').click();
  await expect(card.getByTestId('agent-works-on')).not.toContainText('ALB');
  await expect(card.getByTestId('agent-works-on')).toContainText('ALA');
  // the project left the focus together with the allow-list
  const one = (await (await api.get('/api/agents')).json()).agents.find(
    (a: { name: string }) => a.name === 'Alba',
  );
  expect(one.focusProjectIds).toEqual([]);

  await card.getByRole('button', { name: 'Allowed projects of Alba' }).click();
  await page
    .getByRole('form', { name: 'Allowed projects' })
    .getByRole('button', { name: 'Any project' })
    .click();
  await page.getByTestId('allowed-save').click();
  await expect(card.getByTestId('agent-works-on')).toContainText('any project');
});

test('project settings: the simultaneous-shifts limit is off, set to 2, then removed', async () => {
  await page.goto(`/projects/${alpha}/settings`);
  await expect(page.getByTestId('concurrency-state')).toHaveText('No limit');
  await page.getByTestId('concurrency-input').fill('2');
  await page.getByTestId('concurrency-save').click();
  await expect(page.getByTestId('concurrency-state')).toHaveText('At most 2 at once');
  await page.reload();
  await expect(page.getByTestId('concurrency-state')).toHaveText('At most 2 at once');
  await page.getByTestId('concurrency-clear').click();
  await expect(page.getByTestId('concurrency-state')).toHaveText('No limit');
});
