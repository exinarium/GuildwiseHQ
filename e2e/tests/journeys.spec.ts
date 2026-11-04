import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN } from '../support/env.ts';
import { saveJourneyInDesigner } from '../support/ui.ts';

// Journeys: workflows linked by handoffs on one shared record. The designer (template, condition, loop, save and reopen,
// Move up/down on a phone), starting an instance on a record, the instance following handoffs with timestamps in the
// history, Continue past a placeholder wait, cancel, and the record holding only status, step, timestamps and references.
// Standalone: its own user, organization and project; needs only the shared stack. Step cards stay drafts (the
// workflow's required fields are not filled in), so the spec ends a step card by setting its status in the database;
// the journey sweep reads the card state, not an event.
test.describe.configure({ mode: 'serial' });

const JOURNEYER = { email: 'journeys@e2e.test', name: 'E2E Journeys', password: 'journeys-password-12345' };
const RECORD_COLUMNS = [
  'created_at',
  'current_instance_id',
  'current_step_id',
  'display_name',
  'external_id',
  'id',
  'org_id',
  'project_id',
  'record_type',
  'status',
  'updated_at',
];

let page: Page;
let api: APIRequestContext;
let projectId = '';
let workflowKey = '';
let journeyId = '';
let instanceId = '';

type Run = {
  visit: number;
  stepId: string;
  status: string;
  cardId: string | null;
  enteredAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
};
type Instance = {
  status: string;
  currentStepId: string;
  currentVisit: number;
  record: { id: string };
  history: Run[];
};

const getInstance = async (id: string): Promise<Instance> => {
  const r = await api.get(`/api/journey-instances/${id}`);
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
};
/** Waits until the scheduler sweep moved the instance to `step` (and, when given, the run there has `status`). */
const instanceAt = (id: string, step: string, status?: string) =>
  waitFor(
    `instance at ${step}${status ? ` (${status})` : ''}`,
    () => getInstance(id),
    (v) =>
      v.currentStepId === step &&
      (!status || v.history.find((h) => h.visit === v.currentVisit)?.status === status),
  );
