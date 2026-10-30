import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, paths, SCHEDGUEST, SCHEDULER } from '../support/env.ts';
import { deleteMailFor, waitForMail, waitForMailMatching } from '../support/mail.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// Part B of the restructure: schedules are a trigger and one action. One owner with a mock runner (a BA, a builder and
// a reviewer), one guest on a shared project, a local HTTP server standing in for Slack, Mailpit for the digests and a
// fixture file standing in for GitHub. No network, no tokens.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('scheduler');
let page: Page;
let guestPage: Page;
let api: APIRequestContext;
let guestApi: APIRequestContext;
let projectId: string;
let repoId: string;
let workstationId: string;
let hooks: Server;
let hookUrl = '';
const hits: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
let hookStatuses: number[] = [];
// A second receiver for the agent's output: the "Tell Slack" hook fires for every finalized card in SCH.
let outHooks: Server;
let outUrl = '';
const outHits: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
let outStatuses: number[] = [];

const clock = async (advanceMs: number): Promise<string> => {
  const r = await fetch(`${BASE_URL}/api/test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify({ advanceMs }),
  });
  expect(r.ok).toBeTruthy();
  return ((await r.json()) as { now: string }).now;
};
const runsOf = (name: string) =>
  q<any>(
    `SELECT r.* FROM schedule_runs r JOIN schedules s ON s.id = r.schedule_id WHERE s.name=$1 ORDER BY r.started_at, r.id`,
    [name],
  );
const scheduleId = async (name: string) =>
  (await q<any>('SELECT id FROM schedules WHERE name=$1', [name]))[0]?.id as string;

const SPEC = {
  context: 'A feature for the toy project.',
  requirements: 'Do the thing.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run it',
};

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, SCHEDULER);
  await inviteAndAccept(admin, SCHEDGUEST);
  api = await apiAs(SCHEDULER.email, SCHEDULER.password);
  guestApi = await apiAs(SCHEDGUEST.email, SCHEDGUEST.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
  guestPage = await (await browser.newContext({ storageState: await guestApi.storageState() })).newPage();
  hooks = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      hits.push({ headers: req.headers, body });
      res.statusCode = hookStatuses.shift() ?? 200;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => hooks.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(hooks.address() as AddressInfo).port}/hook`;
  outHooks = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      outHits.push({ headers: req.headers, body });
      res.statusCode = outStatuses.shift() ?? 200;
      res.end('ok');
    });
  });
  await new Promise<void>((r) => outHooks.listen(0, '127.0.0.1', r));
  outUrl = `http://127.0.0.1:${(outHooks.address() as AddressInfo).port}/output`;
});
test.afterAll(async () => {
  hooks?.close();
  outHooks?.close();
});

const signatureOf = (secret: string, hit: { headers: IncomingHttpHeaders; body: string }) =>
  `sha256=${createHmac('sha256', secret)
    .update(`${String(hit.headers['x-aom-timestamp'])}.${hit.body}`)
    .digest('hex')}`;

/**
 * The lean flow plans and designs every card; this spec hires no planner, architect or pre-reviewer. The card is moved
 * to Build (the mock builder hands off with a note), then from Pre-review to Finalize (the BA merges), and is done.
 */
async function buildAndFinalize(c: { id: string; ref: string }): Promise<void> {
  await waitFor(
    `${c.ref} queued`,
    async () => (await q<any>('SELECT stage, status FROM cards WHERE id=$1', [c.id]))[0],
    (x) => x?.status === 'queued',
    30_000,
  );
  const build = await api.post(`/api/cards/${c.id}/move`, {
    data: { toStage: 'build', reason: 'planned and designed elsewhere' },
  });
  expect(build.ok(), await build.text()).toBeTruthy();
  await waitFor(
    `${c.ref} built`,
    async () => (await q<any>('SELECT stage FROM cards WHERE id=$1', [c.id]))[0],
    (x) => x?.stage === 'pre_review' || x?.stage === 'review',
    120_000,
  );
  const move = await api.post(`/api/cards/${c.id}/move`, {
    data: { toStage: 'finalize', reason: 'review and test done elsewhere' },
  });
  expect(move.ok(), await move.text()).toBeTruthy();
  await waitFor(
    `${c.ref} finalized`,
    async () => (await q<any>('SELECT status FROM cards WHERE id=$1', [c.id]))[0],
    (x) => x?.status === 'done',
    120_000,
  );
}

