import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, DESIGNER, DESIGNGUEST, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// M10: the organization designer (docs/PLAN.md M10 AC). The manager describes a support pipeline to the BA in a chat;
// the BA drafts a role pair and a workflow, the server validates, the desk approves, and a custom workflow with custom
// roles runs a card end to end with the mock adapter. A card in flight stays on its old workflow version.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('org');
let page: Page;
let guestPage: Page;
let api: APIRequestContext;
let guestApi: APIRequestContext;
let workstationId: string;
let ownerId: string;
let projectId: string;
let guestWs: string;

const shot = (name: string) => join(paths.vaults, `org-${name}.png`);
const row = async (ref: string) =>
  (
    await q<{ id: string; stage: string; status: string; workflow_version_id: string; rework_round: number }>(
      'SELECT * FROM cards WHERE ref=$1',
      [ref],
    )
  )[0];
const stageWait = (ref: string, stage: string, status: string, timeout = 90_000) =>
  waitFor(
    `${ref} in ${stage}/${status}`,
    () => row(ref),
    (c) => c?.stage === stage && c.status === status,
    timeout,
  );

const triager = (over: Record<string, unknown> = {}) => ({
  key: 'triager',
  name: 'Triager',
  purpose: 'Sorts incoming support tickets.',
  department: 'support',
  instructions: 'Read the ticket, decide a category and a priority, then report.',
  coreRules: ['Never promise refunds.'],
  seniorityLevels: ['junior', 'senior'],
  defaultModel: { runtime: 'mock', model: 'mock' },
  permissions: {
    allowedTools: ['read'],
    deniedShellPatterns: [],
    writableGlobs: null,
    mayCommit: false,
    browser: false,
    riskTiers: ['small', 'large'],
    repoIds: null,
  },
  skills: [],
  claimableStages: [{ workflowKey: 'support', stageId: 'triage' }],
  ...over,
});
const responder = () =>
  triager({
    key: 'responder',
    name: 'Responder',
    purpose: 'Answers the customer.',
    instructions: 'Write the answer to the customer and report.',
    seniorityLevels: ['senior'],
    claimableStages: [{ workflowKey: 'support', stageId: 'resolve' }],
  });
const outcome = (id: string, to: string, kind = 'success', extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  kind,
  to,
  event: 'StageCompleted',
  ...extra,
});
const supportWorkflow = (doneCriteria = 'The customer has an answer.') => ({
  key: 'support',
  name: 'Support triage',
  department: 'support',
  fieldSet: 'custom',
  customFields: [{ key: 'customer', label: 'Customer', type: 'text', required: true }],
  cardTypes: ['support'],
  initialStage: 'intake',
  stages: [
    {
      id: 'intake',
      label: 'Intake',
      column: 'Intake',
      kind: 'manual',
      claimRole: null,
      doneCriteria: '',
      outcomes: [outcome('ready', 'triage', 'success', { event: 'CardSpecified' })],
    },
    {
      id: 'triage',
      label: 'Triage',
      column: 'Triage',
      kind: 'agent',
      claimRole: 'triager',
      requiredFields: ['customer'],
      doneCriteria: 'The ticket has a category and a priority.',
      outcomes: [outcome('triaged', 'resolve')],
    },
    {
      id: 'resolve',
      label: 'Resolve',
      column: 'Resolve',
      kind: 'agent',
      claimRole: 'responder',
      doneCriteria,
      outcomes: [outcome('resolved', 'done'), outcome('escalate', 'triage', 'failure', { rework: true })],
    },
    {
      id: 'done',
      label: 'Done',
      column: 'Done',
      kind: 'terminal',
      claimRole: null,
      doneCriteria: '',
      outcomes: [],
    },
  ],
});

async function createTicket(title: string, mock?: Record<string, string[]>): Promise<string> {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'support',
      fields: { customer: 'Acme Corp', ...(mock ? { mock } : {}) },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).card.ref as string;
}

const deskCard = (p: Page, title: RegExp | string) => p.getByRole('article', { name: title });

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, DESIGNER);
  await inviteAndAccept(admin, DESIGNGUEST);
  api = await apiAs(DESIGNER.email, DESIGNER.password);
  guestApi = await apiAs(DESIGNGUEST.email, DESIGNGUEST.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  guestPage = await (await browser.newContext({ storageState: await guestApi.storageState() })).newPage();
  ownerId = (await q<{ id: string }>('SELECT id FROM users WHERE email=$1', [DESIGNER.email]))[0]
    ?.id as string;
});

