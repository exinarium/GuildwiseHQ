import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, FEEDER, paths } from '../support/env.ts';
import { killRunner, pairRunner, startRunner } from '../support/runner.ts';
import { makeVault, originFile, originHas, type VaultFixture } from '../support/vault.ts';

test.describe.configure({ mode: 'serial' });

// M5: scheduler and feeds. Mock scout and curator drive scripted feed runs (no network, no tokens): the scout "opens"
// the scripted pages, the runner records them, the curator picks, the server dedups and enforces the maximum per kind.

const HOME = paths.runnerHome('feeds');
let page: Page;
let api: APIRequestContext;
let workstationId: string;
let projectId: string;
let vault: VaultFixture;

const item = (n: number, over: Record<string, string> = {}) => ({
  kind: 'article',
  url: `https://feeds.example.test/story-${n}`,
  title: TITLES[n - 1] as string,
  source: 'Feed Example',
  publishedAt: '2026-10-02',
  summary: `Summary of story ${n}, written from the page.`,
  ...over,
});
const TITLES = [
  'Hornady unveils a 6mm ARC match load',
  'Berger releases a new hunting bullet line',
  'Ruger announces a lightweight carry pistol',
  'Chronograph shootout compares ten budget models',
  'Lapua opens a second brass factory',
  'Sierra publishes an updated reloading manual',
];
const A1 = item(1);
const A2 = item(2);
const A3 = item(3);
const V1 = item(4, { kind: 'video', url: 'https://video.example.test/chrono' });
const V2 = item(5, { kind: 'video', url: 'https://video.example.test/brass' });
const RULE = 'Prefer posts that include load data';

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, FEEDER);
  api = await apiAs(FEEDER.email, FEEDER.password);
  const ctx = await browser.newContext({ storageState: await api.storageState() });
  page = await ctx.newPage();
});

