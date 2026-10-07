import { execFileSync } from 'node:child_process';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, DATABASE_URL, MIGRANT, paths, ROOT, SMTP_URL } from '../support/env.ts';
import { killRunner, pairRunner, startRunner } from '../support/runner.ts';
import { makeVault, originFile, originHas, type VaultFixture } from '../support/vault.ts';

// Restructure Part D: the one-off migration of feed projects to interests (`restructure-2026-10`). The spec starts from the
// database a live installation holds before this version: a feed project with two interests that own feed schedules, an
// unadopted feed schedule, a research-only interest, taste rules, rated digests, transcripts, and a vault folder
// `projects/news/`. The fixture is the one of the server tests (events appended as the old code wrote them); the
// migration then runs through its CLI, exactly as `node dist/restructure-migrate.mjs` does in the image.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('migration');
let page: Page;
let api: APIRequestContext;
let vault: VaultFixture;
let ids: any;
let userId: string;
let orgId: string;

const env = { ...process.env, DATABASE_URL, AOM_PUBLIC_ORIGIN: BASE_URL, AOM_SMTP_URL: SMTP_URL };
const server = (script: string, ...args: string[]): string =>
  execFileSync('pnpm', ['--filter', '@aom/server', script, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
const interestByName = async (name: string) =>
  (await q<any>('SELECT * FROM interests WHERE name=$1', [name]))[0];

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, MIGRANT);
  userId = (await q<{ id: string }>('SELECT id FROM users WHERE email=$1', [MIGRANT.email]))[0]?.id as string;
  orgId = (
    await q<{ org_id: string }>(`SELECT org_id FROM org_members WHERE user_id=$1 AND status='active'`, [
      userId,
    ])
  )[0]?.org_id as string;
  api = await apiAs(MIGRANT.email, MIGRANT.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a runner with the organization vault that still has projects/news/, then the legacy feed project', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Migration Box', HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
  await waitFor(
    'workstation connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0],
    (w) => w?.connected === true,
    30_000,
  );
  vault = makeVault('migration', {
    'projects/news/feed.md':
      '# Feed\n\nRunning list, oldest first. Entries are only ever appended.\n\n- 2026-10-01 [Legacy story number 1](https://news.example.test/legacy-1) (article, News Example, published 2026-10-01): Summary of legacy story 1\n',
    'projects/news/taste.md':
      '# Taste\n\n- Prefer articles like "Legacy story number 1" from News Example (rated useful). Example: https://news.example.test/legacy-1\n',
    'projects/news/transcripts/2026-10-01-legacy-1.md': 'Transcript text 1\n',
  });
  const v = await api.post('/api/vaults', {
    data: { kind: 'org', remoteUrl: vault.origin, syncIntervalSec: 2 },
  });
  expect(v.status(), await v.text()).toBe(201);
  await waitFor(
    'the runner cloned the vault',
    () => q<{ local_path: string | null }>('SELECT local_path FROM workstation_vaults'),
    (r) => !!r[0]?.local_path,
    30_000,
  );
  // the legacy database
  const out = server('legacy-feeds-fixture', '--org', orgId, '--owner', userId);
  ids = JSON.parse(out.trim().split('\n').at(-1) as string);
  await page.goto('/projects');
  await expect(page.getByText('Firearm news').first()).toBeVisible(); // still a visible feed project
  expect((await q(`SELECT 1 FROM schedules WHERE kind='feed'`)).length).toBe(3);
});

test('dry run: the plan is printed and nothing is written', async () => {
  // Only what the migration could write: the server keeps appending signal and connection events in the background
  // (clock-driven detectors, runners coming and going), so the table as a whole is never still.
  // A floor report (or an alert) the BA raises on its own clock is not the migration's doing.
  const MIGRATION_EVENTS = `SELECT count(*)::int AS n FROM events WHERE org_id = $1 AND type = ANY($2::text[])
    AND coalesce(payload->>'subkind', '') NOT IN ('floor_report', 'alert')`;
  const types = [
    'DeskItemCreated',
    'InterestArchived',
    'InterestMigrated',
    'InterestTasteSet',
    'InterestUpdated',
    'ProjectArchived',
    'ProjectCreated',
    'ProjectKindChanged',
    'ProjectUpdated',
    'ScheduleDeleted',
  ];
  const events = (await q<{ n: number }>(MIGRATION_EVENTS, [orgId, types]))[0]?.n;
  const text = server('restructure:migrate', '--dry-run');
  expect(text).toContain('feed project NEWS "Firearm news"');
  expect(text).toContain('interest "Optics" (gets a new backing project)');
  expect(text).toContain('feed schedule "Shotgun news" becomes an interest');
  expect(text).toContain('folder projects/news -> interests/reloading');
  expect(text).toContain('Dry run: nothing was written.');
  expect((await q<{ n: number }>(MIGRATION_EVENTS, [orgId, types]))[0]?.n).toBe(events);
});