test('setup: a paired mock runner, project ORG on the toy repo, and a BA', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Org Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '300' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id;
  const devops = (await (await api.get('/api/agents')).json()).agents.find((a: any) => a.isDevops);
  expect(
    (await api.patch(`/api/agents/${devops.id}`, { data: { runtime: 'mock', model: 'mock' } })).status(),
  ).toBe(200);
  const hire = await api.post('/api/agents', {
    data: { name: 'Ben', roleKey: 'ba', seniority: 'senior', workstationId, runtime: 'mock', model: 'mock' },
  });
  expect(hire.status(), await hire.text()).toBe(201);
  const proj = await api.post('/api/projects', { data: { key: 'ORG', name: 'Org project' } });
  expect(proj.status(), await proj.text()).toBe(201);
});

test('departments: the owner creates one on the Organization page; built-in ones cannot be recreated', async () => {
  await page.goto('/org?tab=departments');
  await expect(page.getByTestId('department-delivery')).toContainText('Built in');
  await expect(page.getByTestId('department-delivery')).toContainText('Workflows: code');
  await page.getByRole('textbox', { name: 'New department' }).fill('support');
  await page.getByRole('button', { name: 'Create department' }).click();
  await expect(page.getByTestId('department-support')).toBeVisible();
  const dup = await api.post('/api/departments', { data: { name: 'delivery' } });
  expect(dup.status()).toBe(409);
});

test('designing with the BA: the BA asks a question, drafts the definitions, and they land on the desk', async () => {
  await page.goto('/org?tab=design');
  await page.getByRole('button', { name: 'Start a design chat' }).click();
  const chat = page.getByTestId('design-chat');
  await expect(chat).toBeVisible();
  // A plain description: the BA asks what it needs to know (it does not guess).
  await chat.getByRole('textbox').fill('design a support pipeline for me');
  await chat.getByRole('button', { name: 'Send' }).click();
  await expect(chat).toContainText('which role claims each stage', { timeout: 60_000 });
  // The answer: the definitions. The BA drafts them with `aom org ...`, validates and submits.
  const need = { roles: [triager(), responder()], workflows: [supportWorkflow()] };
  await chat.getByRole('textbox').fill(`design ${JSON.stringify(need)}`);
  await chat.getByRole('button', { name: 'Send' }).click();
  await expect(chat).toContainText('Submitted role triager for your approval', { timeout: 60_000 });
  await expect(chat).toContainText('Submitted workflow support for your approval');
  await page.screenshot({ path: shot('design-chat'), fullPage: true });
  const items = await waitFor(
    'three definitions on the desk',
    () =>
      q<{ title: string; status: string }>(
        `SELECT title, status FROM desk_items WHERE subkind='definition' ORDER BY title`,
      ),
    (r) => r.length === 3,
    20_000,
  );
  expect(items.map((i) => i.title)).toEqual([
    'Approve role "Responder" (v1)',
    'Approve role "Triager" (v1)',
    'Approve workflow "Support triage" (v1)',
  ]);
  // Drafted by the BA, and not available before the owner approves.
  expect(
    (
      await q<{ drafted_by_kind: string; status: string }>(
        `SELECT drafted_by_kind, status FROM role_definitions WHERE key='triager'`,
      )
    )[0],
  ).toEqual({ drafted_by_kind: 'agent', status: 'pending_approval' });
  const roles = (await (await api.get('/api/roles')).json()).roles.map((r: any) => r.definition.key);
  expect(roles).not.toContain('triager');
  const wfs = (await (await api.get('/api/workflows')).json()).workflows.map((w: any) => w.definition.key);
  expect(wfs).not.toContain('support');
});

