import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, BUDGETEER, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// Cost tracking and per-project budgets: the mock runtime reports synthetic usage (`fields.mockUsage`), shifts are
// priced at list prices, and a project over its monthly budget stops starting new shifts until the budget is raised
// or overridden. One owner, one mock runner, project BUD on the toy repo, a builder and a reviewer.
// Each shift of a card reports 1.5M input tokens: the builder runs Sonnet ($4.50 a shift) and the reviewer Opus ($7.50),
// so a card that is built and reviewed costs $12.00.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('budgeteer');
let page: Page;
let api: APIRequestContext;
let projectId: string;
let repoId: string;
let workstationId: string;

const SPEC = {
  context: 'The toy project needs a feature.',
  requirements: 'Add the thing to the toy project, with a small test.',
  acceptanceCriteria: ['It works', 'It is tested'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};
const USAGE = { inputTokens: 1_500_000, outputTokens: 0 };

async function createCard(title: string): Promise<string> {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'feature',
      repoId,
      completionAction: 'push_branch',
      fields: { ...SPEC, mockUsage: USAGE },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).card.ref as string;
}
const card = async (ref: string) =>
  (await q<{ stage: string; status: string }>('SELECT stage, status FROM cards WHERE ref=$1', [ref]))[0];
const inTest = (ref: string) =>
  waitFor(
    `${ref} in the test queue`,
    () => card(ref),
    (c) => c?.stage === 'test' && c.status === 'queued',
    120_000,
  );