test('setup: a runner with a BA, a builder and a reviewer, project SCH on the toy repo, shared with a guest', async () => {
  mkdirSync(paths.vaults, { recursive: true });
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Scheduler Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  // the fixture the runner's issue poll reads in the mock runtime (GitHub and Jira are never reached)
  writeFileSync(
    join(HOME, 'mock-issues.json'),
    JSON.stringify({
      github: [
        {
          key: 'acme/toy#41',
          title: 'Export fails on empty lists',
          url: 'https://github.com/acme/toy/issues/41',
          body: 'Exporting an empty list throws.',
          labels: ['bug'],
        },
      ],
      jira: [],
    }),
  );
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id as string;
  const proj = await api.post('/api/projects', { data: { key: 'SCH', name: 'Scheduled work' } });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  // Manual QA after Finalize is on for real projects; this spec runs cards to Done, so it is off here.
  expect((await api.put(`/api/projects/${projectId}/manual-qa`, { data: { enabled: false } })).status()).toBe(
    200,
  );
  const add = await api.post(`/api/projects/${projectId}/repos`, {
    data: { name: 'toy', remoteUrl: paths.origin, workingBranch: 'main' },
  });
  expect(add.status()).toBe(201);
  repoId = (await add.json()).repos[0].id;
  await waitFor(
    'the workstation holds the toy repo',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0].repos.length,
    (n) => n >= 1,
    30_000,
  );
  for (const [name, roleKey, seniority] of [
    ['Olga', 'ba', 'senior'],
    ['Bob', 'builder', 'junior'],
    ['Ria', 'reviewer', 'senior'],
  ] as const) {
    const hire = await api.post('/api/agents', {
      data: { name, roleKey, seniority, workstationId, runtime: 'mock' },
    });
    expect(hire.status(), await hire.text()).toBe(201);
  }
  await waitFor(
    'DevOps engineer uses the mock runtime',
    async () => (await (await api.get('/api/agents')).json()).agents as any[],
    (a) => a.some((x) => x.isDevops && x.runtime === 'mock'),
    30_000,
  );
  const share = await api.post(`/api/projects/${projectId}/members`, { data: { email: SCHEDGUEST.email } });
  expect(share.status(), await share.text()).toBe(201);
  expect((await guestApi.post(`/api/projects/${projectId}/members/accept`, { data: {} })).ok()).toBeTruthy();
});

test('a cron schedule from the wizard: the card appears when the clock reaches it, and the history says so', async () => {
  await page.goto('/schedules');
  await expect(page.getByTestId('system-hygiene')).toBeVisible();
  await expect(page.getByTestId('system-floor_report')).toBeVisible();
  await page.screenshot({ path: join(paths.vaults, 'schedules-empty.png'), fullPage: true });
  await page.getByTestId('new-schedule').click();
  const wiz = page.getByTestId('schedule-wizard');
  await page.screenshot({ path: join(paths.vaults, 'schedules-wizard-trigger.png') });
  // step 1: when. The default is a cron trigger; pick the hourly preset
  await wiz.getByLabel('Runs').selectOption({ label: 'Every hour' });
  await page.getByTestId('wizard-next').click();
  // step 2: what
  await wiz.getByTestId('tile-create_card').click();
  await page.getByTestId('wizard-next').click();
  // step 3: details
  await wiz.getByLabel('Name', { exact: true }).first().fill('Hourly sweep');
  await wiz.getByLabel('Project').selectOption({ label: 'SCH Scheduled work' });
  await wiz.getByLabel('Title').fill('Sweep the backlog');
  await page.screenshot({ path: join(paths.vaults, 'schedules-wizard-details.png') });
  await page.getByTestId('wizard-save').click();
  const row = page.getByTestId('schedule-Hourly sweep');
  await expect(row).toBeVisible();
  await expect(row.getByTestId('schedule-when')).toContainText('Every hour');
  const id = await scheduleId('Hourly sweep');
  const next = (await q<any>('SELECT next_fire_at FROM schedules WHERE id=$1', [id]))[0].next_fire_at;
  const now = new Date(await clock(0)).getTime();
  await clock(new Date(next).getTime() - now + 2000);
  await waitFor(
    'the cron run',
    () => runsOf('Hourly sweep'),
    (r) => r.length > 0 && r[0].status === 'ok',
    30_000,
  );
  const [r1] = await runsOf('Hourly sweep');
  expect(r1.trigger).toBe('cron');
  const c = (await q<any>('SELECT ref, title, origin FROM cards WHERE schedule_id=$1', [id]))[0];
  expect(c.title).toMatch(/^Sweep the backlog \(\d{4}-\d\d-\d\d\)$/);
  expect(c.origin).toBe('schedule');
  await page.reload();
  const again = page.getByTestId('schedule-Hourly sweep');
  await again.getByTestId('toggle-history').click();
  await expect(again.getByTestId('run-row').first()).toContainText('Created');
  await expect(again.getByTestId('run-row').first()).toContainText('On schedule');
  // stop it: the card it made would otherwise start work in this project
  await again.getByRole('button', { name: 'Pause' }).click();
  await expect(again.getByText('Paused')).toBeVisible();
});

