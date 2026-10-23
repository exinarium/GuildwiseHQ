import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, DISCOVERER, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// Discovery Studio (phase B): the whole path with the mock runtime and no Claude: a facilitated session (the mock analyst asks
// real `aom session` verbs), the owner's answers, a proposal, the side panel, the PRD draft, the checklist, approval, and
// the hand-over to a BA whose cards carry the PRD. One user, one runner (mock), project DSC on the toy repo.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('discovery');
let page: Page;
let api: APIRequestContext;
let workstationId: string;
let projectId: string;
let sessionUrl = '';

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, DISCOVERER);
  api = await apiAs(DISCOVERER.email, DISCOVERER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a paired mock runner, project DSC, an analyst and a BA', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Discovery Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '150', AOM_MOCK_CHAT_TOKEN_MS: '15' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id;
  const proj = await api.post('/api/projects', { data: { key: 'DSC', name: 'Discovery project' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id as string;
  expect((await api.put(`/api/projects/${projectId}/manual-qa`, { data: { enabled: false } })).status()).toBe(
    200,
  );
  const add = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status()).toBe(201);
  for (const [name, roleKey] of [
    ['Ana', 'analyst'],
    ['Ben', 'ba'],
  ] as const) {
    const hire = await api.post('/api/agents', {
      data: { name, roleKey, seniority: 'senior', workstationId, runtime: 'mock' },
    });
    expect(hire.status(), await hire.text()).toBe(201);
  }
  await waitFor(
    'the runner announces the session verbs',
    async () =>
      (
        await q<any>('SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1', [
          workstationId,
        ])
      )[0]?.capabilities,
    (c) => Array.isArray(c) && c.includes('session-verbs:1'),
    30_000,
  );
});

test('the owner starts a discovery and the analyst asks the first question', async () => {
  await page.goto('/discovery');
  await expect(page.getByText('No discovery sessions yet')).toBeVisible();
  await page.getByTestId('new-discovery').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Title').fill('Invoicing for freelancers');
  await dialog.getByLabel('Starting idea (optional)').fill('Invoices that chase late payers by themselves');
  await dialog.getByLabel('Project (optional)').selectOption({ label: 'DSC: Discovery project' });
  await dialog.getByLabel('Time box').selectOption('60');
  await dialog.getByLabel('Budget in USD (optional)').fill('25');
  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/discovery\/[0-9a-f-]{36}$/);
  sessionUrl = page.url();
  await expect(page.getByText('Hello! Let us turn this idea into something buildable.')).toBeVisible({
    timeout: 60_000,
  });
  const card = page.getByTestId('question-card').first();
  await expect(card).toContainText('Who is the primary user?', { timeout: 60_000 });
  await expect(page.getByTestId('waiting-for')).toHaveText('Your turn');
  await expect(page.getByTestId('phase-frame')).toHaveAttribute('aria-current', 'step');
  await expect(page.getByTestId('panel-ideas')).toContainText('Invoices that chase late payers', {
    timeout: 30_000,
  });
  await page.screenshot({ path: `${paths.vaults}/discovery-first-question.png`, fullPage: true });
  const row = (await q<any>('SELECT meta, status FROM session_turns ORDER BY queued_at LIMIT 1'))[0];
  expect(row.meta).toMatchObject({ purpose: 'facilitator', trigger: 'start' });
});

test('answering walks through the phases, raises a proposal, and fills the panel', async () => {
  const answerFirst = async (title: string) => {
    const card = page.getByTestId('question-card').filter({ hasText: title }).last();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await card.getByTestId('option-o1').click();
    await expect(card.getByTestId('question-answer')).toBeVisible({ timeout: 30_000 });
  };
  await answerFirst('Who is the primary user?');
  await answerFirst('What is their biggest pain today?');
  await answerFirst('How will we know it worked?');
  await expect(page.getByTestId('phase-diverge')).toHaveAttribute('aria-current', 'step', {
    timeout: 60_000,
  });
  // the proposal appears after the third answer; nothing is applied until the owner says so
  const proposal = page.getByTestId('proposal-card').first();
  await expect(proposal).toContainText('Make reminders part of the first version', { timeout: 60_000 });
  await expect(page.getByTestId('panel-decisions')).not.toContainText('Payment reminders are in scope');
  await page.screenshot({ path: `${paths.vaults}/discovery-proposal.png`, fullPage: true });
  await proposal.getByTestId('proposal-apply').click();
  await expect(page.getByTestId('panel-decisions')).toContainText('Payment reminders are in scope', {
    timeout: 30_000,
  });
  await expect(proposal).toContainText('Applied');
  await answerFirst('Which idea do we keep for the first version?');
  await answerFirst('What is most likely to make this fail?');
  await expect(page.getByTestId('phase-stress_test')).toHaveAttribute('aria-current', 'step', {
    timeout: 60_000,
  });
  await answerFirst('Is anything still open that blocks the PRD?');
  // capture: the analyst wrote the PRD from the panel
  await expect(page.getByTestId('phase-capture')).toHaveAttribute('aria-current', 'step', {
    timeout: 60_000,
  });
  const drafts = page.getByTestId('session-drafts');
  await expect(drafts.getByTestId('doc-prd')).toContainText('PRD: Invoicing for freelancers', {
    timeout: 60_000,
  });
  await expect(drafts.getByTestId('document-text')).toContainText('R1', { timeout: 30_000 });
  await expect(page.getByTestId('meter-cost')).not.toContainText('$0.00');
  await page.screenshot({ path: `${paths.vaults}/discovery-prd.png`, fullPage: true });
});

