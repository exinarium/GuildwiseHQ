import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, request, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, HR, HRGUEST, paths } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// M9: HR board, track record, metrics, recommendations (docs/PLAN.md M9 AC). One owner with a mock runner, a builder on
// Opus and a reviewer, project HRB on the toy repo. Cards stop at the Test queue (no tester is hired), so every number
// below is the track record of build and review shifts only. Refs are deterministic because cards are created in order.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('hr');
let page: Page;
let api: APIRequestContext;
let guestApi: APIRequestContext;
let guestPage: Page;
let workstationId: string;
let projectId: string;
let repoId: string;
let ownerId: string;
let beaId: string;

const SPEC = {
  context: 'The toy project needs a feature.',
  requirements: 'Add the thing to the toy project, with a small test.',
  acceptanceCriteria: ['It works', 'It is tested'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};

async function createCard(title: string, mock?: Record<string, string[]>): Promise<string> {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'feature',
      repoId,
      completionAction: 'push_branch',
      fields: { ...SPEC, ...(mock ? { mock } : {}) },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).card.ref as string;
}

const cardRow = async (ref: string) =>
  (
    await q<{ stage: string; status: string; rework_round: number }>('SELECT * FROM cards WHERE ref=$1', [
      ref,
    ])
  )[0];
/** The card reached the Test queue: built and approved by the reviewer. */
const inTest = (ref: string) =>
  waitFor(
    `${ref} in the test queue`,
    () => cardRow(ref),
    (c) => c?.stage === 'test' && c.status === 'queued',
    120_000,
  );

const shot = (name: string) => join(paths.vaults, `hr-${name}.png`);
const agentCard = (name: string, p: Page = page) => p.getByTestId(`agent-${name}`);

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, HR);
  await inviteAndAccept(admin, HRGUEST);
  api = await apiAs(HR.email, HR.password);
  guestApi = await apiAs(HRGUEST.email, HRGUEST.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  guestPage = await (await browser.newContext({ storageState: await guestApi.storageState() })).newPage();
  ownerId = (await q<{ id: string }>('SELECT id FROM users WHERE email=$1', [HR.email]))[0]?.id as string;
});

test('setup: a paired mock runner, project HRB on the toy repo, a senior reviewer and a builder hired from the form', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'HR Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '300' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id;
  const proj = await api.post('/api/projects', { data: { key: 'HRB', name: 'HR board project' } });
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
  // CI must never start a real session: the DevOps engineer defaults to the real runtime on this machine.
  const devops = (await (await api.get('/api/agents')).json()).agents.find((a: any) => a.isDevops);
  expect(
    (await api.patch(`/api/agents/${devops.id}`, { data: { runtime: 'mock', model: 'mock' } })).status(),
  ).toBe(200);
  const rae = await api.post('/api/agents', {
    data: {
      name: 'Rae',
      roleKey: 'reviewer',
      seniority: 'senior',
      workstationId,
      projectId,
      runtime: 'mock',
    },
  });
  expect(rae.status(), await rae.text()).toBe(201);

  // Hire the builder from the HR board: themed name generator, then the model typed in.
  await page.goto('/agents');
  await expect(page.getByRole('heading', { name: 'Agents' })).toBeVisible();
  await page.getByRole('button', { name: 'Hire agent' }).first().click();
  const form = page.getByRole('form', { name: 'Hire agent' });
  await form.getByLabel('Role', { exact: true }).selectOption({ label: 'Builder' });
  await form.getByLabel('Runtime').selectOption('mock');
  await form.getByLabel('Model').fill('opus');
  await form.getByLabel('Name theme').selectOption('birds');
  const chip = form.getByTestId('name-suggestions').getByRole('button').first();
  await expect(chip).toBeVisible();
  const birds = ['Heron', 'Kestrel', 'Wren', 'Osprey', 'Finch', 'Plover'];
  expect(birds).toContain(await chip.innerText());
  await form.getByLabel('Name', { exact: true }).fill('Bea');
  await form.getByRole('button', { name: 'Hire', exact: true }).click();
  await expect(agentCard('Bea')).toBeVisible();
  beaId = (await q<{ id: string }>(`SELECT id FROM agents WHERE name='Bea' AND org_id=$1`, [ownerId]))[0]
    ?.id as string;
  // The agent card: avatar, role, model, status, hiring manager and no hire cap
  const card = agentCard('Bea');
  await expect(card.getByTestId('avatar')).toBeVisible();
  await expect(card.getByTestId('agent-model')).toContainText('mock · opus');
  await expect(card.getByTestId('agent-status')).toHaveText('idle');
  await expect(card.getByTestId('agent-hired-by')).toContainText(`Hired by ${HR.name}`);
  await expect(card.getByTestId('agent-current-card')).toHaveText('No current card');
});

