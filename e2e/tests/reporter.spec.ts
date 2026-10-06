import { join } from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { pool, q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, paths, REPORTER } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';

// The BA as the manager's reporter (docs/design/phases.md Part B): one user, one runner (mock runtime), project RPT on
// the toy repo, a mock BA (Ben) and a builder. Routing through the BA is on, as for every new organization.
// The mock BA annotates urgent items, analyses the looping card and writes the daily floor report; the server's
// reporter sweep runs every 3 seconds here. No Claude, GitHub or Docker is contacted.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('reporter');
const ZONE = 'Africa/Johannesburg';
let page: Page;
let api: APIRequestContext;
let workstationId: string;
let projectId: string;
let repoId: string;

const SPEC = {
  context: 'The toy project needs a feature.',
  requirements: 'Add the thing.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};

async function createCard(title: string, mock: Record<string, string[]>) {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'feature',
      repoId,
      completionAction: 'merge',
      fields: { ...SPEC, mock },
      specify: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).card as { id: string; ref: string };
}
/** The reporter's organization. Other specs leave their own organizations in the database, and when the clock jumps to the next day each of them gets its own floor report (a fallback one when it has no BA), so queries about reports are scoped to this one. */
const ORG = `(SELECT o.id FROM organizations o JOIN users u ON u.id = o.owner_user_id WHERE lower(u.email)=lower($1))`;
const user = async () =>
  (
    await q<{ timezone: string | null; reporting: Record<string, unknown> }>(
      `SELECT timezone, reporting FROM users WHERE lower(email)=lower($1)`,
      [REPORTER.email],
    )
  )[0];

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, REPORTER);
  api = await apiAs(REPORTER.email, REPORTER.password);
  // the manager's browser is in Johannesburg: the app takes that as their time zone at first login
  page = await (
    await browser.newContext({ storageState: await api.storageState(), timezoneId: ZONE })
  ).newPage();
});
test.afterAll(async () => {
  await pool.end();
});

test('setup: a paired mock runner, project RPT on the toy repo, a BA and a builder', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Reporter Box', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200', AOM_MOCK_CHAT_TOKEN_MS: '20' }, HOME);
  const ws = await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );
  workstationId = ws[0].id;
  const proj = await api.post('/api/projects', { data: { key: 'RPT', name: 'Reporter project' } });
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
  for (const [name, roleKey, seniority] of [
    ['Ben', 'ba', 'senior'],
    ['Bo', 'builder', 'junior'],
  ] as const) {
    const hire = await api.post('/api/agents', {
      data: { name, roleKey, seniority, workstationId, projectId, runtime: 'mock' },
    });
    expect(hire.status(), await hire.text()).toBe(201);
  }
  await waitFor(
    'DevOps engineer uses the mock runtime',
    async () => (await (await api.get('/api/agents')).json()).agents as any[],
    (a) => a.some((x) => x.isDevops && x.runtime === 'mock'),
    30_000,
  );
});

test('AC1: the time zone comes from the browser at first login; routing is on by default; both are editable', async () => {
  await page.goto('/');
  await waitFor('the browser time zone is stored', user, (u) => u?.timezone === ZONE, 30_000);
  await page.goto('/settings');
  await expect(page.getByTestId('timezone')).toHaveValue(ZONE);
  await expect(page.getByTestId('route-via-ba')).toBeChecked();
  await expect(page.getByTestId('daily-at')).toHaveValue('08:00');
  expect((await user())?.reporting).toEqual({});

  await page.getByTestId('timezone').selectOption('Europe/Amsterdam');
  await waitFor('time zone edited', user, (u) => u?.timezone === 'Europe/Amsterdam', 15_000);
  await page.getByTestId('timezone').selectOption(ZONE);
  await waitFor('time zone restored', user, (u) => u?.timezone === ZONE, 15_000);

  await page.getByTestId('route-via-ba').uncheck();
  await waitFor('routing off', user, (u) => u?.reporting?.routeViaBa === false, 15_000);
  await page.getByTestId('route-via-ba').check();
  await waitFor('routing on', user, (u) => u?.reporting?.routeViaBa === true, 15_000);
  await page.screenshot({ path: join(paths.vaults, 'reporter-settings.png'), fullPage: true });
});

