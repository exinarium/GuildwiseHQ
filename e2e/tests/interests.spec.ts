import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, INTERESTER, paths } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';
import { makeVault, originFile, originHas, type VaultFixture } from '../support/vault.ts';

// Org-level interests (docs/design/restructure.md Part D): create one, taste rules, runs through the mock scout and curator
// (no network, no tokens), the run log, rating, "Research this", the soft agent preference, the run and delivery
// schedules against the test clock, the quiet cap, archive and delete, and the phone layout. The feed acceptance cases
// (best N across kinds, oldest to newest, taste.md from verdicts, curator rule proposal, dedup, nothing qualified, no
// fabrication) live here too, because a feed is an interest now.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('interests');
let page: Page;
let api: APIRequestContext;
let workstationId: string;
let vault: VaultFixture;
let interestId: string;
let projectId: string;

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
const FOLDER = 'interests/firearm-news';

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, INTERESTER);
  api = await apiAs(INTERESTER.email, INTERESTER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
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
const interestByName = async (name: string) =>
  (await q<any>('SELECT * FROM interests WHERE name=$1', [name]))[0];
const card = (ref: string) => q<any>('SELECT * FROM cards WHERE ref=$1', [ref]);
const done = (ref: string, ms = 120_000) =>
  waitFor(
    `${ref} done`,
    () => card(ref),
    (r) => r[0]?.status === 'done',
    ms,
  );
/** "Run scan" through the API (the mock fields are accepted because the stack runs with AOM_MOCK_UI). */
async function run(id: string, body: Record<string, unknown> = {}): Promise<{ ref: string; runId: string }> {
  const res = await api.post(`/api/interests/${id}/run`, { data: body });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as { ref: string; runId: string };
}
const mockRun = (id: string, mockFeed: unknown, extra: Record<string, unknown> = {}) =>
  run(id, { mock: { mockFeed, ...extra } });
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
const list = async (id = interestId) =>
  (await (await api.get(`/api/interests/${id}/digest`)).json()).items as any[];
const itemId = async (url: string) =>
  (await q<{ id: string }>('SELECT id FROM digest_items WHERE url=$1', [url]))[0]?.id as string;
const vaultLines = (path: string) =>
  originHas(vault, path)
    ? originFile(vault, path)
        .split('\n')
        .filter((l) => l.startsWith('- '))
    : [];
const sections = (text: string) => (text.match(/aom:section seed v=/g) ?? []).length;
const taste = () => (originHas(vault, `${FOLDER}/taste.md`) ? originFile(vault, `${FOLDER}/taste.md`) : '');

test('setup: a paired workstation with the organization vault, and a scout, curator, researcher and checker', async () => {
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'Interest Box', HOME);
  startRunner({ AOM_MOCK_STEP_MS: '200' }, HOME);
  await waitFor(
    'workstation connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations[0],
    (w) => w?.connected === true,
    30_000,
  );
  workstationId = (await (await api.get('/api/workstations')).json()).workstations[0].id;
  vault = makeVault('interests', { 'README.md': '# Notes\n' });
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
  for (const [name, roleKey] of [
    ['Sky', 'scout'],
    ['Cora', 'curator'],
    ['Rhea', 'researcher'],
    ['Chuck', 'checker'],
  ] as const) {
    const hire = await api.post('/api/agents', {
      data: { name, roleKey, seniority: 'junior', workstationId, runtime: 'mock' },
    });
    expect(hire.status(), await hire.text()).toBe(201);
  }
});

