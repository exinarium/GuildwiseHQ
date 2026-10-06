import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, paths, SANDBOXER } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';
import { expandWorkstation } from '../support/ui.ts';

// A runner that reports its mock runtime as unsandboxed (test-only AOM_RUNNER_MOCK_SANDBOX, the real runtime reports it
// from the platform and config): the warning shows on the workstation, on the agent's HR card, and the Hire form
// asks for a confirmation.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('sandbox');
let api: APIRequestContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, SANDBOXER);
  api = await apiAs(SANDBOXER.email, SANDBOXER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('an unsandboxed runtime is warned about on the workstation, the agent card and the Hire form', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Sandbox Box', HOME);
  startRunner({ AOM_RUNNER_MOCK_SANDBOX: 'unsandboxed' }, HOME);
  const ws = await waitFor(
    'runner connected with its sandbox state',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true && w[0]?.runtimes?.some((r: any) => r.sandbox === 'unsandboxed'),
    30_000,
  );
  const workstationId = ws[0].id as string;
  // the DevOps engineer must never start a real session
  const devops = (await (await api.get('/api/agents')).json()).agents.find((a: any) => a.isDevops);
  if (devops)
    expect(
      (await api.patch(`/api/agents/${devops.id}`, { data: { runtime: 'mock', model: 'mock' } })).status(),
    ).toBe(200);
  let hired = await api.post('/api/agents', {
    data: { name: 'Sal', roleKey: 'reviewer', seniority: 'senior', workstationId, runtime: 'mock' },
  });
  expect(hired.status()).toBe(409);
  expect((await hired.json()).error.code).toBe('unsandboxed_ack_required');
  hired = await api.post('/api/agents', {
    data: {
      name: 'Sal',
      roleKey: 'reviewer',
      seniority: 'senior',
      workstationId,
      runtime: 'mock',
      acknowledgeUnsandboxed: true,
    },
  });
  expect(hired.status(), await hired.text()).toBe(201);
  expect((await hired.json()).agent?.sandbox ?? 'unsandboxed').toBe('unsandboxed');

  await page.goto('/workstations');
  const station = page.getByTestId('workstation-Sandbox Box');
  await expandWorkstation(station);
  await expect(station.getByTestId('sandbox-warning')).toContainText('without an OS sandbox');
  await expect(station.getByTestId('sandbox-warning')).toContainText('runner token');

  await page.goto('/agents');
  const card = page.getByTestId('agent-Sal');
  await expect(card.getByTestId('agent-sandbox-warning')).toContainText(
    'Runs without an OS sandbox on Sandbox Box',
  );
  await expect(card.getByTestId('sandbox-docs-link')).toHaveAttribute('href', /RUNNER\.md/);

  await page.getByRole('button', { name: 'Hire agent' }).first().click();
  const form = page.getByRole('form', { name: 'Hire agent' });
  await form.getByLabel('Runtime').selectOption('mock');
  await expect(form.getByTestId('hire-sandbox-warning')).toBeVisible();
  await form.getByLabel('Name', { exact: true }).fill('Tom');
  await form.getByRole('button', { name: 'Hire', exact: true }).click();
  await expect(form.getByText('Confirm that you accept')).toBeVisible();
  await expect(page.getByTestId('agent-Tom')).toHaveCount(0);
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: 'Hire', exact: true }).click();
  await expect(page.getByTestId('agent-Tom')).toBeVisible();
});