const endCard = (cardId: string, status: 'done' | 'cancelled') =>
  q('UPDATE cards SET status=$2 WHERE id=$1', [cardId, status]);

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, JOURNEYER);
  api = await apiAs(JOURNEYER.email, JOURNEYER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  const proj = await api.post('/api/projects', { data: { key: 'JRN', name: 'Lettings' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  const wf = await q<{ workflow_key: string }>(
    'SELECT workflow_key FROM project_workflows WHERE project_id=$1 AND is_primary',
    [projectId],
  );
  workflowKey = wf[0]?.workflow_key ?? '';
  expect(workflowKey, 'the project has a primary workflow').not.toBe('');
});

test('the Journeys page is in the navigation and the rentals template opens in the designer with all its steps', async () => {
  await page.goto('/desk');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Journeys' }).click();
  await expect(page).toHaveURL(/\/journeys$/);
  await expect(page.getByRole('heading', { name: 'Journeys', level: 1 })).toBeVisible();
  await expect(page.getByText('No journeys yet')).toBeVisible();

  await page.getByRole('button', { name: 'New journey' }).click();
  const dialog = page.getByRole('dialog', { name: 'New journey' });
  await expect(dialog.getByText('Rentals: lead to monthly rent')).toBeVisible();
  await expect(dialog.getByText('10 steps · for a client')).toBeVisible();
  await dialog
    .getByTestId('journey-templates')
    .getByRole('listitem')
    .filter({ hasText: 'Rentals: lead to monthly rent' })
    .getByRole('button', { name: 'Use this template' })
    .click();
  await expect(page).toHaveURL(/\/journeys\/[0-9a-f-]{36}$/);

  const steps = page.getByTestId('journey-steps').locator(':scope > li');
  await expect(steps).toHaveCount(10);
  for (const label of [
    'Lead',
    'Viewing',
    'Application',
    'Wait for forms and documents',
    'Screening',
    'Approval',
    'Lease signed',
    'Deposit and first-rent invoice',
    'Move-in',
    'Monthly rent',
  ])
    await expect(
      page.getByRole('textbox', { name: 'Step name' }).and(page.locator(`[value="${label}"]`)),
    ).toHaveCount(1);
  // the wait and the gate come with their settings (a form wait and a project-owner approval); the monthly rent loops
  await expect(page.getByText('Coming with waits and gates')).toHaveCount(0);
  await expect(
    page.getByTestId('wait-settings-wait_documents').getByLabel('Wait for', { exact: true }),
  ).toHaveValue('form');
  await expect(
    page.getByTestId('gate-settings-approval').getByLabel('Who decides', { exact: true }),
  ).toHaveValue('project_owner');
  await expect(page.getByTestId('step-monthly_rent').getByText('Loop', { exact: true })).toBeVisible();

  // the template is saved in the project: it is listed and its version reopens with the same steps
  const id = new URL(page.url()).pathname.split('/').pop() as string;
  const saved = await (await api.get(`/api/journeys/${id}`)).json();
  expect(saved.definition.steps).toHaveLength(10);
  expect(
    saved.definition.handoffs.some(
      (h: { from: string; to: string }) => h.from === 'monthly_rent' && h.to === 'monthly_rent',
    ),
  ).toBe(true);
  await page.goto('/journeys');
  await expect(page.getByTestId('journey-list').getByRole('link', { name: 'Rentals' })).toBeVisible();
});

test('designer: build a journey from workflows with a condition and a loop back, save and reopen it unchanged', async () => {
  const created = await api.post('/api/journeys', {
    data: {
      projectId,
      definition: {
        name: 'Tenant',
        recordType: 'client',
        firstStepId: 'lead',
        steps: [
          { kind: 'workflow', id: 'lead', label: 'Lead', workflowKey },
          { kind: 'workflow', id: 'viewing', label: 'Viewing', workflowKey },
          { kind: 'wait', id: 'docs', label: 'Documents' },
          { kind: 'workflow', id: 'rent', label: 'Rent', workflowKey },
        ],
        handoffs: [],
      },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  journeyId = (await created.json()).id;

  await page.goto(`/journeys/${journeyId}`);
  await expect(page.getByTestId('journey-steps').locator(':scope > li')).toHaveCount(4);

  // lead -> viewing (done)
  await page.getByTestId('step-lead').getByRole('button', { name: 'Add a handoff' }).click();
  // viewing -> docs (either)
  const viewing = page.getByTestId('step-viewing');
  await viewing.getByRole('button', { name: 'Add a handoff' }).click();
  await viewing.getByLabel('When this step is').selectOption('any');
  // docs -> rent
  await page.getByTestId('step-docs').getByRole('button', { name: 'Add a handoff' }).click();
  // rent -> rent while the record has had fewer than 3 visits (a loop with a condition), else the end
  const rent = page.getByTestId('step-rent');
  await rent.getByRole('button', { name: 'Add a handoff' }).click();
  await rent.getByLabel('Go to').selectOption('rent');
  await rent.getByRole('button', { name: 'Only if…' }).click();
  await rent.getByLabel('Look at').selectOption('record');
  await rent.getByLabel('Record field (type, status, visits)').fill('visits');
  await rent.getByLabel('Condition').selectOption('lt');
  await rent.getByLabel('Value').fill('3');
  await rent.getByLabel('Label (optional)').fill('Next month');
  await rent.getByRole('button', { name: 'Add a handoff' }).click();
  await expect(rent.locator('[data-testid^="handoff-"]')).toHaveCount(2);
  await rent.locator('[data-testid^="handoff-"]').nth(1).getByLabel('Go to').selectOption('end');
  await expect(rent.getByText('Loop', { exact: true })).toBeVisible();

  await expect(page.getByText('unsaved changes')).toBeVisible();
  await saveJourneyInDesigner(page, () => page.getByRole('button', { name: 'Save', exact: true }).click());
  await expect(page.getByText('Version 2')).toBeVisible();
  const saved = (await (await api.get(`/api/journeys/${journeyId}`)).json()).definition;

  // reopen: the page and the stored definition are the same as what was saved
  await page.reload();
  await expect(page.getByText('Version 2')).toBeVisible();
  await expect(page.getByText('unsaved changes')).toHaveCount(0);
  const reopened = page.getByTestId('step-rent');
  await expect(reopened.locator('[data-testid^="handoff-"]')).toHaveCount(2);
  await expect(reopened.getByLabel('Look at')).toHaveValue('record');
  await expect(reopened.getByLabel('Record field (type, status, visits)')).toHaveValue('visits');
  await expect(reopened.getByLabel('Condition')).toHaveValue('lt');
  await expect(reopened.getByLabel('Value')).toHaveValue('3');
  await expect(reopened.getByLabel('Label (optional)').first()).toHaveValue('Next month');
  await expect(page.getByTestId('step-viewing').getByLabel('When this step is')).toHaveValue('any');
  const again = (await (await api.get(`/api/journeys/${journeyId}`)).json()).definition;
  expect(again).toEqual(saved);
  const loop = saved.handoffs.find((h: { from: string; to: string }) => h.from === 'rent' && h.to === 'rent');
  expect(loop.condition).toEqual({ source: 'record', field: 'visits', op: 'lt', value: 3 });
  expect(saved.handoffs.map((h: { from: string; to: string }) => `${h.from}>${h.to}`)).toEqual([
    'lead>viewing',
    'viewing>docs',
    'docs>rent',
    'rent>rent',
    'rent>end',
  ]);

  // a save on a stale version is refused
  const stale = await api.put(`/api/journeys/${journeyId}`, { data: { definition: saved, baseVersion: 1 } });
  expect(stale.status()).toBe(409);
});

test('start on a record: the instance opens at the first workflow and follows handoffs, with times in the history', async () => {
  await page.goto(`/journeys/${journeyId}`);
  await page.getByRole('button', { name: 'Start on a client' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Ann Tenant');
  await dialog.getByLabel('Your own id (optional)').fill('T-100');
  await dialog.getByRole('button', { name: 'Start journey' }).click();
  await expect(page).toHaveURL(/\/journeys\/instances\/[0-9a-f-]{36}$/);
  instanceId = new URL(page.url()).pathname.split('/').pop() as string;
  await expect(page.getByRole('heading', { name: 'Ann Tenant' })).toBeVisible();

  // the sweep starts a card for the first workflow
  let v = await instanceAt(instanceId, 'lead', 'open');
  expect(v.history).toHaveLength(1);
  const leadCard = v.history[0]?.cardId as string;
  expect(leadCard).toBeTruthy();
  const card = await q<{ origin: string; project_id: string }>(
    'SELECT origin, project_id FROM cards WHERE id=$1',
    [leadCard],
  );
  expect(card[0]).toEqual({ origin: 'journey', project_id: projectId });
  await page.reload();
  await expect(page.getByText('Now: Lead')).toBeVisible();

  // finishing the Lead card moves the instance along lead -> viewing
  await endCard(leadCard, 'done');
  v = await instanceAt(instanceId, 'viewing', 'open');
  const lead = v.history.find((h) => h.stepId === 'lead') as Run;
  expect(lead.status).toBe('done');
  expect(lead.enteredAt && lead.startedAt && lead.endedAt).toBeTruthy();
  expect(Date.parse(lead.endedAt as string)).toBeGreaterThanOrEqual(Date.parse(lead.startedAt as string));
  await page.reload();
  await expect(page.getByText('Now: Viewing')).toBeVisible();
  const history = page.getByTestId('journey-history');
  await expect(history.locator(':scope > li')).toHaveCount(2);
  await expect(history.locator(':scope > li').first()).toContainText('Lead');
  await expect(history.locator(':scope > li').first()).toContainText(/Entered .+ · Started .+ · Ended (?!—)/);

  // cancelling the Viewing card still matches "either" -> the placeholder wait, which waits for the desk
  const viewingCard = v.history.find((h) => h.stepId === 'viewing')?.cardId as string;
  await endCard(viewingCard, 'cancelled');
  await instanceAt(instanceId, 'docs', 'waiting');
  await page.reload();
  await expect(page.getByText('Now: Documents')).toBeVisible();
  await page.getByRole('button', { name: 'Continue past this step' }).click();
  v = await instanceAt(instanceId, 'rent', 'open');

  // the rent loop: rent -> rent while the record has had fewer than 3 visits of the step, then the end
  for (let n = 0; n < 2; n++) {
    const cur = v.history.find((h) => h.visit === v.currentVisit) as Run;
    await endCard(cur.cardId as string, 'done');
    v = await waitFor(
      'the rent step to move on',
      () => getInstance(instanceId),
      (x) => (x.currentVisit > cur.visit && x.history.at(-1)?.status === 'open') || x.status === 'completed',
    );
  }
  expect(v.history.filter((h) => h.stepId === 'rent').length).toBeGreaterThanOrEqual(2);
  for (const h of v.history.filter((x) => x.status === 'done')) expect(h.endedAt).toBeTruthy();
});

test('the Running tab filters instances by step and status', async () => {
  await page.goto('/journeys');
  await page.getByRole('tab', { name: 'Running' }).click();
  const list = page.getByTestId('instance-list');
  await expect(list.getByRole('link', { name: 'Ann Tenant' })).toBeVisible();
  // exact labels: the sidebar's "Get started: 1 of 5 steps done" button also matches a loose 'Step'
  await page.getByLabel('Status', { exact: true }).selectOption('completed');
  await expect(page.getByText('Nothing running')).toBeVisible();
  await page.getByLabel('Status', { exact: true }).selectOption('');
  await page.getByLabel('Step', { exact: true }).selectOption('rent');
  await expect(list.getByRole('link', { name: 'Ann Tenant' })).toBeVisible();
  const byStep = await (await api.get(`/api/journey-instances?stepId=lead&projectId=${projectId}`)).json();
  expect(byStep.items).toHaveLength(0);
  const atRent = await (
    await api.get(`/api/journey-instances?stepId=rent&status=running&projectId=${projectId}`)
  ).json();
  expect(atRent.items.map((i: { recordName: string }) => i.recordName)).toEqual(['Ann Tenant']);
});

test('cancel an instance from its page', async () => {
  await page.goto(`/journeys/instances/${instanceId}`);
  await page.getByRole('button', { name: 'Cancel journey' }).click();
  await expect(page.getByText('cancelled', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Finished')).toBeVisible();
  expect((await getInstance(instanceId)).status).toBe('cancelled');
});

test('the shared record holds only status, step, timestamps and references, never answers or document content', async () => {
  const v = await getInstance(instanceId);
  const cols = await q<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name='journey_records' ORDER BY column_name",
  );
  expect(cols.map((c) => c.column_name)).toEqual(RECORD_COLUMNS);
  const refCols = await q<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name='journey_record_refs' ORDER BY column_name",
  );
  expect(refCols.map((c) => c.column_name)).toEqual(['added_at', 'kind', 'label', 'record_id', 'ref']);

  // a reference is stored as a reference; content sent along with it is refused, not kept
  const ok = await api.post(`/api/journey-records/${v.record.id}/references`, {
    data: { kind: 'document', ref: 'onedrive:/Lettings/T-100/id.pdf', label: 'ID document' },
  });
  expect(ok.ok(), await ok.text()).toBeTruthy();
  const withContent = await api.post(`/api/journey-records/${v.record.id}/references`, {
    data: { kind: 'form_submission', ref: 'sub-1', answers: { income: '5000' }, content: 'SECRET-ANSWER' },
  });
  expect(withContent.status()).toBe(400);
  const start = await api.post('/api/journey-instances', {
    data: { journeyId, record: { type: 'client', displayName: 'Bob', answers: { income: '5000' } } },
  });
  expect(start.status()).toBe(400);
  const dump = JSON.stringify(
    await q(
      'SELECT r.*, f.* FROM journey_records r LEFT JOIN journey_record_refs f ON f.record_id=r.id WHERE r.project_id=$1',
      [projectId],
    ),
  );
  expect(dump).not.toContain('SECRET-ANSWER');
  expect(dump).not.toContain('5000');
  await page.goto(`/journeys/instances/${instanceId}`);
  await expect(page.getByText('ID document')).toBeVisible();
});

test('a step can reference a playbook: the choice is saved and the instance offers to run it', async () => {
  await page.goto(`/journeys/${journeyId}`);
  const picker = page.getByTestId('step-lead').getByLabel('Playbook that helps in this step (optional)');
  await expect(picker).toBeVisible();
  // the list comes from the playbooks feature as it is (slash commands of kind playbook)
  await page.waitForTimeout(1_000);
  const keys = (
    await picker.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))
  ).filter(Boolean);
  test.skip(keys.length === 0, 'no playbook is available to this organization');
  await picker.selectOption(keys[0] as string);
  await saveJourneyInDesigner(page, () => page.getByRole('button', { name: 'Save', exact: true }).click());
  const saved = (await (await api.get(`/api/journeys/${journeyId}`)).json()).definition;
  expect(saved.steps.find((s: { id: string }) => s.id === 'lead').playbook.key).toBe(keys[0]);

  const started = await api.post('/api/journey-instances', {
    data: { journeyId, record: { type: 'client', displayName: 'Cara Playbook' } },
  });
  expect(started.status(), await started.text()).toBe(201);
  const id = (await started.json()).id as string;
  await instanceAt(id, 'lead', 'open');
  await page.goto(`/journeys/instances/${id}`);
  await expect(page.getByRole('button', { name: /^Run playbook: / })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel journey' }).click();
  await expect(page.getByText('Finished')).toBeVisible();
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('Move up and Move down reorder steps and a handoff condition can be typed', async ({ browser }) => {
    const ctx = await browser.newContext({
      storageState: await api.storageState(),
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const phone = await ctx.newPage();
    await phone.goto(`/journeys/${journeyId}`);
    const order = () =>
      phone
        .getByTestId('journey-steps')
        .locator(':scope > li')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')));
    expect(await order()).toEqual(['step-lead', 'step-viewing', 'step-docs', 'step-rent']);
    await phone.getByTestId('step-viewing').getByRole('button', { name: 'Move down' }).tap();
    expect(await order()).toEqual(['step-lead', 'step-docs', 'step-viewing', 'step-rent']);
    await phone.getByTestId('step-viewing').getByRole('button', { name: 'Move up' }).tap();
    expect(await order()).toEqual(['step-lead', 'step-viewing', 'step-docs', 'step-rent']);

    const value = phone.getByTestId('step-rent').getByLabel('Value');
    await value.tap();
    await value.fill('12');
    await expect(value).toBeInViewport();
    await expect(value).toHaveAttribute('inputmode', 'decimal');
    await saveJourneyInDesigner(phone, () => phone.getByRole('button', { name: 'Save', exact: true }).tap());
    const saved = (await (await api.get(`/api/journeys/${journeyId}`)).json()).definition;
    expect(
      saved.handoffs.find((h: { from: string; to: string }) => h.from === 'rent' && h.to === 'rent').condition
        .value,
    ).toBe(12);
    await ctx.close();
  });
});

test('a step with no matching handoff makes the instance stuck and leaves a notice', async () => {
  const created = await api.post('/api/journeys', {
    data: {
      projectId,
      definition: {
        name: 'Dead end',
        recordType: 'deal',
        firstStepId: 'only',
        steps: [{ kind: 'workflow', id: 'only', label: 'Only', workflowKey }],
        handoffs: [
          {
            id: 'h1',
            from: 'only',
            on: 'done',
            to: 'end',
            condition: { source: 'record', field: 'type', op: 'equals', value: 'client' },
          },
        ],
      },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const started = await api.post('/api/journey-instances', {
    data: { journeyId: (await created.json()).id, record: { type: 'deal', displayName: 'Deal 7' } },
  });
  expect(started.status(), await started.text()).toBe(201);
  const id = (await started.json()).id as string;
  const v = await instanceAt(id, 'only', 'open');
  await endCard(v.history[0]?.cardId as string, 'done');
  await waitFor(
    'the instance to be stuck',
    () => getInstance(id),
    (x) => x.status === 'stuck',
  );
  await page.goto(`/journeys/instances/${id}`);
  await expect(page.getByRole('alert').filter({ hasText: 'This journey is stuck' })).toBeVisible();
});
