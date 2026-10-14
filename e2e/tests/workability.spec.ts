import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, paths, WORKER } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// "Not workable" warning: a project with ONE senior reviewer cannot review a large-tier card twice. The card sits in
// Review after the first approval; the board tile and the card page say why and link to the Hire form, and hiring a
// second senior reviewer clears the warning live and lets the card move on.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('workability');
let api: APIRequestContext;
let page: Page;
let workstationId: string;
let projectId: string;
let repoId: string;

const SPEC = {
  context: 'The toy project needs a feature.',
  requirements: 'Add the thing to the toy project, with a small test.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, WORKER);
  api = await apiAs(WORKER.email, WORKER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a paired mock runner, project WRK, a builder and one senior reviewer', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Work Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '300' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id;
  const proj = await api.post('/api/projects', { data: { key: 'WRK', name: 'Workability project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  // The Test step runs only when the project switched integration tests on (this runner announces no test environments,
  // so the tester works from the card's test plan as before).
  expect(
    (
      await api.put(`/api/projects/${projectId}/integration-tests`, { data: { settings: { mode: 'local' } } })
    ).status(),
  ).toBe(200);
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
  const devops = (await (await api.get('/api/agents')).json()).agents.find((a: any) => a.isDevops);
  expect(
    (await api.patch(`/api/agents/${devops.id}`, { data: { runtime: 'mock', model: 'mock' } })).status(),
  ).toBe(200);
  for (const [name, roleKey, seniority] of [
    ['Bo', 'builder', 'junior'],
    ['Rae', 'reviewer', 'senior'],
  ] as const) {
    const hire = await api.post('/api/agents', {
      data: { name, roleKey, seniority, workstationId, projectId, runtime: 'mock' },
    });
    expect(hire.status(), await hire.text()).toBe(201);
  }
});

test('a large card with one senior reviewer: warning on the tile and the card with the reason, Hire form prefilled; hiring a second reviewer clears it live', async () => {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title: 'A large change',
      cardType: 'feature',
      repoId,
      completionAction: 'push_branch',
      fields: SPEC,
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const created = (await res.json()).card;
  // the risk tier is the manager's call: large needs two different senior reviewers
  const risk = await api.patch(`/api/cards/${created.id}`, {
    data: { riskTier: 'large', reason: 'Touches the core' },
  });
  expect(risk.status(), await risk.text()).toBe(200);

  await waitFor(
    'the first review approved, the second one unclaimed',
    () =>
      q<{ stage: string; status: string; review_approvals: number }>('SELECT * FROM cards WHERE id=$1', [
        created.id,
      ]),
    (r) => r[0]?.stage === 'review' && r[0].status === 'queued' && Number(r[0].review_approvals) === 1,
    120_000,
  );

  await page.goto('/p/WRK/board');
  const tile = page.getByTestId('column-Review').getByTestId(`card-tile-${created.ref}`);
  await expect(tile).toBeVisible();
  const warning = page.getByTestId('column-Review').getByTestId('workability-warning');
  await expect(warning).toHaveAttribute('data-level', 'blocked');
  await expect(warning).toBeVisible();
  await expect(warning).toContainText(
    'Not workable: this large change needs a second senior reviewer other than Rae. Hire another senior reviewer.',
  );

  // the card page says the same
  await page.goto(`/cards/${created.ref}`);
  await expect(page.getByTestId('workability-warning')).toContainText(
    'second senior reviewer other than Rae',
  );

  // the link opens the Hire form with the missing role prefilled
  await page.getByTestId('workability-hire').click();
  await expect(page).toHaveURL(/\/agents\?hire=reviewer&seniority=senior&projectId=/);
  const form = page.getByRole('form', { name: 'Hire agent' });
  await expect(form.getByLabel('Role')).toHaveValue('reviewer');
  await expect(form.getByLabel('Seniority')).toHaveValue('senior');

  // hiring another senior reviewer: the open board updates without a reload and the card moves on
  await page.goto('/p/WRK/board');
  await expect(page.getByTestId('workability-warning')).toHaveCount(1);
  const hire = await api.post('/api/agents', {
    data: {
      name: 'Ria',
      roleKey: 'reviewer',
      seniority: 'senior',
      workstationId,
      projectId,
      runtime: 'mock',
    },
  });
  expect(hire.status(), await hire.text()).toBe(201);
  await expect(page.getByTestId('workability-warning')).toHaveCount(0);
  await waitFor(
    'the second approval',
    () => q<{ stage: string }>('SELECT stage FROM cards WHERE id=$1', [created.id]),
    (r) => r[0]?.stage === 'test',
    120_000,
  );
});