test('an event trigger with a signed Slack webhook: the card is finalized, the hook is told once, the log shows it', async () => {
  await page.goto('/schedules');
  await page.getByTestId('new-schedule').click();
  const wiz = page.getByTestId('schedule-wizard');
  await wiz.getByTestId('tile-event').click();
  await wiz.getByLabel('Event').selectOption({ label: 'A card is finalized' });
  await wiz.getByLabel('Only in project').selectOption({ label: 'SCH Scheduled work' });
  await page.getByTestId('wizard-next').click();
  await wiz.getByTestId('tile-webhook').click();
  await page.getByTestId('wizard-next').click();
  await wiz.getByLabel('Name', { exact: true }).first().fill('Tell Slack');
  await wiz.getByLabel('URL').fill(hookUrl);
  await wiz.getByLabel('Format').selectOption({ label: 'Slack incoming webhook' });
  await wiz.getByLabel('Message').fill('{ref} was finalized in {project}');
  await wiz.getByLabel(/Project/).selectOption({ label: 'SCH Scheduled work' });
  await page.getByTestId('wizard-save').click();
  const secret = (await page.getByTestId('secret-value').textContent())?.trim() ?? '';
  expect(secret).toMatch(/^whsec_/);
  await page.getByRole('button', { name: 'I have saved it' }).click();
  await expect(page.getByTestId('secret-value')).toHaveCount(0);

  // a card goes through build and review and is finalized by the BA
  const before = hits.length;
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title: 'Export archived items',
      cardType: 'feature',
      repoId,
      completionAction: 'merge', // the API takes pr or merge (push_branch was retired)
      fields: { ...SPEC, mock: { build: ['ok'] } },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const c = (await res.json()).card as { id: string; ref: string };
  await buildAndFinalize(c);
  await waitFor(
    'the webhook was called',
    async () => hits.length,
    (n) => n > before,
    30_000,
  );
  const hit = hits[before];
  const body = JSON.parse(hit?.body ?? '{}');
  expect(body).toEqual({ text: `${c.ref} was finalized in SCH`, mrkdwn: true });
  const ts = String(hit?.headers['x-aom-timestamp']);
  const expectedSig = `sha256=${createHmac('sha256', secret).update(`${ts}.${hit?.body}`).digest('hex')}`;
  expect(hit?.headers['x-guildwise-signature']).toBe(expectedSig);
  expect(hit?.headers['x-aom-signature']).toBe(expectedSig);
  // once: the same event never runs the schedule twice
  await new Promise((r) => setTimeout(r, 4000));
  expect(hits.length).toBe(before + 1);
  expect(await runsOf('Tell Slack')).toHaveLength(1);

  await page.reload();
  const row = page.getByTestId('schedule-Tell Slack');
  await row.getByTestId('toggle-history').click();
  const run = row.getByTestId('run-row').first();
  await expect(run).toContainText('Done');
  await expect(run).toContainText('Event');
  await expect(run).toContainText('HTTP 200');
  await page.screenshot({ path: join(paths.vaults, 'schedules-history.png'), fullPage: true });
});

test('the webhook test button, and a failed delivery that is retried with a growing pause', async () => {
  await page.goto('/schedules');
  const row = page.getByTestId('schedule-Tell Slack');
  hookStatuses = [500];
  await row.getByTestId('test-delivery').click();
  await expect(row.getByTestId('test-result')).toContainText('Test failed (HTTP 500)');
  await row.getByTestId('test-delivery').click();
  await expect(row.getByTestId('test-result')).toContainText('Test delivered (HTTP 200)');

  // run now while the endpoint is down: the first try fails, the second (after the pause) works
  hookStatuses = [503, 200];
  const before = hits.length;
  await row.getByRole('button', { name: /Run now/ }).click();
  await waitFor(
    'first try',
    async () => hits.length,
    (n) => n === before + 1,
    15_000,
  );
  const id = await scheduleId('Tell Slack');
  const [pending] = (await runsOf('Tell Slack')).filter((r) => r.status === 'pending');
  expect(pending).toMatchObject({ attempts: 1 });
  await clock(2 * 60_000);
  await waitFor(
    'delivered on the retry',
    async () => (await q<any>('SELECT status, attempts FROM schedule_runs WHERE id=$1', [pending.id]))[0],
    (r) => r?.status === 'ok',
    30_000,
  );
  expect(hits.length).toBe(before + 2);
  await page.reload();
  const again = page.getByTestId('schedule-Tell Slack');
  await again.getByTestId('toggle-history').click();
  await expect(again.getByText('2 tries').first()).toBeVisible();
  await expect(again.getByRole('table', { name: 'Tries' }).first()).toContainText('HTTP 503');
  expect(id).toBeTruthy();
});

