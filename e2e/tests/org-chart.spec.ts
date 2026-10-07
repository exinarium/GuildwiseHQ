import AxeBuilder from '@axe-core/playwright';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { BUDGETEER } from '../support/env.ts';

// Organization, Org chart: roles and seniority as a tree, the escalation lines (a senior of the role, then the BA,
// then the manager), faces with status and workstation, grouping by department, the project filter, the agent card
// and the DevOps engineer of each workstation shown apart. Uses the budgets spec's owner, runner and agents.
test.describe.configure({ mode: 'serial' });

/** One agent's tile (by exact name: the owner's name also contains "Bud"). */
const tile = (page: Page, name: string, within = 'org-chart') =>
  page.getByTestId(within).locator(`[data-testid="org-agent"][data-agent="${name}"]`);

let page: Page;
let api: APIRequestContext;
let workstationId: string;
let budId: string;
let otherId: string;

test.beforeAll(async ({ browser }) => {
  api = await apiAs(BUDGETEER.email, BUDGETEER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  workstationId = (await (await api.get('/api/workstations')).json()).workstations[0].id;
  budId = (await (await api.get('/api/projects')).json()).projects.find(
    (p: { key: string }) => p.key === 'BUD',
  ).id;
  const other = await api.post('/api/projects', { data: { key: 'ORG', name: 'Chart project' } });
  expect(other.status(), await other.text()).toBe(201);
  otherId = (await other.json()).project.id;
  for (const [name, roleKey, seniority, projectId] of [
    ['Bea', 'ba', 'senior', budId],
    ['Sam', 'builder', 'senior', otherId],
  ] as const) {
    const r = await api.post('/api/agents', {
      data: { name, roleKey, seniority, workstationId, projectId, runtime: 'mock' },
    });
    expect(r.status(), await r.text()).toBe(201);
  }
});

test('the chart shows the manager, the BA, the departments and every agent with a face and a status', async () => {
  await page.goto('/org-chart');
  await expect(page.getByRole('heading', { name: 'Org chart' })).toBeVisible();
  await expect(page.getByTestId('org-manager')).toContainText('Owner, the manager');
  await expect(page.getByTestId('org-chart')).toBeVisible();
  for (const name of ['Bea', 'Bud', 'Rev', 'Sam']) {
    const t = tile(page, name);
    await expect(t, name).toBeVisible();
    await expect(t.getByTestId('face')).toBeVisible();
  }
  await expect(page.getByTestId('org-chart').getByTestId('org-department').first()).toBeVisible();
  // escalation lines exist for juniors (to the senior), seniors (to the BA) and the BA (to the manager)
  await expect(page.locator('[data-edge="peer"]').first()).toBeAttached();
  await expect(page.locator('[data-edge="ba"]').first()).toBeAttached();
  await expect(page.locator('[data-edge="desk"]').first()).toBeAttached();
  // the junior builder's label says where its questions go
  const bud = tile(page, 'Bud');
  await expect(bud).toHaveAttribute('aria-label', /Escalates to Sam \(senior builder\)/);
  const sam = tile(page, 'Sam');
  await expect(sam).toHaveAttribute('aria-label', /Escalates to the BA \(Bea\)/);
  await expect(page.getByTestId('org-summary')).toContainText('agents');
});

// AOM_E2E_SHOT_DIR=<dir> keeps a screenshot of each screen for eyeballing (never part of the pass/fail).
const SHOTS = process.env.AOM_E2E_SHOT_DIR;
const shot = (p: Page, name: string) =>
  SHOTS ? p.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined;

test('the DevOps engineer of the workstation is shown apart from the chart', async () => {
  await shot(page, 'org-chart');
  const panel = page.getByTestId('org-devops');
  await expect(panel).toContainText('Budget Box');
  await expect(panel.getByTestId('org-agent')).toHaveCount(1);
  await expect(
    page.getByTestId('org-chart').getByTestId('org-agent').filter({ hasText: 'DevOps' }),
  ).toHaveCount(0);
});

test('filter by project: an agent allowed only elsewhere leaves the chart', async () => {
  await page.getByTestId('org-project-filter').selectOption({ label: 'ORG Chart project' });
  const chart = page.getByTestId('org-chart');
  await expect(tile(page, 'Sam')).toHaveCount(1);
  await expect(tile(page, 'Bud')).toHaveCount(0);
  await expect(tile(page, 'Rev')).toHaveCount(0);
  await page.getByTestId('org-project-filter').selectOption({ label: 'All projects' });
  await expect(tile(page, 'Bud')).toHaveCount(1);
});

test('click an agent: its card shows where it may work, who it reports to, its spend and recent work', async () => {
  await tile(page, 'Bud').click();
  const card = page.getByTestId('org-agent-card');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('org-agent-allowed')).toContainText('BUD');
  await expect(card).toContainText('Reports to');
  await expect(card).toContainText('E2E Budgeteer');
  await expect(card.getByTestId('org-agent-spend')).toContainText('$');
  await expect(card.getByTestId('org-agent-recent').getByRole('link').first()).toBeVisible();
  await shot(page, 'org-chart-card');
  await page.keyboard.press('Escape');
  await expect(card).toHaveCount(0);
});

test('the list view says the same in words and is the mobile layout; no serious accessibility violations', async () => {
  await page
    .getByRole('radio', { name: 'List' })
    .or(page.getByRole('button', { name: 'List' }))
    .first()
    .click();
  const list = page.getByTestId('org-list');
  await expect(list).toBeVisible();
  await expect(list).toContainText('Escalates to');
  const results = await new AxeBuilder({ page }).include('main').analyze();
  expect(results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')).toEqual([]);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/org-chart');
  await expect(page.getByTestId('org-list')).toBeVisible();
  await shot(page, 'org-chart-mobile');
  const overflow = await page.evaluate(() => {
    const g = globalThis as unknown as {
      document: { documentElement: { scrollWidth: number } };
      innerWidth: number;
    };
    return g.document.documentElement.scrollWidth - g.innerWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
  await page.setViewportSize({ width: 1280, height: 800 });
});

test('the sidebar lists Org chart under Organization', async () => {
  await page.goto('/agents');
  await expect(page.getByRole('link', { name: 'Org chart' })).toBeVisible();
  await page.getByRole('link', { name: 'Org chart' }).click();
  await expect(page).toHaveURL(/\/org-chart$/);
});