test('stats: four clean small cards give exact numbers against the team average, and a model-down recommendation', async () => {
  test.setTimeout(240_000);
  for (const n of [1, 2, 3, 4]) {
    const ref = await createCard(`Clean card ${n}`);
    expect(ref).toBe(`HRB-${n}`);
    await inTest(ref);
  }
  await page.goto('/agents');
  const bea = agentCard('Bea');
  // Bea touched and finished 4 cards; no question, no bounce, no bug. She is the only builder, so the team average is hers.
  await expect(bea.getByTestId('stat-cards-done').getByTestId('stat-value')).toHaveText('4');
  await expect(bea.getByTestId('stat-cards-done').getByTestId('stat-team')).toHaveText('team 4');
  await expect(bea.getByTestId('stat-blocked-rate').getByTestId('stat-value')).toHaveText('0%');
  await expect(bea.getByTestId('stat-rework-rate').getByTestId('stat-value')).toHaveText('0%');
  await expect(bea.getByTestId('stat-bugs-escaped').getByTestId('stat-value')).toHaveText('0%');
  await expect(bea.getByTestId('stat-rework-rate').getByTestId('stat-team')).toHaveText('team 0%');
  // Tokens per card: the mock reports 1000 + 200 tokens per shift, one build shift per card
  await expect(bea.getByTestId('stat-tokens-per-card').getByTestId('stat-value')).toHaveText('1.2k');
  // Utilisation exists and is tiny (a few seconds on shift against an hour floor)
  await expect(bea.getByTestId('stat-utilisation').getByTestId('stat-value')).toHaveText(/^(<1|\d)%?/);
  // Work quality: 4 reviews, all approved with score 4, no bounces; the mock builder commits a test file with each card
  await expect(bea.getByTestId('quality-score')).toContainText('4.0 of 5');
  await expect(bea.getByTestId('quality-reasons')).toContainText('No review bounces');
  await expect(bea.getByTestId('quality-coverage')).toContainText('100% (4 of 4 cards)');
  await expect(bea.getByTestId('quality-bugs')).toContainText('0');
  // The reviewer has its own card without a quality panel
  await expect(agentCard('Rae').getByTestId('work-quality')).toHaveCount(0);
  await expect(agentCard('Rae').getByTestId('stat-cards-done').getByTestId('stat-value')).toHaveText('4');

  // Cheaper model would do: strong model on small, clean work
  const rec = page.getByTestId('rec-model_down');
  await expect(rec).toBeVisible();
  await expect(rec).toContainText('Bea does small, clean work: sonnet would do');
  await rec.getByText('Evidence').click();
  await expect(rec.getByTestId('rec-evidence')).toContainText('Small cards: 4 of 4');
  await page.screenshot({ path: shot('board'), fullPage: true });
  await rec.getByTestId('apply-model_down').click();
  await expect(rec.getByTestId('rec-applied')).toContainText('Bea moved from opus to sonnet');
  // Applied through a real AgentChanged event
  const ev = await waitFor(
    'AgentChanged event',
    () =>
      q<{ payload: any; actor_id: string }>(
        `SELECT payload, actor_id FROM events WHERE type='AgentChanged' AND payload->>'agentId'=$1 ORDER BY seq DESC LIMIT 1`,
        [beaId],
      ),
    (r) => r.length > 0,
    10_000,
  );
  expect(ev[0]?.payload.changes).toEqual({ model: 'sonnet' });
  expect(ev[0]?.actor_id).toBe(ownerId);
  await expect(agentCard('Bea').getByTestId('agent-model')).toContainText('mock · sonnet');
  await expect(page.getByTestId('rec-model_down')).toHaveCount(0);
});

