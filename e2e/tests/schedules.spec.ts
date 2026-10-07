import { createHmac } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, paths, SCHEDGUEST, SCHEDULER } from '../support/env.ts';
import { waitForMail } from '../support/mail.ts';
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
});
test.afterAll(async () => {
  hooks?.close();
});

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
      completionAction: 'push_branch',
      fields: { ...SPEC, mock: { build: ['ok'] } },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const c = (await res.json()).card as { id: string; ref: string };
  await waitFor(
    `${c.ref} in review`,
    async () => (await q<any>('SELECT stage FROM cards WHERE id=$1', [c.id]))[0],
    (x) => x?.stage === 'review',
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
  expect(hit?.headers['x-aom-signature']).toBe(
    `sha256=${createHmac('sha256', secret).update(`${ts}.${hit?.body}`).digest('hex')}`,
  );
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
  await wiz.getByLabel('To').fill(SCHEDULER.email);
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