const spendOf = async () =>
  Number(
    (
      await q<{ s: string }>(
        `SELECT COALESCE(sum(cost_usd_micros),0) AS s FROM shift_costs WHERE project_id=$1`,
        [projectId],
      )
    )[0]?.s,
  );

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, BUDGETEER);
  api = await apiAs(BUDGETEER.email, BUDGETEER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a runner, project BUD on the toy repo, a builder and a reviewer', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Budget Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '100' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () =>
      (await (await api.get('/api/workstations')).json()).workstations as Array<{
        id: string;
        connected: boolean;
      }>,
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0]?.id as string;
  const proj = await api.post('/api/projects', { data: { key: 'BUD', name: 'Budget project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const add = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status()).toBe(201);
  repoId = (await add.json()).repos[0].id;
  await waitFor(
    'the workstation holds the toy repo',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 1,
    30_000,
  );
  const devops = (await (await api.get('/api/agents')).json()).agents.find(
    (a: { isDevops: boolean }) => a.isDevops,
  );
  await api.patch(`/api/agents/${devops.id}`, { data: { runtime: 'mock', model: 'mock' } });
  for (const [name, roleKey, seniority] of [
    ['Bud', 'builder', 'junior'],
    ['Rev', 'reviewer', 'senior'],
  ] as const) {
    const r = await api.post('/api/agents', {
      data: { name, roleKey, seniority, workstationId, projectId, runtime: 'mock' },
    });
    expect(r.status(), await r.text()).toBe(201);
  }
});

test('the first card runs its two shifts: spend is recorded and shown on the project settings and the board', async () => {
  const ref = await createCard('Costly feature');
  await inTest(ref);
  // two shifts: the build on Sonnet ($4.50) and the review on Opus ($7.50)
  await waitFor('two shifts priced', spendOf, (s) => s === 12_000_000, 30_000);
  const cost = (
    await q<{ model: string; tokens_input: string }>(
      `SELECT model, tokens_input FROM shift_costs WHERE project_id=$1 ORDER BY ended_at LIMIT 1`,
      [projectId],
    )
  )[0];
  expect(Number(cost?.tokens_input)).toBe(1_500_000);

  await page.goto(`/projects/${projectId}/settings#budget`);
  await expect(page.getByTestId('budget-state')).toHaveText('No budget');
  await page.getByTestId('budget-input').fill('15');
  await page.getByTestId('budget-save').click();
  // $12 of $15 is 80%: the warning stage
  await expect(page.getByTestId('budget-state')).toHaveText('Near the limit');
  await expect(page.getByTestId('budget-spend-line')).toContainText('$12.00');
  await expect(page.getByRole('progressbar', { name: 'Spent this month' })).toHaveAttribute(
    'aria-valuenow',
    '80',
  );
  await page.goto('/p/BUD/board');
  await expect(page.getByTestId('board-spend')).toContainText('$12.00 of $15.00');
  await expect(page.getByTestId('budget-banner')).toContainText('$12.00 of $15.00');
});

test('80% notice: one desk item for the Owner, and a budget signal for the BA reporter', async () => {
  const items = await waitFor(
    'the 80% desk notice',
    () =>
      q<{ title: string; status: string }>(
        `SELECT title, status FROM desk_items WHERE subkind='budget_warning' AND title LIKE 'BUD %'`,
      ),
    (r) => r.length === 1,
    30_000,
  );
  expect(items[0]?.title).toMatch(/BUD has used 80% of its monthly budget/);
  await page.goto('/desk');
  await expect(page.getByText('BUD has used 80% of its monthly budget')).toBeVisible();
  // the reporter's detector turns it into a signal on its next sweep
  await waitFor(
    'a budget signal',
    () =>
      q<{ urgency: string }>(
        `SELECT urgency FROM ba_signals WHERE kind='budget' AND status <> 'resolved' AND fingerprint LIKE $1`,
        [`budget:${projectId}:%`],
      ),
    (r) => r.length === 1,
    90_000,
  );
});

test('100%: the project pauses, the board says so, nothing new starts; raise the budget and it carries on', async () => {
  // Cost is recorded when a shift ends, so a card's next stage can start just before the previous shift's cost
  // lands. The deterministic way to reach 100% is to set the budget to what is already spent ($12.00).
  await page.goto(`/projects/${projectId}/settings#budget`);
  await page.getByTestId('budget-input').fill('12');
  await page.getByTestId('budget-save').click();
  await expect(page.getByTestId('budget-state')).toHaveText('Paused');
  const ref = await createCard('Waits for the budget');
  await page.goto('/p/BUD/board');
  const banner = page.getByTestId('budget-banner');
  await expect(banner).toContainText('is paused');
  await shot('board-paused');
  await expect(banner.getByTestId('budget-raise')).toBeVisible();
  await expect(banner.getByTestId('budget-override')).toBeVisible();
  const desk = await waitFor(
    'the pause desk item',
    () =>
      q<{ title: string }>(
        `SELECT title FROM desk_items WHERE subkind='budget_paused' AND status='open' AND title LIKE 'BUD %'`,
      ),
    (r) => r.length === 1,
    30_000,
  );
  expect(desk[0]?.title).toMatch(/BUD is paused/);
  // a few dispatcher passes later the card has not started and nothing more was spent
  await new Promise((r) => setTimeout(r, 12_000));
  const waiting = await card(ref);
  expect([waiting?.stage, waiting?.status]).toEqual(['build', 'queued']);
  expect(await spendOf()).toBe(12_000_000);
  // the desk item offers both ways out
  await page.goto('/desk');
  const item = page.locator('[data-testid^="desk-item-"]').filter({ hasText: 'BUD is paused' });
  await expect(item.getByRole('button', { name: 'Raise budget' })).toBeVisible();
  await expect(item.getByRole('button', { name: 'Override for this month' })).toBeVisible();
  // raise the budget in the project settings: the card builds and is reviewed
  await item.getByRole('button', { name: 'Raise budget' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/settings`));
  await expect(page.getByTestId('budget-state')).toHaveText('Paused');
  await page.getByTestId('budget-input').fill('50');
  await page.getByTestId('budget-save').click();
  await expect(page.getByTestId('budget-state')).toHaveText('On track');
  await inTest(ref);
  await waitFor('both shifts priced', spendOf, (s) => s === 24_000_000, 30_000);
  await waitFor(
    'the desk item closed',
    () =>
      q<{ status: string }>(
        `SELECT status FROM desk_items WHERE subkind='budget_paused' AND title LIKE 'BUD %'`,
      ),
    (r) => r[0]?.status !== 'open',
    30_000,
  );
});

test('override for this month: a used-up budget dispatches again', async () => {
  // lower the budget below the spend: paused at once
  await page.goto(`/projects/${projectId}/settings#budget`);
  await page.getByTestId('budget-input').fill('20');
  await page.getByTestId('budget-save').click();
  await expect(page.getByTestId('budget-state')).toHaveText('Paused');
  const ref = await createCard('After the override');
  await new Promise((r) => setTimeout(r, 8_000));
  expect((await card(ref))?.status).toBe('queued');
  expect((await card(ref))?.stage).toBe('build');
  await page.goto('/p/BUD/board');
  await page.getByTestId('budget-override').click();
  await expect(page.getByTestId('budget-banner')).toContainText('overridden');
  await inTest(ref);
  await waitFor('all three cards priced', spendOf, (s) => s === 36_000_000, 30_000);
});

const SHOTS = process.env.AOM_E2E_SHOT_DIR;
const shot = (name: string) =>
  SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : undefined;

test('the Costs page: breakdown by project, agent, model and day, and a CSV export', async () => {
  await page.goto('/costs');
  await expect(page.getByRole('heading', { name: 'Costs' })).toBeVisible();
  await expect(page.getByTestId('costs-total')).toContainText('$36.00');
  await shot('costs');
  await expect(page.getByTestId('costs-total')).toContainText('$36.00');
  const row = page.getByTestId('costs-project-row').filter({ hasText: 'BUD' });
  await expect(row).toContainText('$36.00');
  await expect(row.getByTestId('budget-meter')).toBeVisible();
  await expect(page.getByTestId('costs-by-agent')).toContainText('Bud');
  await expect(page.getByTestId('costs-by-agent')).toContainText('Rev');
  await expect(page.getByTestId('costs-by-model')).toContainText(/sonnet/i);
  await expect(page.getByTestId('costs-by-model')).toContainText(/opus/i);
  await expect(page.getByTestId('cost-days')).toBeVisible();
  const href = (await page.getByTestId('costs-export').getAttribute('href')) as string;
  const csv = await api.get(href);
  expect(csv.status()).toBe(200);
  expect(csv.headers()['content-type']).toContain('text/csv');
  const text = await csv.text();
  expect(text.split('\n')[0]).toBe(
    'date,project,agent,model,shifts,input,output,cache_read,cache_write,cost',
  );
  // three builds by Bud on Sonnet at $4.50 and three reviews by Rev on Opus at $7.50
  expect(text).toMatch(/,BUD,Bud,sonnet,3,4500000,0,0,0,13\.5000\n/);
  expect(text).toMatch(/,BUD,Rev,opus,3,4500000,0,0,0,22\.5000\n/);
});

test('the HR board shows what each agent cost this month; the floor report has a spend section', async () => {
  await page.goto('/agents');
  await expect(page.getByTestId('agent-Bud').getByTestId('agent-spend')).toContainText('$');
  const digest = (await (await api.get('/api/desk')).json()).items.find(
    (i: { subkind?: string }) => i.subkind === 'floor_report',
  );
  if (digest) expect(digest.floor.spend.currency).toBe('USD');
});