test('change model and role from the card', async () => {
  const bea = agentCard('Bea');
  await bea.getByRole('button', { name: 'Change model of Bea' }).click();
  const form = page.getByRole('form', { name: 'Change model' });
  await form.getByLabel('Model').fill('haiku');
  await form.getByRole('button', { name: 'Change model' }).click();
  await expect(bea.getByTestId('agent-model')).toContainText('haiku');
  await bea.getByRole('button', { name: 'Change role of Bea' }).click();
  const roleForm = page.getByRole('form', { name: 'Change role' });
  await expect(roleForm.getByLabel('Role')).toHaveValue('builder');
  await page.keyboard.press('Escape');
  // back to a rung that exists on the ladder for the next rules
  await bea.getByRole('button', { name: 'Change model of Bea' }).click();
  await page.getByRole('form', { name: 'Change model' }).getByLabel('Model').fill('sonnet');
  await page
    .getByRole('form', { name: 'Change model' })
    .getByRole('button', { name: 'Change model' })
    .click();
  await expect(bea.getByTestId('agent-model')).toContainText('sonnet');
});

test('rework: a recurring review reason becomes a proposed standing order; the manager approves it on the desk', async () => {
  test.setTimeout(300_000);
  // Three cards, each bounced once for a missed requirement and approved on the second round.
  for (const n of [5, 6, 7]) {
    const ref = await createCard(`Bounced card ${n}`, { review: ['changes', 'ok'] });
    expect(ref).toBe(`HRB-${n}`);
    await inTest(ref);
    expect((await cardRow(ref))?.rework_round).toBe(1);
  }
  await page.goto('/agents');
  const bea = agentCard('Bea');
  // 3 of 7 submitted cards were bounced
  await expect(bea.getByTestId('stat-rework-rate').getByTestId('stat-value')).toHaveText('43%');
  await expect(bea.getByTestId('stat-cards-done').getByTestId('stat-value')).toHaveText('7');
  await expect(bea.getByTestId('reason-missed_requirement')).toContainText('3');
  await expect(bea.getByTestId('quality-criteria')).toContainText('3');
  await expect(bea.getByTestId('quality-rounds')).toContainText('max 1');
  // scores: 4 clean approvals (4), 3 bounces (2), 3 re-approvals (4) = 34 / 10
  await expect(bea.getByTestId('quality-score')).toContainText('3.4 of 5');
  const rec = page.getByTestId('rec-rework_reason');
  await expect(rec).toBeVisible();
  await expect(rec).toContainText('Missed requirement');
  await rec.getByText('Evidence').click();
  await expect(rec.getByTestId('rec-evidence')).toContainText('Rework rate: 43% (3 of 7 cards)');
  await expect(rec.getByTestId('rec-proposal')).toContainText('acceptance criterion');
  await page.screenshot({ path: shot('rework'), fullPage: true });
});