test('the owner edits the panel, validates the PRD and approves it', async () => {
  const panel = page.getByTestId('session-panel');
  await panel.getByLabel('Add to Parked').fill('Tax filing');
  await panel.getByRole('region', { name: 'Parked' }).getByRole('button', { name: 'Add' }).click();
  await expect(panel.getByTestId('panel-parked')).toContainText('Tax filing');
  const drafts = page.getByTestId('session-drafts');
  await drafts.getByTestId('validate-prd').click();
  await expect(drafts.getByTestId('prd-validation')).toContainText('Mostly complete', { timeout: 60_000 });
  await expect(drafts.getByTestId('prd-validation')).toContainText('fail');
  await drafts.getByTestId('approve-doc').click();
  await expect(drafts.getByTestId('doc-status')).toHaveText('Approved', { timeout: 30_000 });
  const doc = (await q<any>(`SELECT status, kind, source_thread_ids FROM documents WHERE kind='prd'`))[0];
  expect(doc.status).toBe('approved');
});

test("Hand to BA opens an intake with the PRD, and the BA's card is linked to it", async () => {
  const drafts = page.getByTestId('session-drafts');
  await drafts.getByTestId('hand-to-ba').click();
  await expect(drafts.getByTestId('doc-status')).toHaveText('Handed to the BA', { timeout: 30_000 });
  await drafts.getByTestId('open-intake').click();
  await expect(page).toHaveURL(/\/intake\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('intake-status')).toHaveText('Mapped to DSC', { timeout: 60_000 });
  const docId = (await q<any>(`SELECT id FROM documents WHERE kind='prd'`))[0].id as string;
  const linked = await waitFor(
    'a card drafted from the PRD',
    async () =>
      q<any>(`SELECT ref, fields FROM cards WHERE fields->'linkedDocIds' @> $1::jsonb`, [
        JSON.stringify([docId]),
      ]),
    (rows) => rows.length > 0,
    90_000,
  );
  expect(linked[0].ref).toMatch(/^DSC-/);
  await page.screenshot({ path: `${paths.vaults}/discovery-intake.png`, fullPage: true });
});

test('the session shows in the list and its cost is in the cost ledger', async () => {
  await page.goto('/discovery');
  const row = page.getByTestId('discovery-row').first();
  await expect(row).toContainText('Invoicing for freelancers');
  await expect(row).toContainText('Capture');
  const costs = await q<any>(
    `SELECT count(*)::int AS n, coalesce(sum(cost_usd_micros),0)::bigint AS m FROM shift_costs WHERE kind='session' AND project_id=$1`,
    [projectId],
  );
  expect(costs[0].n).toBeGreaterThan(5);
  await page.goto('/documents');
  await expect(page.getByTestId('document-row').first()).toContainText('PRD');
});

test('on a phone the session is three tabs', async ({ browser }) => {
  const ctx = await browser.newContext({
    storageState: await api.storageState(),
    viewport: { width: 390, height: 844 },
  });
  const phone = await ctx.newPage();
  await phone.goto(sessionUrl);
  await expect(phone.getByRole('tab', { name: 'Conversation' })).toBeVisible();
  await phone.getByRole('tab', { name: /Panel/ }).click();
  await expect(phone.getByTestId('session-panel')).toBeVisible();
  await phone.screenshot({ path: `${paths.vaults}/discovery-phone-panel.png` });
  await phone.getByRole('tab', { name: 'Conversation' }).click();
  await phone.screenshot({ path: `${paths.vaults}/discovery-phone.png` });
  await ctx.close();
});
