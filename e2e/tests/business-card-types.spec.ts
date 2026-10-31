import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, transitionsFor, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, BIZCARDS, paths } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';

// Business card types: a developer organization's New card picker offers only the developer types; once the
// organization (with no repository) switches to Business mode the picker offers the six business types, an enquiry and
// a quote are created from the form with their own fields, prepared by the Front Desk (mock runner, no worktree),
// approved by the person who started them (one is sent back first) and reach Done with no repository, branch or merge.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('business-card-types');
let page: Page;
let api: APIRequestContext;
let projectId: string;

const BUSINESS_LABELS = ['Enquiry', 'Follow-up', 'Document request', 'Reminder', 'Report', 'Quote'];

const cardRow = (ref: string) =>
  q<{ stage: string; status: string; repo_id: string | null; branch_name: string | null; card_type: string }>(
    'SELECT stage, status, repo_id, branch_name, card_type FROM cards WHERE ref=$1',
    [ref],
  );

const waitStage = (ref: string, stage: string, status: string) =>
  waitFor(
    `${ref} at ${stage}/${status}`,
    () => cardRow(ref),
    (r) => r[0]?.stage === stage && r[0]?.status === status,
    90_000,
  );

async function pickerOptions(): Promise<string[]> {
  await page.goto('/cards/new');
  const type = page.getByRole('form', { name: 'New card' }).getByLabel('Card type');
  await expect(type.locator('option').first()).toBeAttached();
  return type.locator('option').allInnerTexts();
}

async function createFromForm(
  cardType: string,
  title: string,
  fields: Record<string, string>,
): Promise<string> {
  await page.goto('/cards/new');
  const form = page.getByRole('form', { name: 'New card' });
  await form.getByLabel('Card type').selectOption({ label: cardType });
  await form.getByLabel('Title', { exact: true }).fill(title);
  for (const [label, value] of Object.entries(fields))
    await form.getByLabel(label, { exact: true }).fill(value);
  // a business card has no repository, completion action or docs controls
  await expect(form.getByLabel('Repository')).toHaveCount(0);
  await expect(form.getByLabel('Completion action')).toHaveCount(0);
  await form.getByRole('button', { name: 'Specify', exact: true }).click();
  await expect(page).toHaveURL(/\/cards\/BIZC-\d+$/);
  return page.url().split('/').pop()!;
}

async function expectFieldsOnCard(ref: string, label: string, fields: Record<string, string>): Promise<void> {
  await page.goto(`/cards/${ref}`);
  const spec = page.getByTestId('card-spec');
  await expect(spec.getByRole('heading', { name: 'Details' })).toBeVisible();
  for (const [name, value] of Object.entries(fields)) {
    await expect(spec.getByText(name, { exact: true })).toBeVisible();
    await expect(spec.getByText(value, { exact: true })).toBeVisible();
  }
  await expect(page.getByText(label).first()).toBeVisible();
}