test('an e-mail digest at a set time arrives in Mailpit', async () => {
  await page.goto('/schedules');
  await page.getByTestId('new-schedule').click();
  const wiz = page.getByTestId('schedule-wizard');
  await wiz.getByLabel('Runs').selectOption({ label: 'Daily at 18:00' });
  await page.getByTestId('wizard-next').click();
  await wiz.getByTestId('tile-email').click();
  await page.getByTestId('wizard-next').click();
  await wiz.getByLabel('Name', { exact: true }).first().fill('Evening digest');
  await wiz.getByLabel('Digest').selectOption({ label: 'Project summary' });
  await wiz.getByLabel('Project', { exact: true }).selectOption({ label: 'SCH Scheduled work' });
  await wiz.getByLabel('To', { exact: true }).fill(SCHEDULER.email);
  await wiz.getByLabel('Subject').fill('Evening summary of {project}');
  await page.getByTestId('wizard-save').click();
  const row = page.getByTestId('schedule-Evening digest');
  await expect(row).toBeVisible();
  // the clock reaches 18:00 (UTC schedules use the browser's zone; whatever it is, the next fire is within a day)
  const id = await scheduleId('Evening digest');
  const next = (await q<any>('SELECT next_fire_at FROM schedules WHERE id=$1', [id]))[0].next_fire_at;
  const now = new Date(await clock(0)).getTime();
  await clock(new Date(next).getTime() - now + 2000);
  const mail = await waitForMail(SCHEDULER.email, 30_000);
  expect(mail.subject).toBe('Evening summary of SCH');
  expect(mail.text).toContain('# SCH Scheduled work');
  expect(mail.text).toContain('## Open work');
  await waitFor(
    'the delivery is logged',
    () => runsOf('Evening digest'),
    (r) => r.some((x) => x.status === 'ok' && x.delivery?.kind === 'email'),
    30_000,
  );
  await page.reload();
  await page.getByTestId('schedule-Evening digest').getByTestId('toggle-history').click();
  await expect(page.getByTestId('schedule-Evening digest').getByTestId('run-row').first()).toContainText(
    'Done',
  );
});

test('issue polling into intake: new GitHub issues become intakes once', async () => {
  const create = await api.post('/api/schedules', {
    data: {
      name: 'Poll toy issues',
      trigger: { kind: 'manual' },
      action: {
        kind: 'integration',
        integration: 'github',
        operation: 'issues_poll',
        workstationId,
        query: 'acme/toy',
        projectId,
      },
    },
  });
  expect(create.status(), await create.text()).toBe(201);
  await page.goto('/schedules');
  const row = page.getByTestId('schedule-Poll toy issues');
  await row.getByRole('button', { name: /Run now/ }).click();
  await waitFor(
    'the poll completed',
    () => runsOf('Poll toy issues'),
    (r) => r[0]?.status === 'ok',
    60_000,
  );
  const [run] = await runsOf('Poll toy issues');
  expect(run.summary).toContain('acme/toy#41');
  const intake = (
    await q<any>(`SELECT external_system, external_key FROM intakes WHERE external_key='acme/toy#41'`)
  )[0];
  expect(intake).toMatchObject({ external_system: 'github' });
  await row.getByTestId('toggle-history').click();
  await expect(row.getByRole('link', { name: /1 intake/ })).toBeVisible();
  // the second poll sees the same issue and takes nothing
  await row.getByRole('button', { name: /Run now/ }).click();
  await waitFor(
    'the second poll',
    () => runsOf('Poll toy issues'),
    (r) => r.length === 2 && r[1].status === 'ok',
    60_000,
  );
  expect((await runsOf('Poll toy issues'))[1].summary).toBe('No new issues');
  expect(await q(`SELECT 1 FROM intakes WHERE external_key='acme/toy#41'`)).toHaveLength(1);
});