test('AC2: an approval reaches the desk at once, and a plain approval gets no BA note', async () => {
  await createCard('Needs docker', { build: ['devops_install'] });
  const item = await waitFor(
    'the DevOps approval is on the desk',
    () =>
      // This user's own approval: the devops spec leaves an answered "install docker" approval of its own in the database.
      q<{ id: string; triage: string; status: string; pinned: boolean }>(
        `SELECT d.id, d.triage, d.status, d.pinned FROM desk_items d JOIN organizations o ON o.id = d.org_id JOIN users u ON u.id = o.owner_user_id
          WHERE d.subkind='devops' AND lower(u.email)=lower($1)`,
        [REPORTER.email],
      ),
    (r) => r.length === 1,
    60_000,
  );
  // urgent: never held for the BA
  expect(item[0]).toMatchObject({ triage: 'none', status: 'open', pinned: true });
  await page.goto('/desk');
  const art = page.getByRole('article', { name: 'DevOps needs approval: install docker' });
  await expect(art).toBeVisible();
  // The BA only adds a note where it adds value (loops, repeated approvals, escalations): a plain approval gets none,
  // so no urgent_note task is queued for it (owner decision, 2026-10-06).
  await page.waitForTimeout(4_000);
  await expect(art.getByTestId('ba-note')).toHaveCount(0);
  expect(
    (await q(`SELECT 1 FROM ba_tasks WHERE kind='urgent_note' AND org_id=${ORG}`, [REPORTER.email])).length,
  ).toBe(0);
  await page.screenshot({ path: join(paths.vaults, 'reporter-urgent-note.png'), fullPage: true });
});

test('AC3: a card whose shifts keep failing: the loop breaker holds it back and the BA analyses the loop on its alert', async () => {
  const looping = await createCard('Burns tokens', {
    build: ['no_report', 'no_report', 'no_report', 'no_report', 'no_report'],
  });
  const alert = await waitFor(
    'the loop breaker alert',
    () =>
      q<{ id: string; title: string }>(
        `SELECT id, title FROM desk_items WHERE subkind='loop_backoff' AND org_id=${ORG}`,
        [REPORTER.email],
      ),
    (r) => r.length === 1,
    120_000,
  );
  expect(alert[0]?.title).toContain(looping.ref);
  // urgent: a shift loop burns tokens, so its alert is never held for the BA
  expect(
    (await q<{ triage: string }>(`SELECT triage FROM desk_items WHERE id=$1`, [alert[0]?.id]))[0]?.triage,
  ).toBe('none');
  const sig = await waitFor(
    'an urgent loop signal',
    () =>
      q<{ kind: string; urgency: string; status: string }>(
        `SELECT kind, urgency, status FROM ba_signals WHERE kind='loop' AND org_id=${ORG}`,
        [REPORTER.email],
      ),
    (r) => r.length === 1 && r[0]?.status === 'reported',
    60_000,
  );
  expect(sig[0]).toMatchObject({ urgency: 'urgent', status: 'reported' });
  await page.goto('/desk');
  const art = page.getByRole('article', { name: new RegExp(`${looping.ref} keeps failing`) });
  await expect(art).toBeVisible();
  await expect(art.getByTestId('ba-note')).toContainText('mock analysis of loop');
  await expect(art.getByTestId('triage-passed')).toHaveCount(0);
  await page.screenshot({ path: join(paths.vaults, 'reporter-loop.png'), fullPage: true });
  // the alert is the only item: the BA's analysis is a note on it, not a second one
  expect(
    (await q(`SELECT 1 FROM desk_items WHERE subkind='ba_report' AND org_id=${ORG}`, [REPORTER.email]))
      .length,
  ).toBe(0);
  // stop the loop for the rest of the spec
  const stop = await api.post(`/api/cards/${looping.id}/cancel`, { data: { reason: 'e2e: stop the loop' } });
  expect(stop.ok(), await stop.text()).toBeTruthy();
});