test('create: the dialog makes an interest; its hidden project and vault folder interests/<slug>/ exist, and no project is listed', async () => {
  await page.goto('/interests');
  await expect(page.getByTestId('interests-empty')).toBeVisible();
  await page.getByTestId('interest-new').click();
  const dialog = page.getByTestId('interest-new-dialog');
  await dialog.getByTestId('interest-name').fill('Firearm news');
  await dialog.getByTestId('interest-description').fill('Only posts with measured data, no press releases.');
  await dialog.getByTestId('interest-manual').check();
  await dialog.getByTestId('interest-delivery-mode').selectOption('immediate');
  await dialog.getByTestId('interest-max-items').fill('3');
  await dialog.getByTestId('taste-rule-input').fill('Skip beginner tutorials');
  await dialog.getByTestId('taste-rule-add').click();
  await page.screenshot({ path: `${paths.vaults}/interests-new.png` });
  await page.getByTestId('interest-save').click();
  await expect(page.getByTestId('interest-detail')).toBeVisible();
  await expect(page).toHaveURL(/\/interests\/[0-9a-f-]{36}$/);

  const i = await interestByName('Firearm news');
  interestId = i.id;
  projectId = i.project_id;
  expect(i).toMatchObject({ slug: 'firearm-news', status: 'active' });
  expect(i.scan).toMatchObject({ manual: true, maxItems: 3 });
  expect((await q<any>('SELECT kind, vault_dir FROM projects WHERE id=$1', [projectId]))[0]).toMatchObject({
    kind: 'interest',
    vault_dir: FOLDER,
  });
  // hidden: no project list, no switcher entry, and the project's own address leads to the interest
  const projects = await (await api.get('/api/projects')).json();
  expect(projects.projects.map((p: any) => p.name)).not.toContain('Firearm news');
  const key = (await q<{ key: string }>('SELECT key FROM projects WHERE id=$1', [projectId]))[0]?.key;
  await page.goto(`/p/${key}/board`);
  await expect(page).toHaveURL(new RegExp(`/interests/${interestId}`));
  await page.goto('/projects');
  await expect(page.getByText('Firearm news')).toHaveCount(0);

  await waitFor(
    'INTEREST.md in the vault',
    async () => originHas(vault, `${FOLDER}/INTEREST.md`) && originFile(vault, `${FOLDER}/INTEREST.md`),
    (t) => typeof t === 'string' && t.includes('# Firearm news'),
    30_000,
  );
  expect(originFile(vault, `${FOLDER}/INTEREST.md`)).toContain('Only posts with measured data');
  await waitFor(
    'taste.md with the rule',
    async () => taste(),
    (t) => t.includes('Skip beginner tutorials'),
    30_000,
  );
});

test('taste: rules reach taste.md as one managed section; an edit replaces it; resync writes it again', async () => {
  await page.goto(`/interests/${interestId}?tab=taste`);
  await expect(page.getByTestId('taste-mirror-status')).toContainText('version 1');
  await page.getByTestId('taste-rule-input').fill(`skip "${TITLES[5]}"`);
  await page.getByTestId('taste-rule-add').click();
  await page.getByTestId('taste-save').click();
  const text = await waitFor(
    'both rules',
    async () => taste(),
    (t) => t.includes('Sierra publishes'),
    30_000,
  );
  expect(sections(text)).toBe(1);
  expect(text.startsWith('# Taste')).toBe(true);
  // edit the first rule: the block is replaced, never duplicated
  await page.getByLabel('Rule 1', { exact: true }).fill('Skip all beginner tutorials');
  await page.getByTestId('taste-save').click();
  const replaced = await waitFor(
    'replaced',
    async () => taste(),
    (t) => t.includes('Skip all beginner'),
    30_000,
  );
  expect(sections(replaced)).toBe(1);
  expect(replaced).not.toContain('Skip beginner tutorials\n');
  const before = (await interestByName('Firearm news')).taste_version;
  await page.getByTestId('taste-resync').click();
  await waitFor(
    'version bumped',
    async () => (await interestByName('Firearm news')).taste_version,
    (v) => v === before + 1,
    15_000,
  );
});