const clock = async (advanceMs: number): Promise<string> => {
  const r = await fetch(`${BASE_URL}/api/test/clock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: BASE_URL },
    body: JSON.stringify({ advanceMs }),
  });
  expect(r.ok).toBeTruthy();
  return ((await r.json()) as { now: string }).now;
};

const card = (ref: string) => q<any>('SELECT * FROM cards WHERE ref=$1', [ref]);
const done = (ref: string, ms = 90_000) =>
  waitFor(
    `${ref} done`,
    () => card(ref),
    (r) => r[0]?.status === 'done',
    ms,
  );
const lastScheduledCard = async (): Promise<string> =>
  (
    await q<{ ref: string }>(
      `SELECT ref FROM cards WHERE project_id=$1 AND origin='schedule' ORDER BY number DESC LIMIT 1`,
      [projectId],
    )
  )[0]?.ref as string;
/** Progress lines of a shift, once it has ended (the card is done before the shift's last progress is flushed). */
const shiftLog = async (ref: string, stage: string): Promise<string> => {
  const rows = await waitFor(
    `${ref} ${stage} shift ended`,
    () =>
      q<{ status: string; progress_tail: Array<{ text: string }> }>(
        `SELECT s.status, s.progress_tail FROM shifts s JOIN cards c ON c.id = s.card_id WHERE c.ref=$1 AND s.stage=$2`,
        [ref, stage],
      ),
    (r) => r.length > 0 && r.every((x) => x.status === 'ended'),
    30_000,
  );
  return rows.flatMap((r) => r.progress_tail.map((t) => t.text)).join('\n');
};
const digestEvents = () =>
  q<{ payload: any }>(`SELECT payload FROM events WHERE type='DigestPosted' ORDER BY seq`);
const list = async () => (await (await api.get(`/api/projects/${projectId}/feed`)).json()).items as any[];
const itemId = async (url: string) =>
  (await q<{ id: string }>('SELECT id FROM digest_items WHERE url=$1', [url]))[0]?.id as string;
const originHasFile = (path: string) => originHas(vault, path);
const lines = (path: string) =>
  originFile(vault, path)
    .split('\n')
    .filter((l) => l.startsWith('- '));

async function createFeedCard(title: string, fields: Record<string, unknown>): Promise<string> {
  const res = await api.post('/api/cards', {
    data: { projectId, title, cardType: 'feed', fields, specify: true },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).card.ref as string;
}

test('setup: a paired workstation with a personal vault, a feed project, a scout and a curator', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Feed Box', HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
  await waitFor(
    'workstation connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0],
    (w) => w?.connected === true,
    30_000,
  );
  workstationId = (await (await api.get('/api/workstations')).json()).workstations[0].id;

  vault = makeVault('feeds', { 'projects/news/PROJECT.md': '# News\n\nFirearm news.\n' });
  const v = await api.post('/api/vaults', {
    data: { kind: 'personal', remoteUrl: vault.origin, syncIntervalSec: 2 },
  });
  expect(v.status(), await v.text()).toBe(201);
  await waitFor(
    'the runner cloned the vault',
    () => q<{ local_path: string | null }>('SELECT local_path FROM workstation_vaults'),
    (r) => !!r[0]?.local_path,
    30_000,
  );

  const proj = await api.post('/api/projects', {
    data: { key: 'NEWS', name: 'Firearm news', workflowKey: 'feed', domain: 'personal' },
  });
  expect(proj.status(), await proj.text()).toBe(201);
  projectId = (await proj.json()).project.id;
  for (const [name, roleKey] of [
    ['Sky', 'scout'],
    ['Cora', 'curator'],
  ] as const) {
    const hire = await api.post('/api/agents', {
      data: { name, roleKey, seniority: 'junior', workstationId, runtime: 'mock' },
    });
    expect(hire.status(), await hire.text()).toBe(201);
  }
});

test('AC1: a due schedule fires on time and its card is claimed ahead of normal work', async () => {
  // Nobody is online: normal work queues first, then the schedule comes due.
  killRunner('SIGTERM', HOME);
  await waitFor(
    'workstation offline',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0],
    (w) => w?.connected === false,
    30_000,
  );
  const normal = await createFeedCard('Manual feed run', {
    topic: 'chronographs',
    mockFeed: { items: [V2] },
  });

  const sched = await api.post('/api/schedules', {
    data: {
      projectId,
      name: 'Daily firearm news',
      cron: '*/5 * * * *',
      timezone: 'UTC',
      cardTemplate: {
        title: 'Firearm news',
        fields: {
          topic: 'reloading',
          preferredSites: ['https://feeds.example.test'],
          description: 'Only posts with measured data, no press releases.',
          maxItems: 3,
          mockFeed: { items: [A1, A2, V1, A3, V2], proposeRule: RULE },
        },
      },
    },
  });
  expect(sched.status(), await sched.text()).toBe(201);
  const s = await sched.json();
  expect(
    await q('SELECT 1 FROM cards WHERE project_id=$1 AND origin=$2', [projectId, 'schedule']),
  ).toHaveLength(0);

  // The clock reaches the schedule's next fire: it fires at once, without anyone to run it.
  const now = new Date(await clock(0)).getTime();
  const wait = new Date(s.nextFireAt).getTime() - now + 2000;
  expect(wait).toBeGreaterThan(0);
  expect(wait).toBeLessThanOrEqual(5 * 60_000 + 2000);
  await clock(wait);
  const fired = await waitFor(
    'the schedule fired',
    () => q<any>(`SELECT * FROM cards WHERE project_id=$1 AND origin='schedule'`, [projectId]),
    (r) => r.length === 1,
    15_000,
  );
  expect(fired[0]).toMatchObject({
    scheduled: true,
    schedule_id: s.id,
    stage: 'scan',
    status: 'queued',
    card_type: 'feed',
  });
  expect(fired[0].title).toMatch(/^Firearm news \(\d{4}-\d{2}-\d{2}\)$/);
  const types = await q<{ type: string }>(
    `SELECT type FROM events WHERE payload->>'cardId'=$1 ORDER BY seq`,
    [fired[0].id],
  );
  expect(types.map((t) => t.type)).toEqual(expect.arrayContaining(['CardCreated', 'ScheduleFired']));

  // A scout comes back online: it takes the scheduled card before the older manual one.
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
  const first = await waitFor(
    'first claim',
    () =>
      q<{ ref: string }>(
        `SELECT c.ref FROM events e JOIN cards c ON c.id::text = e.payload->>'cardId'
          WHERE e.type='CardClaimed' AND c.project_id=$1 ORDER BY e.seq LIMIT 1`,
        [projectId],
      ),
    (r) => r.length === 1,
    60_000,
  );
  expect(first[0]?.ref).toBe(fired[0].ref);
  await done(fired[0].ref);
  await done(normal);
});

test('AC2: the feed run appends only the best N items overall (any kind), oldest to newest, and puts the digest on the desk', async () => {
  const posted = (await digestEvents()).map((e) => e.payload);
  const scheduled = posted.find((p) => p.items.some((i: any) => i.url === A1.url));
  // candidates: 3 articles + 2 videos in the scout's order; maximum 3 items overall, whatever the kind
  expect(scheduled.items.map((i: any) => i.url)).toEqual([A1.url, A2.url, V1.url]);
  expect(scheduled.nothingQualified).toBe(false);
  const normal = posted.find((p) => p.items.some((i: any) => i.url === V2.url));
  expect(normal.items).toHaveLength(1);

  // the running list: oldest first, only logged items
  expect((await list()).map((i) => i.url)).toEqual([A1.url, A2.url, V1.url, V2.url]);

  // runner wrote the list into the vault (append-only file)
  await waitFor(
    'feed.md in the vault',
    async () => originHasFile('projects/news/feed.md') && lines('projects/news/feed.md').length,
    (n) => n === 4,
    30_000,
  );
  expect(lines('projects/news/feed.md').map((l) => /story-(\d)|chrono|brass/.exec(l)?.[0])).toEqual([
    'story-1',
    'story-2',
    'chrono',
    'brass',
  ]);

  await page.goto('/desk');
  const rating = page.getByRole('article', { name: 'Rate the Firearm news digest (3 items)' });
  await expect(rating).toBeVisible();
  await expect(rating.getByTestId('digest-items').getByRole('listitem')).toHaveCount(3);
  await expect(rating).toContainText(A1.title);
  // a video carries its transcript (the mock scout fetched a fake one)
  const video = rating.getByTestId('digest-items').getByRole('listitem').filter({ hasText: V1.title });
  await video.getByRole('button', { name: 'Transcript' }).click();
  await expect(video.getByTestId('transcript-text')).toContainText('mock talk');
  await expect(rating).toContainText('Summary of story 1');
  await page.screenshot({ path: `${paths.vaults}/feeds-desk.png` });
});

test('AC3: a verdict is written to taste.md as an explicit rule and example; a curator rule proposal waits for approval', async () => {
  await page.goto('/desk');
  const rating = page.getByRole('article', { name: 'Rate the Firearm news digest (3 items)' });
  const row = async (url: string) => rating.getByTestId(`digest-item-${await itemId(url)}`);

  const r1 = await row(A1.url);
  await r1.getByPlaceholder('Why? (optional)').fill('Has load data');
  await r1.getByRole('button', { name: 'Useful' }).click();
  await expect(r1.getByTestId('verdict')).toContainText('Useful');
  const r2 = await row(A2.url);
  await r2.getByPlaceholder('Why? (optional)').fill('Not about reloading');
  await r2.getByRole('button', { name: 'Irrelevant' }).click();
  await expect(r2.getByTestId('verdict')).toContainText('Not about reloading');
  const r3 = await row(V1.url);
  await r3.getByRole('button', { name: 'Boring' }).click();

  // all rated: the desk item closes by itself
  await expect(rating).toHaveCount(0);
  const closed = await q<{ status: string }>(
    `SELECT status FROM desk_items WHERE subkind='digest' ORDER BY created_at LIMIT 1`,
  );
  expect(closed[0]?.status).toBe('answered');

  await waitFor(
    'taste.md in the vault',
    async () => originHasFile('projects/news/taste.md') && lines('projects/news/taste.md').length,
    (n) => n === 3,
    30_000,
  );
  const taste = lines('projects/news/taste.md');
  expect(taste).toContain(
    `- Prefer articles like "${A1.title}" from Feed Example (rated useful). Reason: Has load data. Example: ${A1.url}`,
  );
  expect(taste).toContain(
    `- Skip articles like "${A2.title}" from Feed Example (rated irrelevant). Reason: Not about reloading. Example: ${A2.url}`,
  );
  expect(taste.some((l) => l.startsWith('- Deprioritise videos like') && l.includes('(rated boring)'))).toBe(
    true,
  );
  expect(originFile(vault, 'projects/news/taste.md').startsWith('# Taste')).toBe(true);

  // the curator proposed a rule from the pattern: an approval item the manager can reword
  const proposal = page.getByRole('article', { name: 'Add a taste rule for Firearm news?' });
  await expect(proposal).toBeVisible();
  await expect(proposal.getByLabel('Rule (editable)')).toHaveValue(RULE);
  await proposal.getByLabel('Rule (editable)').fill('Prefer posts that include chronograph data');
  await proposal.getByRole('button', { name: 'Approve' }).click();
  await expect(proposal).toHaveCount(0);
  await waitFor(
    'rule in taste.md',
    async () => lines('projects/news/taste.md').length,
    (n) => n === 4,
    30_000,
  );
  expect(lines('projects/news/taste.md').at(-1)).toBe('- Rule: Prefer posts that include chronograph data');

  // the taste.md preview on the feed page matches
  await page.goto('/p/NEWS/feed');
  const preview = page.getByTestId('taste-preview');
  await expect(preview).toContainText('Skip articles like');
  await expect(preview).toContainText('Rule: Prefer posts that include chronograph data');
  await page.screenshot({ path: `${paths.vaults}/feeds-taste.png` });
});

test('AC4: run now from the board; the curator reads taste.md, duplicates are skipped and the old list stays untouched', async () => {
  const before = originFile(vault, 'projects/news/feed.md');
  await page.goto('/p/NEWS/board');
  await page.getByRole('button', { name: 'Run now' }).click();
  await waitFor(
    'the run-now card',
    async () => (await lastScheduledCard()) && (await card(await lastScheduledCard())),
    (r) => !!r[0] && r[0].title.includes('run now'),
    15_000,
  );
  const ref = await lastScheduledCard();
  expect((await card(ref))[0]).toMatchObject({ scheduled: true, origin: 'schedule' });
  await done(ref);

  // same scripted pages: A1 and V1 are on the seen-list and A2 is skipped by taste.md, so only A3 is new
  const p = (await digestEvents()).map((e) => e.payload).at(-1);
  expect(p.items.map((i: any) => i.url)).toEqual([A3.url]);
  expect(p.duplicatesDropped).toBe(2);
  expect((await list()).map((i) => i.url)).toEqual([A1.url, A2.url, V1.url, V2.url, A3.url]);

  // curators read taste.md at shift start
  const texts = await shiftLog(ref, 'curate');
  expect(texts).toContain('mock taste: 4 rule line(s)');
  expect(texts).toContain(`mock taste rule: - Skip articles like "${A2.title}"`);

  // the vault list only grew at the end
  await waitFor(
    'feed.md appended',
    async () => lines('projects/news/feed.md').length,
    (n) => n === 5,
    30_000,
  );
  expect(originFile(vault, 'projects/news/feed.md').startsWith(before)).toBe(true);
  expect(lines('projects/news/feed.md').at(-1)).toContain(A3.url);
});

test('AC5: nothing qualified logs nothing and says so on the card', async () => {
  // a schedule whose scout finds nothing; paused so it never fires by itself, run from the Schedules page
  const sched = await api.post('/api/schedules', {
    data: {
      projectId,
      name: 'Quiet day',
      enabled: false,
      cron: '0 7 * * *',
      timezone: 'UTC',
      cardTemplate: { title: 'Quiet', fields: { topic: 'nothing', mockFeed: { items: [] } } },
    },
  });
  expect(sched.status(), await sched.text()).toBe(201);
  const itemsBefore = (await list()).length;
  const ratingsBefore = (
    await q<{ n: number }>(`SELECT count(*)::int AS n FROM desk_items WHERE kind='rating'`)
  )[0]?.n;

  await page.goto('/schedules');
  const row = page.getByTestId('schedule-Quiet day');
  await expect(row).toContainText('Paused');
  await expect(row.getByTestId('schedule-next')).toContainText('not scheduled');
  await row.getByRole('button', { name: 'Run now' }).click();
  await expect(row.getByTestId('run-result')).toContainText('Emitted');
  const ref = await lastScheduledCard();
  await done(ref);

  expect((await list()).length).toBe(itemsBefore);
  expect(
    (await q<{ n: number }>(`SELECT count(*)::int AS n FROM desk_items WHERE kind='rating'`))[0]?.n,
  ).toBe(ratingsBefore);
  const p = (await digestEvents()).map((e) => e.payload).at(-1);
  expect(p).toMatchObject({ nothingQualified: true, items: [] });
  await page.goto(`/cards/${ref}`);
  await expect(page.getByText('Nothing qualified in this run; nothing was logged.').first()).toBeVisible();
  await page.screenshot({ path: `${paths.vaults}/feeds-nothing.png` });
});

test('AC6: the Schedules wizard creates a schedule from a preset with a time zone and shows when it runs next', async () => {
  await page.goto('/schedules');
  await page.getByTestId('new-schedule').click();
  const wiz = page.getByTestId('schedule-wizard');
  await wiz.getByLabel('Runs').selectOption({ label: 'Daily at 07:00' });
  await wiz.getByLabel('Time zone').fill('Africa/Johannesburg');
  await page.getByTestId('wizard-next').click();
  await wiz.getByTestId('tile-create_card').click();
  await page.getByTestId('wizard-next').click();
  await wiz.getByLabel('Name', { exact: true }).first().fill('UI created');
  await wiz.getByLabel('Project').selectOption({ label: 'NEWS Firearm news' });
  const template = wiz.getByTestId('card-template');
  await template.getByLabel('Title').fill('UI created');
  await template.getByLabel('Topic').fill('hunting optics');
  await template.getByLabel('Description').fill('Only long-range optics with owner reviews.');
  await template.getByLabel(/Max items/).fill('7');
  await page.getByTestId('wizard-save').click();
  const row = page.getByTestId('schedule-UI created');
  await expect(row.getByTestId('schedule-when')).toContainText('Daily at 07:00 (Africa/Johannesburg)');
  const created = await q<any>(`SELECT * FROM schedules WHERE name='UI created'`);
  expect(created[0]).toMatchObject({ cron: '0 7 * * *', timezone: 'Africa/Johannesburg', enabled: true });
  expect(created[0].card_template.fields).toMatchObject({
    description: 'Only long-range optics with owner reviews.',
    maxItems: 7,
  });
  // 07:00 in Johannesburg (UTC+2)
  expect(new Date(created[0].next_fire_at).getUTCHours()).toBe(5);
  await page.screenshot({ path: `${paths.vaults}/feeds-schedules.png` });
  // a bad cron is caught in the wizard before anything is sent
  await page.getByTestId('new-schedule').click();
  const again = page.getByTestId('schedule-wizard');
  await again.getByLabel('Runs').selectOption({ label: 'Custom cron expression' });
  await again.getByLabel('Cron expression').fill('every day');
  await page.getByTestId('wizard-next').click();
  await expect(again.getByText(/Five fields/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  // tidy up: delete
  await row.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete schedule' }).click();
  await expect(row).toHaveCount(0);
});

test('no fabrication: the runner rejects an item the scout never opened; the scout retries without it', async () => {
  const ref = await createFeedCard('Fabricating scout', {
    topic: 'fabrication',
    mock: { scan: ['fabricate'] },
    mockFeed: { items: [A1] },
  });
  await done(ref);
  const h = await q<{ data: any }>(
    `SELECT h.data FROM card_handoffs h JOIN cards c ON c.id=h.card_id WHERE c.ref=$1 AND h.stage='scan'`,
    [ref],
  );
  expect(h).toHaveLength(1);
  expect(h[0]?.data.items.map((i: any) => i.url)).toEqual([A1.url]);
  expect(await shiftLog(ref, 'scan')).toMatch(/first report rejected.*not pages you opened/s);
  // A1 was already logged: the digest of this card has nothing new
  const p = (await digestEvents()).map((e) => e.payload).at(-1);
  expect(p).toMatchObject({ nothingQualified: true });
});