test('migrate: the feed project is hidden, four interests exist, the feed schedules are gone and the history is linked', async () => {
  const text = server('restructure:migrate');
  expect(text).toContain(
    '1 feed project(s), 4 interest(s), 3 new backing project(s), 3 feed schedule(s) removed',
  );
  expect((await q(`SELECT 1 FROM schedules WHERE kind='feed'`)).length).toBe(0);
  expect((await q<{ kind: string }>('SELECT kind FROM projects WHERE id=$1', [ids.newsId]))[0]?.kind).toBe(
    'interest',
  );

  await page.goto('/projects');
  await expect(page.getByText('Firearm news')).toHaveCount(0);
  await page.goto('/interests');
  for (const name of ['Reloading', 'Optics', 'Shotguns', 'Powders'])
    await expect(page.getByTestId(`interest-${name}`)).toBeVisible();
  await expect(page.getByTestId('interest-Optics')).toContainText('Paused');
  await expect(page.getByTestId('interest-Shotguns').getByTestId('interest-cadence')).toContainText(
    'Daily at 07:00',
  );
  await page.screenshot({ path: `${paths.vaults}/interests-migrated.png`, fullPage: true });

  // the run log of the first interest holds the migrated runs with the ratings joined in
  const rel = await interestByName('Reloading');
  await page.goto(`/interests/${rel.id}?tab=runs`);
  const log = page.getByTestId('run-log');
  await expect(log).toContainText('migrated');
  await expect(log.getByTestId('run-ratings').first()).toContainText('useful 1 · irrelevant 1');
  await expect(log.getByTestId('run-counts').first()).toContainText('published');
  await page.screenshot({ path: `${paths.vaults}/interests-migrated-runlog.png` });

  // the old addresses lead to the interest
  await page.goto('/p/NEWS/feed');
  await expect(page).toHaveURL(new RegExp(`/interests/${rel.id}\\?tab=digest`));
  await expect(page.getByTestId('digest-items')).toContainText('Legacy story number 1');

  // one note on the desk
  await page.goto('/desk');
  await expect(page.getByRole('article', { name: 'Feed projects became interests' })).toBeVisible();
});

test('the vault: the first interest folder moved with its history, the others got INTEREST.md, taste rules and the imported ratings', async () => {
  // the commands were queued by the CLI (another process): a reconnect hands them to the runner
  killRunner('SIGTERM', HOME);
  await waitFor(
    'workstation offline',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0],
    (w) => w?.connected === false,
    30_000,
  );
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
  await waitFor(
    'the folder moved',
    async () => originHas(vault, 'interests/reloading/feed.md'),
    (b) => b === true,
    60_000,
  );
  expect(originHas(vault, 'projects/news/feed.md')).toBe(false);
  expect(originFile(vault, 'interests/reloading/feed.md')).toContain('Legacy story number 1');
  expect(originFile(vault, 'interests/reloading/transcripts/2026-10-01-legacy-1.md')).toContain(
    'Transcript text 1',
  );
  const reloadingTaste = await waitFor(
    'the seed section in the moved taste.md',
    async () => originFile(vault, 'interests/reloading/taste.md'),
    (t) => t.includes('aom:section seed v=4'),
    60_000,
  );
  expect(reloadingTaste).toContain('Prefer articles like "Legacy story number 1"'); // the old rating line stayed
  expect(reloadingTaste).toContain('- Rule: Skip beginner tutorials');
  expect(reloadingTaste).not.toContain('Skip optics reviews');
  const optics = await waitFor(
    'taste.md of the second interest',
    async () =>
      originHas(vault, 'interests/optics/taste.md') ? originFile(vault, 'interests/optics/taste.md') : '',
    (t) => t.includes('aom:section imported'),
    60_000,
  );
  expect(optics).toContain('Skip optics reviews of one product');
  expect(optics).toContain('(rated irrelevant)');
  expect(originFile(vault, 'interests/optics/INTEREST.md')).toContain('# Optics');
});

test('the migrated interests run: a scan of a new backing project and of the old project both work', async () => {
  for (const name of ['Optics', 'Reloading']) {
    const i = await interestByName(name);
    const res = await api.post(`/api/interests/${i.id}/run`, {
      data: name === 'Reloading' ? {} : { mock: { mockFeed: { items: [] } } },
    });
    // the old manual feed card of the first interest is still queued: that one counts as its run in progress
    if (name === 'Reloading') {
      expect(res.status()).toBe(409);
      continue;
    }
    expect(res.status(), await res.text()).toBe(201);
  }
  const hired = await api.post('/api/agents', {
    data: {
      name: 'Sky',
      roleKey: 'scout',
      seniority: 'junior',
      workstationId: (await (await api.get('/api/workstations')).json()).workstations[0].id,
      runtime: 'mock',
    },
  });
  expect(hired.status(), await hired.text()).toBe(201);
  const curator = await api.post('/api/agents', {
    data: {
      name: 'Cora',
      roleKey: 'curator',
      seniority: 'junior',
      workstationId: (await (await api.get('/api/workstations')).json()).workstations[0].id,
      runtime: 'mock',
    },
  });
  expect(curator.status(), await curator.text()).toBe(201);
  const optics = await interestByName('Optics');
  await waitFor(
    'the Optics run finished',
    () => q<any>(`SELECT status FROM interest_runs WHERE interest_id=$1 AND trigger='manual'`, [optics.id]),
    (r) => r[0]?.status === 'nothing',
    120_000,
  );
});