test('run: the digest keeps the best N across kinds, oldest to newest; the run log shows found, published and the items; the desk gets the digest', async () => {
  await page.goto(`/interests/${interestId}?tab=runs`);
  await expect(page.getByTestId('run-log')).toBeVisible();
  const r = await mockRun(interestId, { items: [A1, A2, V1, A3, V2], proposeRule: RULE });
  await done(r.ref);
  const posted = (await digestEvents()).map((e) => e.payload).at(-1);
  // 5 candidates (3 articles and 2 videos), a maximum of 3 items overall whatever the kind
  expect(posted.items.map((i: any) => i.url)).toEqual([A1.url, A2.url, V1.url]);
  expect(posted).toMatchObject({ nothingQualified: false, held: true });
  expect((await list()).map((i) => i.url)).toEqual([A1.url, A2.url, V1.url]);
  const taste1 = await shiftLog(r.ref, 'curate');
  expect(taste1).toContain('mock taste seed: 2 rule(s)');

  // the run log row: found 5 -> published 3, the items and the agents that worked on it
  await page.reload();
  const row = page.getByTestId(`run-${r.ref}`);
  await expect(row.getByTestId('run-counts')).toContainText('found 5 → 3 published');
  await row.getByTestId('run-toggle').click();
  await expect(row.getByTestId('run-item')).toHaveCount(3);
  await expect(row.getByTestId('run-shifts')).toContainText('Sky (scout)');
  await expect(row.getByTestId('run-shifts')).toContainText('Cora (curator)');
  await page.screenshot({ path: `${paths.vaults}/interests-runlog.png` });

  // the vault: feed.md oldest to newest, runs.md with one line
  await waitFor(
    'feed.md in the vault',
    async () => vaultLines(`${FOLDER}/feed.md`).length,
    (n) => n === 3,
    30_000,
  );
  expect(vaultLines(`${FOLDER}/feed.md`).map((l) => /story-(\d)|chrono/.exec(l)?.[0])).toEqual([
    'story-1',
    'story-2',
    'chrono',
  ]);
  await waitFor(
    'runs.md',
    async () => vaultLines(`${FOLDER}/runs.md`).length,
    (n) => n === 1,
    30_000,
  );
  expect(vaultLines(`${FOLDER}/runs.md`)[0]).toMatch(/scan \(manual\): found 5 -> published 3, published, /);

  await page.goto('/desk');
  const rating = page.getByRole('article', { name: 'Rate the Firearm news digest (3 items)' });
  await expect(rating).toBeVisible();
  await expect(rating.getByTestId('desk-interest-link')).toHaveText('Firearm news');
  await expect(rating.getByTestId('digest-items').getByRole('listitem')).toHaveCount(3);
  const video = rating.getByTestId('digest-items').getByRole('listitem').filter({ hasText: V1.title });
  await video.getByRole('button', { name: 'Transcript' }).click();
  await expect(video.getByTestId('transcript-text')).toContainText('mock talk');
  await page.screenshot({ path: `${paths.vaults}/interests-desk.png` });
});

test('rate: a verdict becomes a rating line in the interest taste.md; the curator proposal waits for approval; counts show on the interest', async () => {
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
  const r3 = await row(V1.url);
  await r3.getByRole('button', { name: 'Boring' }).click();
  await expect(rating).toHaveCount(0);

  await waitFor(
    'rating lines in taste.md',
    async () => vaultLines(`${FOLDER}/taste.md`).filter((l) => l.includes('(rated ')).length,
    (n) => n === 3,
    30_000,
  );
  const lines = vaultLines(`${FOLDER}/taste.md`);
  expect(lines).toContain(
    `- Prefer articles like "${A1.title}" from Feed Example (rated useful). Reason: Has load data. Example: ${A1.url}`,
  );
  // the managed section stays above the rating lines
  const t = taste();
  expect(t.indexOf('aom:section seed end')).toBeLessThan(t.indexOf('(rated useful)'));

  const proposal = page.getByRole('article', { name: 'Add a taste rule for Firearm news?' });
  await expect(proposal).toBeVisible();
  await expect(proposal.getByLabel('Rule (editable)')).toHaveValue(RULE);
  await proposal.getByLabel('Rule (editable)').fill('Prefer posts that include chronograph data');
  await proposal.getByRole('button', { name: 'Approve' }).click();
  await expect(proposal).toHaveCount(0);
  await waitFor(
    'the approved rule',
    async () => vaultLines(`${FOLDER}/taste.md`).at(-1),
    (l) => l === '- Rule: Prefer posts that include chronograph data',
    30_000,
  );

  await page.goto('/interests');
  await expect(page.getByTestId('interest-Firearm news').getByTestId('interest-ratings')).toContainText(
    'useful 1 · irrelevant 1 · boring 1 · unrated 0',
  );
  await page.goto(`/interests/${interestId}?tab=taste`);
  await expect(page.getByTestId('taste-ratings')).toContainText('Skip articles like');
  await page.screenshot({ path: `${paths.vaults}/interests-taste.png` });
});

