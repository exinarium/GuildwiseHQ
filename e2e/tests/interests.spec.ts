import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, inviteAndAccept } from '../support/api.ts';
import { q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, INTERESTER, paths } from '../support/env.ts';
import { pairRunner, startRunner } from '../support/runner.ts';
import { makeVault, originFile, originHas, type VaultFixture } from '../support/vault.ts';

// The Interests page (docs/design/interests.md): one place for "what I care about". A mock scout, curator, researcher
// and checker (no network, no tokens) drive the scans and the research; "Run now" starts every scan, so no test waits
// on cron. The explicit taste rules reach the curator through its brief and are mirrored into taste.md in the vault.
test.describe.configure({ mode: 'serial' });

const HOME = paths.runnerHome('interests');
let page: Page;
let api: APIRequestContext;
let workstationId: string;
let vault: VaultFixture;
let newsId: string;
let researchId: string;
let oldScheduleId: string;
let aifId: string;
let interestId: string;

const TASTE = 'projects/aif/taste.md';
const interestByName = async (name: string) =>
  (await q<any>('SELECT * FROM interests WHERE name=$1', [name]))[0];
const taste = (): string => (originHas(vault, TASTE) ? originFile(vault, TASTE) : '');
const sections = (text: string) => (text.match(/aom:section seed v=/g) ?? []).length;
const waitTaste = (what: string, pred: (t: string) => boolean) =>
  waitFor(what, async () => taste(), pred, 30_000);

test.beforeAll(async ({ browser }) => {
  const admin = await apiAs(ADMIN.email, ADMIN.password);
  await inviteAndAccept(admin, INTERESTER);
  api = await apiAs(INTERESTER.email, INTERESTER.password);
  page = await (await browser.newContext({ storageState: await api.storageState() })).newPage();
});