test('an additional manager sees HR actions only for their own hires', async () => {
  const share = await api.post(`/api/projects/${projectId}/members`, { data: { email: HRGUEST.email } });
  expect(share.status(), await share.text()).toBe(201);
  expect((await guestApi.post(`/api/projects/${projectId}/members/accept`, { data: {} })).status()).toBe(200);
  // the guest's own workstation (paired over the API: nothing needs to run for hiring)
  const code = (await (await guestApi.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  const anon = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
  const paired = await anon.post('/api/runner/pair', {
    data: { code, name: 'Guest Box', platform: 'linux', hostname: 'guest-box', runnerVersion: '0.0.0-e2e' },
  });
  expect(paired.ok(), await paired.text()).toBeTruthy();
  const guestWs = ((await paired.json()) as { workstationId: string }).workstationId;
  await anon.dispose();
  const hired = await guestApi.post('/api/agents', {
    data: {
      name: 'Gus',
      roleKey: 'builder',
      seniority: 'junior',
      workstationId: guestWs,
      projectId,
      runtime: 'mock',
      model: 'sonnet',
    },
  });
  expect(hired.status(), await hired.text()).toBe(201);

  await guestPage.goto('/agents');
  // Bea (the owner's hire) is read-only for the guest, and so are the recommendations about her
  const bea = agentCard('Bea', guestPage);
  await expect(bea).toBeVisible();
  await expect(bea).toHaveAttribute('data-editable', 'false');
  await expect(bea.getByTestId('agent-readonly')).toBeVisible();
  await expect(bea.getByRole('button', { name: 'Fire Bea' })).toHaveCount(0);
  await expect(bea.getByRole('button', { name: 'Change model of Bea' })).toHaveCount(0);
  await expect(bea.getByTestId('stat-cards-done').getByTestId('stat-value')).toHaveText('7');
  const rec = guestPage.getByTestId('rec-rework_reason');
  await expect(rec).toBeVisible();
  await expect(rec.getByTestId('apply-rework_reason')).toHaveCount(0);
  await expect(rec).toContainText('Not yours to apply');
  // Gus is theirs
  const gus = agentCard('Gus', guestPage);
  await expect(gus).toHaveAttribute('data-editable', 'true');
  await expect(gus.getByRole('button', { name: 'Change model of Gus' })).toBeVisible();
  await expect(gus.getByRole('button', { name: 'Fire Gus' })).toBeVisible();
  // and the API agrees
  expect((await guestApi.patch(`/api/agents/${beaId}`, { data: { model: 'opus' } })).status()).toBe(403);
  const recId = await rec.getAttribute('data-rec-id');
  expect(
    (await guestApi.post(`/api/hr/recommendations/${encodeURIComponent(recId as string)}/apply`)).status(),
  ).toBe(403);
  await guestPage.screenshot({ path: shot('guest'), fullPage: true });
});

test('applying the standing-order recommendation puts an approval on the desk; approving it writes the ledger', async () => {
  await page.goto('/agents');
  const rec = page.getByTestId('rec-rework_reason');
  await rec.getByTestId('apply-rework_reason').click();
  await expect(rec.getByTestId('rec-applied')).toContainText('Proposed a standing order on the desk');
  const item = (
    await waitFor(
      'the standing order proposal on the desk',
      () =>
        q<{ id: string; status: string; kind: string; body: string; project_id: string | null }>(
          `SELECT id, status, kind, body, project_id FROM desk_items WHERE subkind='standing_order'`,
        ),
      (r) => r.length === 1,
      10_000,
    )
  )[0]!;
  expect(item).toMatchObject({ status: 'open', kind: 'approval', project_id: null });
  await expect(page.getByTestId('rec-rework_reason')).toHaveCount(0);

  await page.goto('/desk');
  const card = page.getByRole('article', { name: /Add a standing order/ });
  await expect(card).toBeVisible();
  await card
    .getByLabel('Standing order (editable)')
    .fill('Always walk through every acceptance criterion before you hand off.');
  await card.getByRole('button', { name: 'Approve' }).click();
  const entry = await waitFor(
    'standing order in the ledger',
    () =>
      q<{ title: string; body: string; project_id: string | null }>(
        `SELECT title, body, project_id FROM ledger_entries WHERE scope='standing_order' AND source_desk_item_id=$1`,
        [item.id],
      ),
    (r) => r.length === 1,
    10_000,
  );
  expect(entry[0]).toMatchObject({
    body: 'Always walk through every acceptance criterion before you hand off.',
    project_id: null,
  });
  const applied = await q<{ payload: any }>(
    `SELECT payload FROM events WHERE type='RecommendationApplied' AND payload->>'orgId'=$1`,
    [ownerId],
  );
  expect(applied.map((e) => e.payload.kind).sort()).toEqual(['model_down', 'rework_reason']);
});

test('metrics dashboard: throughput, blocked time, bounce rate, bugs, duration and queue depth', async () => {
  await page.goto('/metrics');
  await expect(page.getByRole('heading', { name: 'Metrics' })).toBeVisible();
  const m = page.getByTestId('metrics');
  await expect(m.getByTestId('metric-throughput-total')).toContainText('0'); // nothing finalized: cards wait for a tester
  await expect(m.getByTestId('metric-blocked')).toContainText('Cards held up');
  const bea = m.getByTestId('bounce-Bea');
  await expect(bea).toContainText('7'); // submitted
  await expect(bea).toContainText('3'); // review bounces
  await expect(bea).toContainText('43%');
  await expect(m.getByTestId('metric-bugs-total')).toContainText('0');
  await expect(m.getByTestId('metric-queue')).toContainText('Test');
  await expect(m.getByTestId('metric-queue').getByRole('listitem').filter({ hasText: 'Test' })).toContainText(
    '7',
  );
  await expect(m.getByTestId('metric-duration')).toContainText('Cards finished');
  await expect(page.getByRole('img', { name: /Cards finalized per day/ })).toBeVisible();
  await page.screenshot({ path: shot('metrics'), fullPage: true });
});

test('built-in role defaults: the owner sees the new default version, resets after seeing what is removed', async () => {
  // The owner extended the Tester against v1; the app now ships v4 (bumped by the phases work).
  await q(
    `INSERT INTO role_extensions (org_id, role_key, base_version, extensions, updated_at)
     VALUES ($1, 'tester', 1, $2, now())`,
    [
      ownerId,
      JSON.stringify({
        instructions: 'Always run lint first.',
        skills: ['lint'],
        standingOrders: ['Never skip the e2e suite'],
      }),
    ],
  );
  await page.goto('/agents');
  const update = page.getByTestId('role-update-tester');
  await expect(update).toBeVisible();
  await expect(update).toContainText('new default (version 4)');
  await update.getByTestId('reset-tester').click();
  const diff = page.getByTestId('reset-diff');
  await expect(diff).toContainText('Extra instructions: Always run lint first.');
  await expect(diff).toContainText('Skill: lint');
  await expect(diff).toContainText('Standing order: Never skip the e2e suite');
  await page.screenshot({ path: shot('reset-dialog') });
  await page.getByTestId('confirm-reset').click();
  await expect(page.getByTestId('role-update-tester')).toHaveCount(0);
  const ev = await waitFor(
    'RoleResetToDefault event',
    () => q<{ payload: any }>(`SELECT payload FROM events WHERE type='RoleResetToDefault'`),
    (r) => r.length === 1,
    10_000,
  );
  expect(ev[0]?.payload).toMatchObject({
    roleKey: 'tester',
    toVersion: 4,
    droppedExtensions: { skills: ['lint'] },
  });
  expect(await q(`SELECT 1 FROM role_extensions WHERE org_id=$1`, [ownerId])).toHaveLength(0);
});

test('fire: Bea can be let go from the HR card', async () => {
  await page.goto('/agents');
  await agentCard('Bea').getByRole('button', { name: 'Fire Bea' }).click();
  await page.getByRole('button', { name: 'Confirm fire' }).click();
  await expect(agentCard('Bea')).toHaveCount(0);
  expect((await q<{ status: string }>(`SELECT status FROM agents WHERE id=$1`, [beaId]))[0]?.status).toBe(
    'retired',
  );
});