test('run again: the curator reads taste.md, duplicates are skipped, the old list stays untouched', async () => {
  const before = originFile(vault, `${FOLDER}/feed.md`);
  const r = await mockRun(interestId, { items: [A1, A2, V1, A3, V2] });
  await done(r.ref);
  // the curator skips A2 (taste.md) and takes A1, V1 and A3 (the maximum is 3); A1 and V1 are on the seen-list
  const p = (await digestEvents()).map((e) => e.payload).at(-1);
  expect(p.items.map((i: any) => i.url)).toEqual([A3.url]);
  expect(p.duplicatesDropped).toBe(2);
  const texts = await shiftLog(r.ref, 'curate');
  expect(texts).toContain(`mock taste rule: - Skip articles like "${A2.title}"`);
  await waitFor(
    'feed.md appended',
    async () => vaultLines(`${FOLDER}/feed.md`).length,
    (n) => n === 4,
    30_000,
  );
  expect(originFile(vault, `${FOLDER}/feed.md`).startsWith(before)).toBe(true);
  expect((await list()).map((i) => i.url)).toEqual([A1.url, A2.url, V1.url, A3.url]);
  // the run log counts what was dropped
  await page.goto(`/interests/${interestId}?tab=runs`);
  await expect(page.getByTestId(`run-${r.ref}`).getByTestId('run-counts')).toContainText('dup 2');
});

test('nothing qualified logs nothing and says so on the card; the scout cannot fabricate an item', async () => {
  const itemsBefore = (await list()).length;
  const desksBefore = (
    await q<{ n: number }>(`SELECT count(*)::int AS n FROM desk_items WHERE kind='rating'`)
  )[0]?.n;
  const quiet = await mockRun(interestId, { items: [] });
  await done(quiet.ref);
  expect((await list()).length).toBe(itemsBefore);
  expect(
    (await q<{ n: number }>(`SELECT count(*)::int AS n FROM desk_items WHERE kind='rating'`))[0]?.n,
  ).toBe(desksBefore);
  expect((await digestEvents()).map((e) => e.payload).at(-1)).toMatchObject({
    nothingQualified: true,
    items: [],
  });
  await page.goto(`/cards/${quiet.ref}`);
  await expect(page.getByText('Nothing qualified in this run; nothing was logged.').first()).toBeVisible();
  await page.goto(`/interests/${interestId}?tab=runs`);
  await expect(page.getByTestId(`run-${quiet.ref}`)).toContainText('Nothing qualified');

  const fab = await mockRun(interestId, { items: [A1] }, { mock: { scan: ['fabricate'] } });
  await done(fab.ref);
  const h = await q<{ data: any }>(
    `SELECT h.data FROM card_handoffs h JOIN cards c ON c.id=h.card_id WHERE c.ref=$1 AND h.stage='scan'`,
    [fab.ref],
  );
  expect(h[0]?.data.items.map((i: any) => i.url)).toEqual([A1.url]);
  expect(await shiftLog(fab.ref, 'scan')).toMatch(/first report rejected.*not pages you opened/s);
});

test('research this: the dialog starts a research run; its note is published under notes/ and shows on the interest', async () => {
  await page.goto('/interests');
  const cardEl = page.getByTestId('interest-Firearm news');
  await cardEl.getByTestId('interest-research').click();
  const dialog = page.getByTestId('research-dialog');
  await expect(dialog.getByTestId('research-question')).toHaveValue(
    'What should I know now about Firearm news?',
  );
  await dialog.getByTestId('research-submit').click();
  const ref = (await page.getByTestId('research-card-link').textContent())?.trim() as string;
  expect(ref).toMatch(/^[A-Z0-9]+-\d+$/);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  const res = await done(ref, 150_000);
  expect(res[0]).toMatchObject({ card_type: 'research', interest_id: interestId, origin: 'interest' });
  const note = (
    await q<any>('SELECT vault_path, title FROM research_publications WHERE card_id=$1', [res[0].id])
  )[0];
  expect(note.vault_path).toMatch(new RegExp(`^${FOLDER}/notes/`));
  await waitFor(
    'the note in the vault',
    async () => originHas(vault, note.vault_path),
    (b) => b === true,
    30_000,
  );
  await page.goto(`/interests/${interestId}`);
  await expect(page.getByTestId('interest-publications')).toContainText(note.title);
  await page.goto(`/interests/${interestId}?tab=runs`);
  await expect(page.getByTestId(`run-${ref}`)).toContainText('Research');
});