test('a BA task with free-text instructions reports to the desk', async () => {
  const create = await api.post('/api/schedules', {
    data: {
      name: 'Friday review',
      trigger: { kind: 'manual' },
      action: {
        kind: 'ba_task',
        projectId: null,
        prompt: 'List what is open on {date}',
        deliver: 'desk_notice',
      },
    },
  });
  expect(create.status(), await create.text()).toBe(201);
  await page.goto('/schedules');
  await page
    .getByTestId('schedule-Friday review')
    .getByRole('button', { name: /Run now/ })
    .click();
  const id = await scheduleId('Friday review');
  const item = await waitFor(
    'the BA report on the desk',
    async () => (await q<any>(`SELECT title, body FROM desk_items WHERE data->>'scheduleId'=$1`, [id]))[0],
    (x) => !!x,
    90_000,
  );
  expect(item.title).toBe('Friday review: BA report');
  expect(item.body).toContain('List what is open on');
});

test('a guest manages schedules tied to the shared project, and nothing for the whole organization', async () => {
  // the owner's organization-level schedules are not theirs to see
  await guestPage.goto('/schedules');
  await expect(guestPage.getByTestId('schedule-Friday review')).toHaveCount(0);
  await expect(guestPage.getByTestId('schedule-Tell Slack')).toBeVisible();
  // create one tied to the project through the wizard
  await guestPage.getByTestId('new-schedule').click();
  const wiz = guestPage.getByTestId('schedule-wizard');
  await wiz.getByTestId('tile-manual').click();
  await guestPage.getByTestId('wizard-next').click();
  await wiz.getByTestId('tile-ba_task').click();
  await guestPage.getByTestId('wizard-next').click();
  await wiz.getByLabel('Name', { exact: true }).first().fill('Guest notes');
  await wiz.getByLabel('Instructions for the BA').fill('Summarise the open cards');
  await wiz.getByLabel(/^Project/).selectOption({ label: 'SCH Scheduled work' });
  await guestPage.getByTestId('wizard-save').click();
  const mine = guestPage.getByTestId('schedule-Guest notes');
  await expect(mine).toBeVisible();
  await expect(mine.getByRole('button', { name: 'Edit' })).toBeVisible();
  // the same schedule for the whole organization is refused (API, in the owner's organization)
  const orgId = (await q<any>('SELECT org_id FROM projects WHERE id=$1', [projectId]))[0].org_id as string;
  const refused = await guestApi.post('/api/schedules', {
    headers: { 'x-aom-org': orgId },
    data: {
      name: 'Guest org-wide',
      trigger: { kind: 'manual' },
      action: { kind: 'ba_task', projectId: null, prompt: 'x', deliver: 'desk_notice' },
    },
  });
  expect(refused.status()).toBe(403);
  const refusedHook = await guestApi.post('/api/schedules', {
    headers: { 'x-aom-org': orgId },
    data: {
      name: 'Guest hook',
      trigger: { kind: 'manual' },
      action: { kind: 'integration', integration: 'webhook', url: hookUrl },
    },
  });
  expect(refusedHook.status()).toBe(403);
  // the owner sees the guest's schedule and may change it; the guest cannot touch the owner's organization-level one
  await page.goto('/schedules');
  await expect(page.getByTestId('schedule-Guest notes')).toBeVisible();
  const ownerBa = await scheduleId('Friday review');
  const touch = await guestApi.patch(`/api/schedules/${ownerBa}`, { data: { enabled: false } });
  expect([403, 404]).toContain(touch.status());
});

// Delivering the agent's output: a create_card automation sends what the agent produced when its card is done.
let outputSecret = '';
const scheduleDto = async (name: string) =>
  ((await (await api.get('/api/schedules')).json()).schedules as any[]).find((s) => s.name === name);