test('AC4: the daily floor report is a desk item at 08:00 on the manager clock, with a link to the standing BA chat', async () => {
  // Nothing is due yet: the organization was created after today\'s 08:00 or the day is not over.
  expect(
    (await q(`SELECT 1 FROM ba_tasks WHERE kind='floor_report' AND org_id=${ORG}`, [REPORTER.email])).length,
  ).toBe(0);
  // Tomorrow at 09:00 in Johannesburg (UTC+2, no daylight saving): 07:00 UTC of the next local date. The DevOps approval
  // is still open, so there is news.
  const clock = (advanceMs: number) =>
    fetch(`${BASE_URL}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ advanceMs }),
    });
  const now = new Date(((await (await clock(0)).json()) as { now: string }).now);
  const local = new Date(now.getTime() + 2 * 3_600_000); // Johannesburg wall clock, read in UTC fields
  const target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 7, 0, 0);
  const adv = await clock(target - now.getTime());
  expect(adv.ok).toBe(true);
  await page.reload();
  const tasks = await waitFor(
    'the floor report task',
    () =>
      q<{ status: string; local_date: string }>(
        `SELECT status, local_date FROM ba_tasks WHERE kind='floor_report' AND org_id=${ORG}`,
        [REPORTER.email],
      ),
    (r) => r.length >= 1 && r.every((t) => t.status === 'done'),
    120_000,
  );
  expect(tasks).toHaveLength(1);
  const items = await q<{ id: string; title: string; chat_thread_id: string | null; asked_by_role: string }>(
    `SELECT id, title, chat_thread_id, asked_by_role FROM desk_items WHERE subkind='floor_report' AND org_id=${ORG}`,
    [REPORTER.email],
  );
  expect(items).toHaveLength(1);
  expect(items[0]?.title).toBe(`Floor report ${tasks[0]?.local_date}`);
  expect(items[0]?.asked_by_role).toBe('ba');

  await page.goto('/desk');
  const art = page.getByRole('article', { name: /^Floor report / });
  await expect(art).toBeVisible();
  await expect(art.getByTestId('desk-kind')).toHaveText('Floor report');
  await expect(art).toContainText('(mock BA)');
  await art.getByTestId('floor-facts').locator('summary').click();
  const facts = art.getByTestId('floor-report');
  for (const h of [
    'Phases waiting or open',
    'Stuck, blocked and backing-off cards',
    'Repeated approvals',
    'Failures',
    'DevOps requests that are open',
    'Resolved by the BA without bothering you',
  ])
    await expect(facts.getByRole('heading', { name: new RegExp(h) })).toBeVisible();
  await expect(facts).toContainText('install docker');
  await page.screenshot({ path: join(paths.vaults, 'reporter-floor-report.png'), fullPage: true });

  // one standing chat thread per org and manager, created with the first report
  expect(items[0]?.chat_thread_id).toBeTruthy();
  await art.getByTestId('ba-chat-link').click();
  await expect(page).toHaveURL(new RegExp(`/chat/${items[0]?.chat_thread_id}`));
  await expect(page.getByRole('heading', { name: 'Chat with Ben' })).toBeVisible();
  expect(
    (await q(`SELECT 1 FROM threads WHERE title='BA reports' AND org_id=${ORG}`, [REPORTER.email])).length,
  ).toBe(1);

  // only one report per local day, however many sweeps ran
  await new Promise((r) => setTimeout(r, 8_000));
  expect(
    (await q(`SELECT 1 FROM desk_items WHERE subkind='floor_report' AND org_id=${ORG}`, [REPORTER.email]))
      .length,
  ).toBe(1);

  await page.goto('/desk');
  await page
    .getByRole('article', { name: /^Floor report / })
    .getByRole('button', { name: 'Acknowledge' })
    .click();
  await expect(page.getByRole('article', { name: /^Floor report / })).toHaveCount(0);
});