async function approveOnCard(ref: string): Promise<void> {
  await page.goto(`/cards/${ref}`);
  const panel = page.getByTestId('approval-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('approval-approve').click();
  await waitStage(ref, 'done', 'done');
  await page.reload();
  await expect(page.getByTestId('card-column')).toContainText('Done');
}

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, BIZCARDS);
  api = await apiAs(BIZCARDS.email, BIZCARDS.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a developer organization with project BIZC (no repository) and a paired mock runner', async () => {
  expect((await (await api.get('/api/org')).json()).mode).toBe('dev');
  const proj = await api.post('/api/projects', { data: { key: 'BIZC', name: 'Office' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Office PC', HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
});

test('a developer organization offers only the developer card types', async () => {
  const options = await pickerOptions();
  expect(options).toContain('feature');
  for (const label of BUSINESS_LABELS) expect(options).not.toContain(label);
  // the server has not installed any business workflow either
  const installed = await q(`SELECT key FROM workflow_versions WHERE key LIKE 'business-%'`);
  expect(installed).toHaveLength(0);
});

test('switching to Business mode offers the six business types and hides the developer types', async () => {
  const sw = await api.patch('/api/org', { data: { mode: 'business' } });
  expect(sw.ok(), await sw.text()).toBeTruthy();
  const options = await pickerOptions();
  expect(options).toEqual(BUSINESS_LABELS);
  // a Front Desk agent prepares enquiries and quotes on the paired workstation
  const workstationId = ((await (await api.get('/api/workstations')).json()).workstations as any[])[0].id;
  const hire = await api.post('/api/agents', {
    data: { name: 'Fiona', roleKey: 'front_desk', seniority: 'senior', workstationId, runtime: 'mock' },
  });
  expect(hire.status(), await hire.text()).toBe(201);
  // a developer card is refused in this organization
  const dev = await api.post('/api/cards', {
    data: { projectId, title: 'Fix it', cardType: 'feature', specify: false },
  });
  expect(dev.status(), await dev.text()).toBe(409);
  expect((await dev.json()).error.code).toBe('business_mode_code_workflow');
});

test('an enquiry is created with its fields, sent back once, approved and done without a repository', async () => {
  const fields = {
    'Who asked': 'Mia Jones',
    Channel: 'Phone',
    Question: 'Do you open on Sundays?',
  };
  const ref = await createFromForm('Enquiry', 'Sunday opening hours', { ...fields, 'Due by': '2026-11-03' });
  await expectFieldsOnCard(ref, 'Enquiry', { ...fields, 'Due by': '2026-11-03' });
  expect((await cardRow(ref))[0]).toMatchObject({ card_type: 'enquiry', repo_id: null });

  await waitStage(ref, 'approve', 'waiting');
  await page.goto(`/cards/${ref}`);
  const panel = page.getByTestId('approval-panel');
  await panel.getByTestId('approval-fail').click();
  await panel.getByTestId('approval-note').fill('Mention the holiday hours too');
  await panel.getByTestId('approval-send-back').click();
  // back to the Front Desk, prepared again, waiting for the starter again
  await waitFor(
    `${ref} back at prepare and waiting for approval again`,
    () => transitionsFor(ref),
    (ts) => ts.filter((t) => t.to_stage === 'approve' && t.to_status === 'waiting').length >= 2,
    90_000,
  );
  expect(
    (await transitionsFor(ref)).some((t) => t.from_stage === 'approve' && t.to_stage === 'prepare'),
  ).toBe(true);
  await waitStage(ref, 'approve', 'waiting');
  await approveOnCard(ref);

  const row = (await cardRow(ref))[0]!;
  expect(row).toMatchObject({ stage: 'done', status: 'done', repo_id: null, branch_name: null });
  // no repository prompt or error on the finished card
  await expect(page.getByText(/repository/i)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a quote is created with its fields, prepared, approved and done without a repository', async () => {
  const fields = { Customer: 'Acme', 'Items / scope': '10 chairs', Amount: '1200' };
  const ref = await createFromForm('Quote', 'Chairs for Acme', { ...fields, 'Valid until': '2026-12-15' });
  await expectFieldsOnCard(ref, 'Quote', { ...fields, 'Valid until': '2026-12-15' });
  expect((await cardRow(ref))[0]).toMatchObject({ card_type: 'quote', repo_id: null });

  await waitStage(ref, 'approve', 'waiting');
  await approveOnCard(ref);
  const row = (await cardRow(ref))[0]!;
  expect(row).toMatchObject({ stage: 'done', status: 'done', repo_id: null, branch_name: null });
  await expect(page.getByText(/repository/i)).toHaveCount(0);

  // the prepare shifts ran with no worktree; nothing was merged
  const merges = await q(
    `SELECT 1 FROM events WHERE type IN ('CardMerged','MergeCompleted') AND payload->>'projectId'=$1`,
    [projectId],
  );
  expect(merges).toHaveLength(0);
});