test('agent output: the wizard adds a webhook and an e-mail, and Send test reaches both, signed', async () => {
  await deleteMailFor(SCHEDULER.email);
  await page.goto('/schedules');
  await page.getByTestId('new-schedule').click();
  const wiz = page.getByTestId('schedule-wizard');
  await wiz.getByTestId('tile-manual').click();
  await page.getByTestId('wizard-next').click();
  await wiz.getByTestId('tile-create_card').click();
  await page.getByTestId('wizard-next').click();
  await wiz.getByLabel('Name', { exact: true }).first().fill('Result to the team');
  await wiz.getByLabel('Project').selectOption({ label: 'SCH Scheduled work' });
  await wiz.getByLabel('Title').fill('Write the weekly note');
  const out = wiz.getByTestId('output-section');
  await expect(out).toContainText('Send the result when the card is done');
  await out.getByRole('button', { name: 'Add a destination' }).click();
  const hook = out.getByTestId('output-0');
  await hook.getByLabel('Send it to').selectOption({ label: 'Webhook' });
  await hook.getByLabel('URL').fill(outUrl);
  await out.getByRole('button', { name: 'Add a destination' }).click();
  const mail = out.getByTestId('output-1');
  await expect(mail.getByLabel('Send it to')).toHaveValue('email');
  await mail.getByLabel('To', { exact: true }).fill(SCHEDULER.email);
  await mail.getByLabel('Subject (optional)').fill('Result {ref}: {title}');
  await page.screenshot({ path: join(paths.vaults, 'schedules-output-section.png'), fullPage: true });
  await page.getByTestId('wizard-save').click();
  // the signing secret of the output webhook is shown once, like that of a webhook action
  outputSecret = (await page.getByTestId('secret-value').textContent())?.trim() ?? '';
  expect(outputSecret).toMatch(/^whsec_/);
  await page.getByRole('button', { name: 'I have saved it' }).click();
  await expect(page.getByTestId('secret-value')).toHaveCount(0);
  // and never sent back: the list carries the destinations without the encrypted secret
  const dto = await scheduleDto('Result to the team');
  expect(dto.action.deliverOutput.destinations).toHaveLength(2);
  expect(dto.action.deliverOutput.secretEnc).toBeUndefined();
  expect(JSON.stringify(dto)).not.toContain(outputSecret);

  const row = page.getByTestId('schedule-Result to the team');
  const before = outHits.length;
  await row.getByTestId('test-delivery').click();
  const result = row.getByTestId('test-result');
  await expect(result).toContainText(`${new URL(outUrl).host}: delivered`);
  await expect(result).toContainText(`${SCHEDULER.email}: delivered`);
  const hit = outHits[before];
  expect(hit).toBeTruthy();
  const body = JSON.parse(hit?.body ?? '{}');
  expect(body).toMatchObject({
    event: 'schedule.test',
    trigger: 'test',
    schedule: { name: 'Result to the team' },
  });
  expect(body.text).toContain('Test delivery from the automation "Result to the team"');
  expect(hit?.headers['x-aom-event']).toBe('schedule.test');
  expect(hit?.headers['x-guildwise-signature']).toBe(signatureOf(outputSecret, hit as never));
  const m = await waitForMail(SCHEDULER.email, 30_000);
  expect(m.subject).toBe('Result TEST-1: Test delivery');
  expect(m.text).toContain('Test delivery from the automation "Result to the team"');
});