test('the desk approves: a workflow waits for its roles, then everything becomes available', async () => {
  await page.goto('/desk');
  const wf = deskCard(page, 'Approve workflow "Support triage" (v1)');
  await expect(wf).toBeVisible();
  await expect(wf).toContainText('claimed by triager');
  await expect(wf).toContainText('claimed by responder');
  // The roles are not approved yet: the workflow cannot be.
  await wf.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('alert').first()).toContainText('approve the role first');
  expect((await q(`SELECT 1 FROM workflow_versions WHERE key='support' AND status='active'`)).length).toBe(0);
  for (const name of ['Triager', 'Responder']) {
    const c = deskCard(page, `Approve role "${name}" (v1)`);
    await c.getByRole('button', { name: 'Approve' }).click();
    await expect(c).toHaveCount(0);
  }
  await wf.getByRole('button', { name: 'Approve' }).click();
  await expect(wf).toHaveCount(0);
  await waitFor(
    'the workflow is active',
    () => q<{ status: string }>(`SELECT status FROM workflow_versions WHERE key='support'`),
    (r) => r[0]?.status === 'active',
    10_000,
  );
  await page.goto('/org?tab=workflows');
  const card = page.getByTestId('workflow-support');
  await expect(card).toContainText('Custom');
  await expect(card).toContainText('Active');
  await card.getByRole('button', { name: 'View support v1' }).click();
  await expect(page.getByTestId('view-support-v1').getByTestId('workflow-graph')).toBeVisible();
  await page.screenshot({ path: shot('workflow'), fullPage: true });
  await page.goto('/org');
  await expect(page.getByTestId('role-triager')).toContainText('Active');
  await expect(page.getByTestId('role-triager')).toContainText('Drafted by the BA');
});

test('validation: a workflow with an unreachable stage cannot be submitted, and the issue shows inline', async () => {
  await page.goto('/org?tab=workflows');
  await page.getByRole('button', { name: 'New custom workflow' }).click();
  const editor = page.getByTestId('workflow-editor');
  await editor.getByLabel('Key', { exact: true }).fill('bad-flow');
  await editor.getByLabel('Name', { exact: true }).fill('Bad flow');
  await editor.getByLabel('Stage work role').selectOption('triager');
  await editor.getByLabel('Stage 2 label').fill('Work');
  await editor.getByRole('button', { name: 'Add stage' }).click();
  // The new stage has no way in: it is flagged inline before anything is saved.
  const validation = editor.getByTestId('validation');
  await expect(validation.locator('[data-code="unreachable_stage"]')).toBeVisible();
  await expect(editor.getByTestId('stage-stage_4')).toHaveAttribute('data-invalid', 'true');
  await page.screenshot({ path: shot('invalid-workflow'), fullPage: true });
  await page.getByRole('button', { name: 'Save and submit for approval' }).click();
  // Saved as a draft (the server shows its issues too) but never submitted.
  await waitFor(
    'the draft is saved',
    () => q<{ status: string }>(`SELECT status FROM workflow_versions WHERE key='bad-flow'`),
    (r) => r.length === 1,
    10_000,
  );
  await expect(page.getByTestId('validation').locator('[data-code="unreachable_stage"]')).toBeVisible();
  expect(
    (await q<{ status: string }>(`SELECT status FROM workflow_versions WHERE key='bad-flow'`))[0]?.status,
  ).toBe('draft');
  const draftId = (await q<{ id: string }>(`SELECT id FROM workflow_versions WHERE key='bad-flow'`))[0]?.id;
  const submit = await api.post(`/api/workflows/${draftId}/submit`, { data: {} });
  expect(submit.status()).toBe(422);
  expect(JSON.stringify(await submit.json())).toContain('unreachable_stage');
  expect(await q(`SELECT 1 FROM desk_items WHERE title LIKE '%Bad flow%'`)).toHaveLength(0);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Discard bad-flow v1' }).click();
  await expect(page.getByTestId('workflow-bad-flow')).toHaveCount(0);
});

test("a project's type is its workflow: created from the Projects page, filtered by department", async () => {
  await page.goto('/projects');
  await page.getByRole('button', { name: 'New project' }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByLabel('Key').fill('SUP');
  await dlg.getByLabel('Name', { exact: true }).fill('Support desk');
  await dlg.getByRole('radio', { name: /^support/ }).check();
  await dlg.getByRole('button', { name: 'Create project' }).click();
  await expect(page.getByRole('main').getByText('Support desk')).toBeVisible();
  projectId = (await q<{ id: string }>(`SELECT id FROM projects WHERE key='SUP'`))[0]?.id as string;
  const add = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status()).toBe(201);
  await waitFor(
    'the workstation holds the toy repo',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n === 1,
    30_000,
  );
  expect(
    (await (await api.get('/api/projects?department=support')).json()).projects.map((p: any) => p.key),
  ).toEqual(['SUP']);

  await page.goto('/projects');
  await expect(page.getByRole('main').getByText('Support desk')).toBeVisible();
  await page.getByLabel('Department').selectOption('support');
  await expect(page.getByRole('main').getByText('Support desk')).toBeVisible();
  await expect(page.getByRole('main').getByText('Org project')).toHaveCount(0);
});