test('setup: a paired runner with a personal vault, a feed and a research project, four agents and a plain schedule', async () => {
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

  vault = makeVault('interests', { 'projects/res/PROJECT.md': '# Research\n' });
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

  const news = await api.post('/api/projects', {
    data: { key: 'NEWS', name: 'News', workflowKey: 'feed', domain: 'personal' },
  });
  expect(news.status(), await news.text()).toBe(201);
  newsId = (await news.json()).project.id;
  const res = await api.post('/api/projects', {
    data: {
      key: 'RES',
      name: 'Research',
      workflowKey: 'research',
      domain: 'personal',
      subCategories: ['rust'],
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  researchId = (await res.json()).project.id;

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
  // a feed schedule made the old way (on the Schedules page)
  const sched = await api.post('/api/schedules', {
    data: {
      projectId: newsId,
      name: 'Old scan',
      cron: '0 7 * * *',
      timezone: 'UTC',
      cardTemplate: {
        title: 'Old scan',
        fields: { topic: 'Reloading', description: 'Powders and bullets.' },
      },
    },
  });
  expect(sched.status(), await sched.text()).toBe(201);
  oldScheduleId = (await sched.json()).id;
});

test('adopt: the banner lists the plain schedule; adopting makes it an interest and locks it on the Schedules page', async () => {
  await page.goto('/interests');
  await expect(page.getByTestId('adopt-banner')).toContainText('1 feed schedule is not an interest yet');
  await page.getByTestId('adopt-banner').getByRole('button', { name: 'Review and adopt' }).click();
  const dialog = page.getByTestId('adopt-dialog');
  await expect(dialog.getByTestId('adopt-row-Old scan')).toBeVisible();
  await dialog.getByTestId('adopt-submit').click();
  await expect(dialog.getByTestId('adopt-result')).toHaveText('Adopted');
  await dialog.getByRole('button', { name: 'Close' }).click();

  const card = page.getByTestId('interest-Reloading');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('interest-cadence')).toContainText('Daily at 07:00');
  await expect(page.getByTestId('adopt-banner')).toHaveCount(0);
  const row = (await q<any>('SELECT * FROM schedules WHERE id=$1', [oldScheduleId]))[0];
  expect(row.interest_id).toBe((await interestByName('Reloading')).id);

  await page.goto('/schedules');
  const sched = page.getByTestId('schedule-Old scan');
  await expect(sched.getByTestId('schedule-managed')).toContainText('Managed by interest Reloading');
  await expect(sched.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(sched.getByRole('button', { name: 'Pause' })).toHaveCount(0);
  await expect(sched.getByRole('button', { name: 'Run now' })).toBeVisible();
  // the server refuses a direct edit too
  const direct = await api.patch(`/api/schedules/${oldScheduleId}`, { data: { enabled: false } });
  expect(direct.status()).toBe(409);
  expect((await direct.json()).error.code).toBe('schedule_managed_by_interest');
});

test('create: a new interest with an inline new feed project and an existing research project; edits reach its schedule', async () => {
  await page.goto('/interests');
  await page.getByTestId('interest-new').click();
  const drawer = page.getByTestId('interest-drawer');
  await drawer.getByTestId('interest-name').fill('AI feeds');
  await drawer.getByTestId('interest-description').fill('Practical agent engineering, no hype.');
  await drawer.getByTestId('interest-feed-project').selectOption('__new');
  await drawer.getByTestId('new-feed-key').fill('AIF');
  await drawer.getByTestId('new-feed-name').fill('AI feeds');
  await drawer.getByTestId('interest-research-project').selectOption({ label: 'RES Research' });
  await page.screenshot({ path: `${paths.vaults}/interests-drawer.png` });
  await drawer.getByTestId('interest-save').click();
  await expect(page.getByTestId('interest-AI feeds')).toBeVisible();

  const created = await interestByName('AI feeds');
  interestId = created.id;
  aifId = (await q<any>(`SELECT id FROM projects WHERE key='AIF'`))[0].id;
  expect(created.feed_project_id).toBe(aifId);
  expect(created.research_project_id).toBe(researchId);

  await page.goto('/schedules');
  const sched = page.getByTestId('schedule-AI feeds');
  await expect(sched.getByTestId('schedule-description')).toHaveText('Practical agent engineering, no hype.');
  await expect(sched.getByTestId('schedule-managed')).toBeVisible();

  // editing the description updates the schedule's template
  await page.goto(`/interests?open=${interestId}`);
  const edit = page.getByTestId('interest-drawer');
  await edit.getByTestId('interest-description').fill('Agent engineering: evals, tools, memory.');
  await edit.getByTestId('interest-save').click();
  await expect(edit).toHaveCount(0);
  await waitFor(
    'the schedule template follows the interest',
    async () => (await q<any>('SELECT card_template FROM schedules WHERE interest_id=$1', [interestId]))[0],
    (s) => s?.card_template?.fields?.description === 'Agent engineering: evals, tools, memory.',
    15_000,
  );
  await page.goto('/schedules');
  await expect(page.getByTestId('schedule-AI feeds').getByTestId('schedule-description')).toHaveText(
    'Agent engineering: evals, tools, memory.',
  );
});

test('taste: project and interest rules reach taste.md as one managed section above the rating lines; an edit replaces it', async () => {
  await page.goto(`/interests?open=${interestId}`);
  const drawer = page.getByTestId('interest-drawer');
  await drawer.getByTestId('taste-rule-input').fill('skip "Mock item 2"');
  await drawer.getByTestId('taste-rule-add').click();
  await drawer.getByTestId('interest-save').click();
  await expect(drawer).toHaveCount(0);

  await page.getByTestId('taste-project-AIF').getByRole('button', { name: 'Edit taste rules' }).click();
  const dialog = page.getByTestId('project-taste-dialog');
  await dialog.getByTestId('taste-rule-input').fill('Prefer primary sources');
  await dialog.getByTestId('taste-rule-add').click();
  await dialog.getByTestId('project-taste-save').click();
  await expect(dialog).toHaveCount(0);

  const text = await waitTaste(
    'both rules in taste.md',
    (t) => t.includes('Prefer primary sources') && t.includes('skip "Mock item 2"'),
  );
  expect(sections(text)).toBe(1);
  expect(text).toContain('### AI feeds (interest)');
  expect(text.indexOf('Prefer primary sources')).toBeLessThan(text.indexOf('### AI feeds'));

  // edit the project rule: the block is replaced, never duplicated
  await page.getByTestId('taste-project-AIF').getByRole('button', { name: 'Edit taste rules' }).click();
  const again = page.getByTestId('project-taste-dialog');
  await again.getByLabel('Rule 1', { exact: true }).fill('Prefer primary sources and papers');
  await again.getByTestId('project-taste-save').click();
  const replaced = await waitTaste('the rule was replaced', (t) => t.includes('primary sources and papers'));
  expect(sections(replaced)).toBe(1);
  expect(replaced).not.toContain('Prefer primary sources\n');
  expect((await q<any>('SELECT version FROM taste_seeds WHERE project_id=$1', [aifId]))[0].version).toBe(
    2 + 1,
  );
});

test('run now: the digest follows the rules, ratings show on the interest and the Digests link filters the feed', async () => {
  await page.goto('/interests');
  const card = page.getByTestId('interest-AI feeds');
  await card.getByTestId('interest-run').click();
  const ref = (await card.getByTestId('interest-run-result').locator('a').textContent())?.trim() as string;
  expect(ref).toMatch(/^AIF-\d+$/);
  const done = await waitFor(
    `${ref} done`,
    () => q<any>('SELECT * FROM cards WHERE ref=$1', [ref]),
    (r) => r[0]?.status === 'done',
    90_000,
  );
  expect(done[0].interest_id).toBe(interestId);
  const items = await q<any>('SELECT id, title FROM digest_items WHERE card_id=$1 ORDER BY position', [
    done[0].id,
  ]);
  expect(items.map((i) => i.title)).toEqual(['Mock item 1', 'Mock video 3']);

  const log = (
    await waitFor(
      'curator shift ended',
      () =>
        q<{ status: string; progress_tail: Array<{ text: string }> }>(
          `SELECT s.status, s.progress_tail FROM shifts s JOIN cards c ON c.id = s.card_id WHERE c.ref=$1 AND s.stage='curate'`,
          [ref],
        ),
      (r) => r.length > 0 && r.every((x) => x.status === 'ended'),
      30_000,
    )
  )
    .flatMap((r) => r.progress_tail.map((t) => t.text))
    .join('\n');
  expect(log).toContain('mock taste seed: 2 rule(s)');
  expect(log).toContain('mock taste: managed section stripped');

  await api.post(`/api/digest-items/${items[0]?.id}/rate`, { data: { verdict: 'useful' } });
  await api.post(`/api/digest-items/${items[1]?.id}/rate`, { data: { verdict: 'boring' } });
  await page.reload();
  await expect(page.getByTestId('interest-AI feeds').getByTestId('interest-ratings')).toContainText(
    'useful 1 · irrelevant 0 · boring 1 · unrated 0',
  );
  // rating lines are appended below the managed section
  const withRatings = await waitTaste('rating lines in taste.md', (t) => t.includes('(rated boring)'));
  expect(withRatings.indexOf('aom:section seed end')).toBeLessThan(withRatings.indexOf('(rated useful)'));
  expect(sections(withRatings)).toBe(1);

  await page.getByTestId('interest-AI feeds').getByTestId('interest-digests').click();
  await expect(page).toHaveURL(new RegExp(`/p/AIF/feed\\?interest=${interestId}`));
  await expect(page.getByTestId('interest-filter-chip')).toContainText('AI feeds');
  await expect(page.getByTestId('feed-list').locator('li')).toHaveCount(2);
  await page.getByTestId('interest-filter-chip').getByRole('button', { name: 'Clear' }).click();
  await expect(page.getByTestId('interest-filter-chip')).toHaveCount(0);
});

test('research this: the dialog is prefilled; the mock researcher and checker publish and the interest shows the note', async () => {
  await page.goto('/interests');
  const card = page.getByTestId('interest-AI feeds');
  await card.getByTestId('interest-research').click();
  const dialog = page.getByTestId('research-dialog');
  await expect(dialog.getByTestId('research-title')).toHaveValue('Research: AI feeds');
  await expect(dialog.getByTestId('research-question')).toHaveValue('What should I know now about AI feeds?');
  await dialog.getByTestId('research-submit').click();
  const ref = (await page.getByTestId('research-card-link').textContent())?.trim() as string;
  expect(ref).toMatch(/^RES-\d+$/);
  await page.getByRole('button', { name: 'Close' }).click();

  const res = await waitFor(
    `${ref} done`,
    () => q<any>('SELECT * FROM cards WHERE ref=$1', [ref]),
    (r) => r[0]?.status === 'done',
    120_000,
  );
  expect(res[0].interest_id).toBe(interestId);
  await page.reload();
  const fresh = page.getByTestId('interest-AI feeds');
  await expect(fresh.getByTestId('interest-notes-line')).toContainText('Notes 1');
  await fresh.getByTestId('interest-notes').click();
  await expect(fresh.getByTestId('interest-publications').getByRole('link', { name: ref })).toBeVisible();
});

test('pause and resume follow the schedule; the mobile layout works at 390x844', async () => {
  await page.goto('/interests');
  const card = page.getByTestId('interest-AI feeds');
  await card.getByTestId('interest-toggle').click();
  await expect(card.getByText('Paused', { exact: true })).toBeVisible();
  const paused = (
    await q<any>('SELECT enabled, next_fire_at FROM schedules WHERE interest_id=$1', [interestId])
  )[0];
  expect(paused).toMatchObject({ enabled: false, next_fire_at: null });
  await card.getByTestId('interest-toggle').click();
  await expect(card.getByText('Active', { exact: true })).toBeVisible();
  const resumed = (
    await q<any>('SELECT enabled, next_fire_at FROM schedules WHERE interest_id=$1', [interestId])
  )[0];
  expect(resumed.enabled).toBe(true);
  expect(resumed.next_fire_at).not.toBeNull();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/interests');
  await expect(page.getByTestId('interest-AI feeds').getByTestId('interest-ratings')).toBeVisible();
  await page.screenshot({ path: `${paths.vaults}/interests-mobile-list.png`, fullPage: true });
  await page.getByTestId('interest-AI feeds').getByTestId('interest-edit').click();
  const drawer = page.getByTestId('interest-drawer');
  const box = await drawer.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(385);
  await page.screenshot({ path: `${paths.vaults}/interests-mobile-drawer.png` });
  await drawer.getByRole('button', { name: 'Cancel' }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('delete: the confirm offers to keep the schedule', async () => {
  await page.goto(`/interests?open=${(await interestByName('Reloading')).id}`);
  const drawer = page.getByTestId('interest-drawer');
  await drawer.getByTestId('interest-delete').click();
  await page.getByTestId('interest-keep-schedule').check();
  await page.getByTestId('interest-delete-confirm').click();
  await expect(page.getByTestId('interest-Reloading')).toHaveCount(0);
  const kept = (await q<any>('SELECT interest_id FROM schedules WHERE id=$1', [oldScheduleId]))[0];
  expect(kept.interest_id).toBeNull();
  await page.goto('/schedules');
  await expect(page.getByTestId('schedule-Old scan').getByRole('button', { name: 'Delete' })).toBeVisible();
});