test('preferred agents: the assigned scout takes the run (a soft preference); the settings list only qualified agents', async () => {
  const hire = await api.post('/api/agents', {
    data: { name: 'Sam', roleKey: 'scout', seniority: 'junior', workstationId, runtime: 'mock' },
  });
  expect(hire.status(), await hire.text()).toBe(201);
  await page.goto(`/interests/${interestId}?tab=settings`);
  await page.getByTestId('interest-agent-scout').selectOption({ label: 'Sam' });
  await page.getByTestId('interest-save').click();
  await waitFor(
    'agent saved',
    async () => (await interestByName('Firearm news')).agents,
    (a) => !!a.scout,
    15_000,
  );
  const r = await mockRun(interestId, { items: [item(6)] });
  await done(r.ref);
  const who = await q<{ name: string }>(
    `SELECT a.name FROM shifts s JOIN agents a ON a.id = s.agent_id JOIN cards c ON c.id = s.card_id WHERE c.ref=$1 AND s.stage='scan'`,
    [r.ref],
  );
  expect(who.map((w) => w.name)).toEqual(['Sam']);
  await page.screenshot({ path: `${paths.vaults}/interests-settings.png`, fullPage: true });
});

test('run schedule: the test clock fires a due interest on time; pausing clears the schedule and resuming sets a new one', async () => {
  const res = await api.post('/api/interests', {
    data: {
      name: 'Morning scan',
      description: 'Fires from the clock.',
      scan: { cron: '*/5 * * * *', timezone: 'UTC' },
      delivery: { mode: 'immediate' },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id as string;
  const first = await interestByName('Morning scan');
  expect(new Date(first.next_scan_at).getTime()).toBeGreaterThan(new Date(await clock(0)).getTime());
  const wait = new Date(first.next_scan_at).getTime() - new Date(await clock(0)).getTime() + 2000;
  expect(wait).toBeLessThanOrEqual(5 * 60_000 + 2000);
  await clock(wait);
  const fired = await waitFor(
    'the interest ran',
    () => q<any>(`SELECT * FROM cards WHERE interest_id=$1`, [id]),
    (r) => r.length === 1,
    30_000,
  );
  expect(fired[0]).toMatchObject({ scheduled: true, origin: 'interest', stage: 'scan', card_type: 'feed' });
  const runRow = (await q<any>('SELECT * FROM interest_runs WHERE interest_id=$1', [id]))[0];
  expect(runRow).toMatchObject({ kind: 'scan', trigger: 'cron' });
  await done(fired[0].ref);
  expect(new Date((await interestByName('Morning scan')).next_scan_at).getTime()).toBeGreaterThan(Date.now());

  // pause and resume with the tick on the list
  await page.goto('/interests');
  const cardEl = page.getByTestId('interest-Morning scan');
  await cardEl.getByTestId('interest-toggle').click();
  await expect(cardEl.getByText('Paused', { exact: true })).toBeVisible();
  expect((await interestByName('Morning scan')).next_scan_at).toBeNull();
  await expect(cardEl.getByTestId('interest-next-scan')).toContainText('not scheduled');
  await cardEl.getByTestId('interest-toggle').click();
  await expect(cardEl.getByText('Active', { exact: true })).toBeVisible();
  expect((await interestByName('Morning scan')).next_scan_at).not.toBeNull();
});

test('delivery schedule and quiet cap: items wait for the delivery time, then arrive as one digest within the cap', async () => {
  const now = new Date(await clock(0));
  // delivery every hour at :00 UTC, so the clock reaches it with a small step
  const res = await api.post('/api/interests', {
    data: {
      name: 'Weekly picks',
      scan: { manual: true },
      delivery: { mode: 'scheduled', cron: '0 * * * *', timezone: 'UTC' },
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = (await res.json()).id as string;
  const r = await mockRun(id, {
    items: [
      item(1, { url: 'https://picks.example.test/1' }),
      item(2, { url: 'https://picks.example.test/2' }),
      item(3, { url: 'https://picks.example.test/3' }),
    ],
  });
  await done(r.ref);
  await page.goto('/interests');
  const cardEl = page.getByTestId('interest-Weekly picks');
  await expect(cardEl).toContainText('3 waiting for delivery');
  await expect(cardEl.getByTestId('interest-delivery')).toContainText('Delivery: Every hour');
  expect((await list(id)).length).toBe(0);
  await expect(page.getByRole('article', { name: /Rate the Weekly picks digest/ })).toHaveCount(0);

  // the cap: this many digest items may arrive today
  const state = await (await api.get('/api/interests')).json();
  await page.getByTestId('quiet-cap-edit').click();
  await page.getByTestId('quiet-cap-input').fill(String(state.deliveredToday + 2));
  await page.getByTestId('quiet-cap-save').click();
  await expect(page.getByTestId('quiet-cap-line')).toContainText(`At most ${state.deliveredToday + 2}`);

  // the next full hour passes: two of the three items arrive, one is held back by the cap
  const next = new Date((await interestByName('Weekly picks')).next_delivery_at).getTime();
  await clock(next - now.getTime() + 2000);
  await waitFor(
    'two delivered',
    async () => (await list(id)).length,
    (n) => n === 2,
    60_000,
  );
  await page.goto(`/interests/${id}?tab=runs`);
  await expect(page.getByTestId('delivery-log')).toContainText(
    '2 items on your desk, 1 held back by the quiet cap',
  );
  await page.goto('/desk');
  await expect(page.getByRole('article', { name: 'Rate the Weekly picks digest (2 items)' })).toBeVisible();
  expect((await (await api.get(`/api/interests/${id}`)).json()).interest.stats.items.held).toBe(1);
  await api.put('/api/reporting', { data: { interestDigestCap: null } });
});

test('archive, restore and delete: archiving stops it, deleting needs the folder name', async () => {
  await page.goto('/interests');
  await page.getByTestId('interest-Weekly picks').getByTestId('interest-edit').click();
  await page.getByLabel('More actions').click();
  await page.getByRole('menuitem', { name: /Archive/ }).click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await waitFor(
    'archived',
    () => interestByName('Weekly picks'),
    (r) => r?.archived_at != null,
    15_000,
  );
  await page.goto('/interests');
  await expect(page.getByTestId('interest-Weekly picks')).toHaveCount(0);
  await page.getByTestId('interests-archived').check();
  await page.getByTestId('interest-Weekly picks').getByTestId('interest-edit').click();
  await page.getByLabel('More actions').click();
  await page.getByRole('menuitem', { name: /Delete permanently/ }).click();
  const confirm = page.getByTestId('interest-delete-confirm');
  await expect(confirm).toBeDisabled();
  await page.getByTestId('interest-delete-slug').fill('weekly-picks');
  await confirm.click();
  await expect(page).toHaveURL(/\/interests$/);
  expect(await interestByName('Weekly picks')).toBeUndefined();
});

test('the phone layout works at 390x844: the list, the tabs and the settings form', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/interests');
  const cardEl = page.getByTestId('interest-Firearm news');
  await expect(cardEl.getByTestId('interest-ratings')).toBeVisible();
  await page.screenshot({ path: `${paths.vaults}/interests-mobile-list.png`, fullPage: true });
  await cardEl.getByTestId('interest-edit').click();
  await expect(page.getByTestId('interest-detail')).toBeVisible();
  const widths = await page.evaluate('[document.documentElement.scrollWidth, window.innerWidth]');
  const [scrollWidth, innerWidth] = widths as number[];
  expect((scrollWidth as number) <= (innerWidth as number) + 1).toBe(true);
  await page.getByTestId('interest-tab-settings').click();
  await expect(page.getByTestId('interest-form')).toBeVisible();
  await page.screenshot({ path: `${paths.vaults}/interests-mobile-settings.png` });
  await page.getByTestId('interest-tab-runs').click();
  await expect(page.getByTestId('run-log')).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
});