test('hire: the custom roles are on the HR board Hire form, grouped by department', async () => {
  await page.goto('/agents');
  await page.getByRole('button', { name: 'Hire agent' }).first().click();
  const form = page.getByRole('form', { name: 'Hire agent' });
  const roleSelect = form.getByLabel('Role', { exact: true });
  await expect(roleSelect.locator('option', { hasText: 'Triager' })).toHaveCount(1);
  await roleSelect.selectOption({ label: 'Triager' });
  await expect(form.getByText('Department: support')).toBeVisible();
  await form.getByLabel('Project').selectOption('SUP');
  await form.getByLabel('Runtime').selectOption('mock');
  await form.getByLabel('Name', { exact: true }).fill('Tara');
  await form.getByRole('button', { name: 'Hire', exact: true }).click();
  await expect(page.getByTestId('agent-Tara')).toBeVisible();
  const resp = await api.post('/api/agents', {
    data: {
      name: 'Rhea',
      roleKey: 'responder',
      seniority: 'senior',
      workstationId,
      runtime: 'mock',
      model: 'mock',
    },
  });
  expect(resp.status(), await resp.text()).toBe(201);
  // The HR board filters by department.
  await page.goto('/agents');
  await page.getByLabel('Department').selectOption('support');
  await expect(page.getByTestId('agent-Tara')).toBeVisible();
  await expect(page.getByTestId('agent-Rhea')).toBeVisible();
  await expect(page.getByTestId('agent-Ben')).toHaveCount(0);
  await page.getByLabel('Department').selectOption('delivery');
  await expect(page.getByTestId('agent-Ben')).toBeVisible();
  await expect(page.getByTestId('agent-Tara')).toHaveCount(0);
  await page.screenshot({ path: shot('hr-department'), fullPage: true });
});

test('a custom workflow with custom roles runs a card end to end; a failure route sends it back', async () => {
  // A card with a failure on the first resolve attempt: resolve -> escalate -> triage (rework) -> resolve -> done.
  const ref = await createTicket('Customer cannot log in', { resolve: ['fail', 'ok'] });
  const done = await stageWait(ref, 'done', 'done', 180_000);
  expect(done?.rework_round).toBe(1);
  const path = await q<{ role_key: string; stage: string; name: string }>(
    `SELECT a.role_key, s.stage, a.name FROM shifts s JOIN agents a ON a.id = s.agent_id
       JOIN cards c ON c.id = s.card_id WHERE c.ref=$1 ORDER BY s.started_at`,
    [ref],
  );
  expect(path.map((p) => `${p.name}:${p.role_key}:${p.stage}`)).toEqual([
    'Tara:triager:triage',
    'Rhea:responder:resolve',
    'Tara:triager:triage',
    'Rhea:responder:resolve',
  ]);
  const handoffs = await q<{ outcome: string }>(
    `SELECT h.outcome FROM card_handoffs h JOIN cards c ON c.id = h.card_id WHERE c.ref=$1 ORDER BY h.created_at, h.event_seq`,
    [ref],
  );
  expect(handoffs.map((h) => h.outcome)).toEqual(['triaged', 'escalate', 'triaged', 'resolved']);
  await page.goto('/p/SUP/board');
  await expect(page.getByTestId('column-Done')).toContainText('Customer cannot log in');
  await page.screenshot({ path: shot('custom-board'), fullPage: true });
});