test("agent output: when the automation's card is done, the agent's note reaches the webhook and the inbox", async () => {
  await deleteMailFor(SCHEDULER.email);
  // the card needs a spec for Build, and the mock builder's script; an edit keeps the destinations and the secret
  const dto = await scheduleDto('Result to the team');
  const patch = await api.patch(`/api/schedules/${dto.id}`, {
    data: {
      action: {
        ...dto.action,
        template: { ...dto.action.template, fields: { ...SPEC, mock: { build: ['ok'] } } },
      },
    },
  });
  expect(patch.status(), await patch.text()).toBe(200);
  expect((await scheduleDto('Result to the team')).action.deliverOutput.destinations).toHaveLength(2);

  await page.goto('/schedules');
  const row = page.getByTestId('schedule-Result to the team');
  await row.getByRole('button', { name: /Run now/ }).click();
  const c = await waitFor(
    'the card the automation made',
    async () => (await q<any>('SELECT id, ref, title FROM cards WHERE schedule_id=$1', [dto.id]))[0],
    (x) => !!x,
    30_000,
  );
  const before = outHits.length;
  await buildAndFinalize(c);
  await waitFor(
    'the output webhook was called',
    async () => outHits.length,
    (n) => n > before,
    30_000,
  );
  const note = (
    await q<any>(
      `SELECT m.body FROM thread_messages m JOIN threads t ON t.id = m.thread_id
        WHERE t.card_id=$1 AND t.kind='card' AND m.kind='handoff' AND m.author_kind='agent'
        ORDER BY m.created_at DESC LIMIT 1`,
      [c.id],
    )
  )[0]?.body as string;
  expect(note?.trim()).toBeTruthy();
  const hit = outHits[before];
  const body = JSON.parse(hit?.body ?? '{}');
  expect(body).toMatchObject({
    event: 'schedule.output',
    trigger: 'event',
    schedule: { id: dto.id, name: 'Result to the team' },
    text: note.trim(),
    data: {
      card: { ref: c.ref, title: c.title, url: `${BASE_URL}/cards/${c.ref}` },
      output: { source: 'handoff' },
    },
  });
  expect(hit?.headers['x-aom-event']).toBe('schedule.output');
  // signed with the secret shown when the automation was saved, also after the edit
  expect(hit?.headers['x-guildwise-signature']).toBe(signatureOf(outputSecret, hit as never));
  expect(hit?.headers['x-aom-signature']).toBe(signatureOf(outputSecret, hit as never));
  const m = await waitForMailMatching(SCHEDULER.email, new RegExp(`^Result ${c.ref}:`), 30_000);
  expect(m.subject).toBe(`Result ${c.ref}: ${c.title}`);
  expect(m.text).toContain(note.trim().split('\n')[0] as string);
  expect(m.text).toContain(`${BASE_URL}/cards/${c.ref}`);
  // once per card and destination, and not counted as cards the automation made
  await new Promise((r) => setTimeout(r, 3000));
  expect(outHits.length).toBe(before + 1);
  const runs = (await runsOf('Result to the team')).filter((r) => r.result?.outputCardId === c.id);
  expect(runs.map((r) => [r.delivery?.kind, r.status, r.attempts]).sort()).toEqual([
    ['email', 'ok', 1],
    ['webhook', 'ok', 1],
  ]);
  for (const r of runs) expect(r.result?.cardIds).toBeUndefined();

  await page.reload();
  const again = page.getByTestId('schedule-Result to the team');
  await again.getByTestId('toggle-history').click();
  await expect(again.getByText('Webhook: 1 try').first()).toBeVisible();
  await expect(again.getByText('E-mail: 1 try').first()).toBeVisible();
  await expect(
    again.getByRole('link', { name: 'Open the card whose result was sent' }).first(),
  ).toBeVisible();
  await page.screenshot({ path: join(paths.vaults, 'schedules-output-history.png'), fullPage: true });
  // the signing secret is never written to the server log
  expect(readFileSync(paths.serverLog, 'utf8')).not.toContain(outputSecret);
});

test('agent output: a failing webhook is retried with a growing pause, then shown as failed with the reason', async () => {
  const dto = await scheduleDto('Result to the team');
  // webhook only from here on: the inbox needs nothing more
  const patch = await api.patch(`/api/schedules/${dto.id}`, {
    data: {
      action: {
        ...dto.action,
        deliverOutput: { destinations: [dto.action.deliverOutput.destinations[0]] },
      },
    },
  });
  expect(patch.status(), await patch.text()).toBe(200);
  outStatuses = [503, 503, 503, 503, 503];
  const run = await api.post(`/api/schedules/${dto.id}/run`);
  expect(run.ok(), await run.text()).toBeTruthy();
  const c = await waitFor(
    'the second card',
    async () => (await q<any>('SELECT id, ref FROM cards WHERE schedule_id=$1 ORDER BY number', [dto.id]))[1],
    (x) => !!x,
    30_000,
  );
  const before = outHits.length;
  await buildAndFinalize(c);
  const outputRun = async () =>
    (await runsOf('Result to the team')).find((r) => r.result?.outputCardId === c.id);
  await waitFor('the first try', outputRun, (r) => r?.attempts === 1, 30_000);
  const first = await outputRun();
  expect(first).toMatchObject({ status: 'pending', attempts: 1 });
  // 1 min, 5 min, 30 min, 2 h between the five tries
  for (const [attempt, pause] of [
    [2, 60_000],
    [3, 300_000],
    [4, 1_800_000],
    [5, 7_200_000],
  ] as const) {
    await clock(pause + 1000);
    await waitFor(`try ${attempt}`, outputRun, (r) => r?.attempts === attempt, 30_000);
  }
  const last = await waitFor('the delivery failed', outputRun, (r) => r?.status === 'failed', 30_000);
  expect(last.error).toContain('503');
  expect(outHits.length).toBe(before + 5);
  const tries = await q<any>(
    'SELECT attempt, ok, http_status FROM schedule_attempts WHERE run_id=$1 ORDER BY attempt',
    [last.id],
  );
  expect(tries).toEqual([1, 2, 3, 4, 5].map((attempt) => ({ attempt, ok: false, http_status: 503 })));
  // no sixth try
  await clock(8 * 3_600_000);
  await new Promise((r) => setTimeout(r, 3000));
  expect(outHits.length).toBe(before + 5);

  await page.goto('/schedules');
  const row = page.getByTestId('schedule-Result to the team');
  await row.getByTestId('toggle-history').click();
  await expect(row.getByText('Webhook: 5 tries').first()).toBeVisible();
  const failed = row.getByTestId('run-row').filter({ hasText: 'Webhook: 5 tries' }).first();
  await expect(failed).toContainText('Failed');
  await expect(failed).toContainText('503');
  await expect(failed.getByTestId('run-error')).toContainText('503');
  await expect(failed.getByRole('table', { name: 'Tries' })).toContainText('HTTP 503');
});

