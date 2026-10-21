import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, paths, STEPPER } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// Guided run steps and "Scan with DevOps" (docs/design/deploy-run-ux-design.md, v1a): a person with no coding knowledge sets
// up how to start the app through templates, a mock DevOps engineer scans the project read-only and proposes steps, the
// person answers one question and confirms. Standalone: one user, one runner (mock runtime), project RST on the toy repo.
// No Claude, Docker or GitHub is contacted.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('run-steps');
let page: Page;
let api: APIRequestContext;
let projectId: string;
let repoId: string;

// the start steps live on the project's Environments page ("Your app"); the old settings anchor redirects there
const settingsUrl = () => '/p/RST/environments#start-steps';
const planRows = () =>
  q<{ source: string; workstation_id: string | null; version: number; status: string; plan: any }>(
    `SELECT source, workstation_id, version, status, plan FROM run_plans WHERE project_id=$1 AND status <> 'superseded'`,
    [projectId],
  );

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, STEPPER);
  api = await apiAs(STEPPER.email, STEPPER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a paired mock runner and project RST on the toy repo', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Office PC', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '100' }, HOME);
  await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  const proj = await api.post('/api/projects', { data: { key: 'RST', name: 'Run steps project' } });
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
  // the runner announced the scan capability (a runner too old for it would show "too old" instead)
  const caps = await q<{ capabilities: string[] }>('SELECT capabilities FROM workstation_capabilities');
  expect(caps.some((c) => c.capabilities.includes('setup-scan:1'))).toBe(true);
});

test('a new project says it is not set up and offers a scan or setting it up by hand', async () => {
  await page.goto(settingsUrl());
  await expect(page.getByTestId('run-steps-state')).toContainText('Not set up yet');
  await expect(page.getByTestId('scan-open')).toBeEnabled();
  await expect(page.getByTestId('run-steps-edit-open')).toHaveText(/Set up myself/);
});

test('set up myself: add a step and a part through templates, in plain words, and use them', async () => {
  await page.getByTestId('run-steps-edit-open').click();
  // a plan needs a part that keeps running: saving is blocked, in words
  await expect(page.getByTestId('run-steps-problems')).toContainText(
    'Add at least one part that keeps running',
  );
  await expect(page.getByTestId('run-steps-save')).toBeDisabled();

  await page.getByRole('button', { name: /Add a step/ }).click();
  await page.getByTestId('template-install_packages').click();
  await page.getByTestId('step-add').click();
  await expect(page.getByTestId('run-entry-Install packages')).toContainText('Runs npm ci.');

  await page.getByRole('button', { name: /Add a part/ }).click();
  await page.getByTestId('template-web_app').click();
  await page.getByLabel('What command starts it?').fill('node index.js');
  await page.getByTestId('step-add').click();
  // no port yet: asked in plain words
  await expect(page.getByTestId('step-error')).toContainText('Which port does the app use');
  await page.getByLabel('Which port does it use?').fill('3000');
  await page.getByTestId('step-add').click();
  await expect(page.getByTestId('run-steps-problems')).toHaveCount(0);

  await page.getByTestId('run-steps-save').click();
  await expect(page.getByTestId('run-steps-state')).toContainText(
    'Starts in 2 steps on any computer of this project',
  );
  await expect(page.getByTestId('run-plan-summary')).toContainText('Runs node index.js, on port 3000');

  const rows = await planRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ source: 'owner', workstation_id: null, status: 'active' });
  expect(rows[0]?.plan.services[0]).toMatchObject({
    name: 'web',
    cmd: ['node', 'index.js'],
    template: 'web_app',
  });
});

test('Scan with DevOps: the mock engineer reads the project and proposes steps; the owner answers one question and confirms', async () => {
  await page.reload();
  await page.getByTestId('scan-open').click();
  await page.getByLabel(/Anything DevOps should know/).fill('The site is the node app in the top folder.');
  await page.getByTestId('scan-start').click();

  const req = await waitFor(
    'a scan request',
    () =>
      q<{ context: any; status: string }>(
        `SELECT context, status FROM devops_requests WHERE context->>'requestKind'='run_scan'`,
      ),
    (r) => r.length === 1,
    15_000,
  );
  expect(req[0]?.context).toMatchObject({ scanArea: 'run', projectId });

  // the mock engineer submits its fixture proposal and ends the request
  await expect(page.getByTestId('proposal-waiting')).toContainText('2 steps found, 1 question for you', {
    timeout: 120_000,
  });
  const proposals = await q<{ status: string; area: string }>('SELECT status, area FROM setup_proposals');
  expect(proposals).toEqual([{ status: 'open', area: 'run' }]);

  await page.getByTestId('proposal-review-open').click();
  await expect(page.getByTestId('proposal-notes')).toContainText('Mock DevOps read index.js.');
  await expect(page.getByTestId('proposal-questions')).toContainText('1 question before you can use this');
  await expect(page.getByTestId('proposal-use')).toBeDisabled();
  await expect(page.getByTestId('run-entry-Install packages')).toContainText('Found');
  await expect(page.getByTestId('run-entry-The website')).toContainText('Needs your answer');

  // answer: open the part, choose how we know it is ready, save
  await page.getByTestId('proposal-questions').getByRole('button', { name: 'Answer' }).click();
  await expect(page.getByTestId('step-banner')).toContainText('Which page shows that the website is ready?');
  await page.getByRole('radio', { name: 'The page opens' }).check();
  await page.getByLabel('Which page?').fill('/health');
  await page.getByTestId('step-save').click();
  await expect(page.getByTestId('proposal-use')).toBeEnabled();

  await page.getByTestId('proposal-use').click();
  await expect(page.getByTestId('run-steps-state')).toContainText('Starts in 2 steps');
  await expect(page.getByTestId('run-plan-summary')).toContainText('from a DevOps scan');

  const rows = await planRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ source: 'scan', workstation_id: null, version: 2 });
  expect(rows[0]?.plan.services[0].health).toMatchObject({
    kind: 'http',
    url: 'http://localhost:${port}/health',
  });
  expect((await q<{ status: string }>('SELECT status FROM setup_proposals'))[0]?.status).toBe('accepted');
});

test('a scan that finds nothing says so, and the owner can try again or set it up by hand', async () => {
  await page.reload();
  await page.getByTestId('scan-open').click();
  await page.getByLabel(/Anything DevOps should know/).fill('[no_proposal] please');
  await page.getByTestId('scan-start').click();
  await expect(page.getByTestId('scan-problem')).toContainText('could not suggest steps', {
    timeout: 120_000,
  });
  await expect(page.getByTestId('scan-open')).toBeEnabled();
});

test('the technical view is still there, with the plan DevOps and the owner saved', async () => {
  await page.reload();
  await page.getByTestId('run-technical').locator('summary').click();
  await expect(page.getByTestId('run-settings')).toBeVisible();
  await expect(page.getByTestId('run-instructions')).toBeVisible();
});

test('the old settings link lands on Your app, and Places says there is no place yet', async () => {
  await page.goto(`/projects/${projectId}/settings#run`);
  await expect(page).toHaveURL(/\/p\/RST\/environments#start-steps/);
  await expect(page.getByTestId('your-app')).toBeVisible();
  await expect(page.getByTestId('places-empty')).toContainText('No place yet');
  await expect(page.getByTestId('places-add-server')).toBeVisible();
  void repoId;
});