test('changing a workflow creates v2; a card in flight finishes on v1, new cards start on v2', async () => {
  // No responder is on shift: the card waits in Resolve, in flight on v1, while the workflow changes.
  const rhea = (
    await q<{ id: string }>(`SELECT id FROM agents WHERE name='Rhea' AND org_id=$1`, [ownerId])
  )[0]?.id;
  expect((await api.post(`/api/agents/${rhea}/fire`, { data: {} })).status()).toBe(200);
  const inFlight = await createTicket('Refund request');
  await stageWait(inFlight, 'resolve', 'queued', 120_000);
  const v1 = (await row(inFlight))?.workflow_version_id as string;
  expect(
    (await q<{ version: number }>(`SELECT version FROM workflow_versions WHERE id=$1`, [v1]))[0]?.version,
  ).toBe(1);

  // v2: the Resolve criterion changes. Edited in the workflow editor from the active v1.
  await page.goto('/org?tab=workflows');
  const card = page.getByTestId('workflow-support');
  await expect(card).toContainText('1 card(s) in flight on this version');
  await card.getByRole('button', { name: 'New version of support v1' }).click();
  const editor = page.getByTestId('workflow-editor');
  await editor
    .getByLabel('Stage resolve done criteria')
    .fill('The customer has an answer and a survey link.');
  await page.getByRole('button', { name: 'Save and submit for approval' }).click();
  await waitFor(
    'v2 is pending approval',
    () =>
      q<{ version: number; status: string }>(
        `SELECT version, status FROM workflow_versions WHERE key='support' ORDER BY version`,
      ),
    (r) => r.length === 2 && r[1]?.status === 'pending_approval',
    15_000,
  );
  await page.goto('/desk');
  await deskCard(page, 'Approve workflow "Support triage" (v2)')
    .getByRole('button', { name: 'Approve' })
    .click();
  await waitFor(
    'v2 is active, v1 superseded',
    () => q<{ status: string }>(`SELECT status FROM workflow_versions WHERE key='support' ORDER BY version`),
    (r) => r[0]?.status === 'superseded' && r[1]?.status === 'active',
    15_000,
  );
  // Nothing changed for the card in flight.
  expect(await row(inFlight)).toMatchObject({ stage: 'resolve', status: 'queued', workflow_version_id: v1 });
  await page.goto('/org?tab=workflows');
  await expect(page.getByTestId('workflow-support').getByTestId('version-1')).toContainText(
    '1 card(s) in flight on this version',
  );
  await page.screenshot({ path: shot('versions'), fullPage: true });

  // A new card starts on v2; a new responder is hired and both finish: the old card on v1, the new one on v2.
  const fresh = await createTicket('Invoice question');
  const v2 = (
    await q<{ id: string }>(`SELECT id FROM workflow_versions WHERE key='support' AND version=2`)
  )[0]?.id;
  expect((await row(fresh))?.workflow_version_id).toBe(v2);
  await stageWait(fresh, 'resolve', 'queued', 120_000);
  const rory = await api.post('/api/agents', {
    data: {
      name: 'Rory',
      roleKey: 'responder',
      seniority: 'senior',
      workstationId,
      projectId,
      runtime: 'mock',
      model: 'mock',
    },
  });
  expect(rory.status(), await rory.text()).toBe(201);
  const finished = await stageWait(inFlight, 'done', 'done', 120_000);
  await stageWait(fresh, 'done', 'done', 120_000);
  expect(finished?.workflow_version_id).toBe(v1);
  expect((await row(fresh))?.workflow_version_id).toBe(v2);
  await page.goto('/org?tab=workflows');
  await expect(page.getByTestId('workflow-support').getByTestId('version-1')).not.toContainText('in flight');
});

test('extending a built-in role: the owner adds instructions and standing orders; core rules stay', async () => {
  await page.goto('/org');
  await expect(page.getByTestId('builtin-roles').getByText('Built in').first()).toBeVisible();
  await page.getByRole('button', { name: 'Extend reviewer' }).click();
  const rules = page.getByTestId('core-rules');
  await expect(rules).toContainText('cannot be changed');
  const before = (await (await api.get('/api/roles')).json()).roles.find(
    (r: any) => r.definition.key === 'reviewer',
  ).definition.coreRules;
  await page.getByLabel('Extra instructions').fill('Also check accessibility.');
  await page.getByLabel('Standing orders (one per line)').fill('Never approve without a screenshot.');
  await page.getByRole('button', { name: 'Save extensions' }).click();
  await expect(page.getByTestId('extended-reviewer')).toBeVisible();
  const reviewer = (await (await api.get('/api/roles')).json()).roles.find(
    (r: any) => r.definition.key === 'reviewer',
  );
  expect(reviewer.definition.coreRules).toEqual(before);
  expect(reviewer.extensions).toMatchObject({
    instructions: 'Also check accessibility.',
    standingOrders: ['Never approve without a screenshot.'],
  });
  // Core rules cannot even be sent.
  const bad = await api.put('/api/roles/reviewer/extensions', { data: { instructions: 'x', coreRules: [] } });
  expect(bad.status()).toBe(400);
  // Built-in roles and workflows cannot be removed or replaced.
  const cat = await (await api.get('/api/org/catalogue')).json();
  const reviewerId = cat.roles.find((r: any) => r.key === 'reviewer').versions[0].id;
  expect((await api.delete(`/api/roles/${reviewerId}`)).status()).toBe(403);
  const codeId = cat.workflows.find((w: any) => w.key === 'code').versions[0].id;
  expect((await api.delete(`/api/workflows/${codeId}`)).status()).toBe(403);
  expect((await api.post('/api/workflows', { data: { ...supportWorkflow(), key: 'code' } })).status()).toBe(
    409,
  );
});