test("agent output: WhatsApp sends from the owner's workstation; a guest may not change it, its owner may", async () => {
  const instance = '109876543210';
  // The workstation reports a connected WhatsApp number (its token stays on the workstation, never on the server).
  const connect = () =>
    q(
      `INSERT INTO workstation_integrations (workstation_id, kind, instance, status, checked_at)
       VALUES ($1,'whatsapp',$2,$3::jsonb,now())
       ON CONFLICT DO NOTHING`,
      [workstationId, instance, JSON.stringify({ kind: 'whatsapp', instance, state: 'connected' })],
    );
  await q(`DELETE FROM workstation_integrations WHERE workstation_id=$1 AND kind='whatsapp'`, [
    workstationId,
  ]);
  await connect();
  const dest = { kind: 'whatsapp', workstationId, instance, to: ['+27821234567'] };
  const action = (title: string, d: Record<string, unknown>[] = [dest]) => ({
    kind: 'create_card',
    projectId,
    template: { title, fields: {} },
    deliverOutput: { destinations: d },
  });
  const create = await api.post('/api/schedules', {
    data: { name: 'Result to WhatsApp', trigger: { kind: 'manual' }, action: action('Daily plan') },
  });
  expect(create.status(), await create.text()).toBe(201);
  const id = (await create.json()).id as string;

  // Send test: the workstation sends it; this one has no token for the number, so it answers with the reason
  await page.goto('/schedules');
  const row = page.getByTestId('schedule-Result to WhatsApp');
  await row.getByTestId('test-delivery').click();
  // pending while the workstation sends; a quick answer is shown at once
  await expect(row.getByTestId('test-result')).toContainText(
    /\+27821234567: (sent to the workstation; the result appears in the history|failed: WhatsApp is not connected on this workstation)/,
  );
  const run = await waitFor(
    "the workstation's answer",
    async () => (await runsOf('Result to WhatsApp'))[0],
    (r) => r?.status === 'failed',
    30_000,
  );
  expect(run.trigger).toBe('test');
  expect(run.error).toContain('WhatsApp is not connected on this workstation');
  // the run keeps no message text, and the command's payload is emptied once answered
  expect(run.delivery).toMatchObject({ kind: 'runner', channel: 'whatsapp', destination: 0 });
  expect(JSON.stringify(run.delivery)).not.toContain('Test delivery');
  const cmds = await q<any>(
    `SELECT payload FROM runner_commands WHERE type='delivery.send' AND workstation_id=$1`,
    [workstationId],
  );
  expect(cmds.length).toBeGreaterThan(0);
  for (const cmd of cmds) expect(cmd.payload).toEqual({});
  await row.getByTestId('toggle-history').click();
  await expect(row.getByTestId('run-row').first()).toContainText(
    'WhatsApp is not connected on this workstation',
  );

  // a guest of the project may edit the automation, but not where the owner's WhatsApp account sends to
  await connect();
  const changed = { ...dest, to: ['+27829999999'] };
  const byGuest = await guestApi.patch(`/api/schedules/${id}`, {
    data: { action: action('Daily plan', [changed]) },
  });
  expect(byGuest.status(), await byGuest.text()).toBe(403);
  const added = await guestApi.patch(`/api/schedules/${id}`, {
    data: { action: action('Daily plan', [dest, changed]) },
  });
  expect(added.status()).toBe(403);
  const titleOnly = await guestApi.patch(`/api/schedules/${id}`, {
    data: { action: action('Daily plan for the team') },
  });
  expect(titleOnly.status(), await titleOnly.text()).toBe(200);
  // the automation's owner (here also the organization's Owner) may change it
  const byOwner = await api.patch(`/api/schedules/${id}`, {
    data: { action: action('Daily plan for the team', [changed]) },
  });
  expect(byOwner.status(), await byOwner.text()).toBe(200);
  const stored = (await q<any>('SELECT action FROM schedules WHERE id=$1', [id]))[0].action;
  expect(stored.template.title).toBe('Daily plan for the team');
  expect(stored.deliverOutput.destinations[0].to).toEqual(['+27829999999']);
});