test("an additional manager uses the owner's workflows and roles but cannot change the catalogue", async () => {
  const share = await api.post(`/api/projects/${projectId}/members`, { data: { email: DESIGNGUEST.email } });
  expect(share.status(), await share.text()).toBe(201);
  expect((await guestApi.post(`/api/projects/${projectId}/members/accept`, { data: {} })).status()).toBe(200);
  const proj = (await (await guestApi.get('/api/projects')).json()).projects.find(
    (p: any) => p.key === 'SUP',
  );
  expect(proj.orgId).toBe(ownerId);
  // The Organization page shows the owner's catalogue, read only.
  await guestPage.goto(`/org?project=${projectId}`);
  await expect(guestPage.getByTestId('read-only-note')).toContainText('only the owner can change them');
  await expect(guestPage.getByTestId('role-triager')).toBeVisible();
  await expect(guestPage.getByRole('button', { name: 'New custom role' })).toHaveCount(0);
  await expect(guestPage.getByRole('button', { name: 'Extend builder' })).toHaveCount(0);
  await guestPage.screenshot({ path: shot('guest'), fullPage: true });
  // The API agrees.
  const ctx = `?projectId=${projectId}`;
  expect(
    (
      await guestApi.put(`/api/roles/builder/extensions${ctx}`, { data: { instructions: 'sneaky' } })
    ).status(),
  ).toBe(403);
  expect((await guestApi.post(`/api/roles${ctx}`, { data: triager({ key: 'sneaky' }) })).status()).toBe(403);
  expect((await guestApi.post(`/api/workflows${ctx}`, { data: supportWorkflow() })).status()).toBe(403);
  expect((await guestApi.post(`/api/departments${ctx}`, { data: { name: 'sneaky' } })).status()).toBe(403);
  // Their Hire form lists the owner's custom roles for the shared project; they hire one on their own workstation.
  const code = (await (await guestApi.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  const anonApi = await apiAnon();
  const paired = await anonApi.post('/api/runner/pair', {
    data: { code, name: 'Guest Box', platform: 'linux', hostname: 'guest-box', runnerVersion: '0.0.0-e2e' },
  });
  guestWs = ((await paired.json()) as { workstationId: string }).workstationId;
  await anonApi.dispose();
  const roles = (await (await guestApi.get(`/api/roles${ctx}`)).json()).roles.map(
    (r: any) => r.definition.key,
  );
  expect(roles).toEqual(expect.arrayContaining(['triager', 'responder']));
  const hired = await guestApi.post('/api/agents', {
    data: {
      name: 'Gia',
      roleKey: 'triager',
      seniority: 'junior',
      workstationId: guestWs,
      projectId,
      runtime: 'mock',
      model: 'mock',
    },
  });
  expect(hired.status(), await hired.text()).toBe(201);
  // The shared project's cards use the owner's workflow: the guest creates one with its custom field.
  const card = await guestApi.post('/api/cards', {
    data: { projectId, title: 'Guest ticket', cardType: 'support', fields: { customer: 'Globex' } },
  });
  expect(card.status(), await card.text()).toBe(201);
  const ref = (await card.json()).card.ref as string;
  expect((await row(ref))?.workflow_version_id).toBe(
    (await q<{ id: string }>(`SELECT id FROM workflow_versions WHERE key='support' AND status='active'`))[0]
      ?.id,
  );
  // Nothing of the owner's catalogue changed.
  expect((await q(`SELECT 1 FROM role_definitions WHERE key='sneaky'`)).length).toBe(0);
  expect(
    (
      await q(`SELECT 1 FROM role_extensions WHERE org_id=$1 AND extensions->>'instructions'='sneaky'`, [
        ownerId,
      ])
    ).length,
  ).toBe(0);
});

async function apiAnon(): Promise<APIRequestContext> {
  const { request } = await import('@playwright/test');
  return request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
}
