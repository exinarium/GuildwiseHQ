import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, storagePath } from '../support/api.ts';
import { pool, q, waitFor } from '../support/db.ts';
import { MEMBER } from '../support/env.ts';
import { startRunner } from '../support/runner.ts';

// Mobile (PWA) flows at iPhone size (project `mobile`: the iPhone 15 descriptor, WebKit with AOM_E2E_WEBKIT=1, else
// Chromium). Runs after the whole chain: the TOY project, its builders and the member exist.
test.describe.configure({ mode: 'serial' });
test.use({ storageState: storagePath('member') });

let page: Page;
let api: APIRequestContext;
let projectId: string;
let repoId: string;

const SPEC = {
  context: 'Mobile flow.',
  requirements: 'Ask the manager, then build.',
  acceptanceCriteria: ['It works'],
  affectedAreas: 'index.js',
  constraints: 'None',
  testPlan: 'Run the tests',
};

test.beforeAll(async ({ browser }) => {
  page = await (
    await browser.newContext({ storageState: storagePath('member'), ...test.info().project.use })
  ).newPage();
  api = await apiAs(MEMBER.email, MEMBER.password);
  const projects = (await (await api.get('/api/projects')).json()).projects;
  projectId = projects.find((p: { key: string }) => p.key === 'TOY').id;
  repoId = (await (await api.get(`/api/projects/${projectId}`)).json()).repos[0].id;
  startRunner({ AOM_MOCK_CHAT_TOKEN_MS: '50' });
});
test.afterAll(async () => {
  await pool.end();
});

async function createCard(title: string, mock?: Record<string, string[]>, specify = true) {
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title,
      cardType: 'feature',
      repoId,
      completionAction: 'push_branch',
      fields: { ...SPEC, ...(mock ? { mock } : {}) },
      specify,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  return { ref: body.card.ref as string, id: body.card.id as string };
}
// Compared with the device width, not innerWidth: a mobile browser widens the layout viewport to fit overflowing content.
const noHorizontalScroll = (p: Page) =>
  p.evaluate(`document.documentElement.scrollWidth <= ${p.viewportSize()?.width ?? 390}`) as Promise<boolean>;

test('answer a desk question: tap the card, pick an option in the full-screen sheet, answer', async () => {
  const card = await createCard('Mobile question', { build: ['question', 'ok'] });
  await waitFor(
    'card blocked',
    async () => (await q<any>('SELECT status FROM cards WHERE ref=$1', [card.ref]))[0],
    (r) => r?.status === 'blocked',
    90_000,
  );
  await page.goto('/desk');
  const row = page.getByRole('button', { name: `Mock question for ${card.ref}?` });
  await expect(row).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await row.tap();
  const sheet = page.getByTestId('desk-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('radio', { name: /yes/ })).toBeChecked();
  await page.screenshot({ path: '/tmp/aom-e2e-mobile-desk-sheet.png' });
  await sheet.getByRole('button', { name: 'Answer' }).tap();
  await expect(sheet).toHaveCount(0);
  const done = await q<any>(
    `SELECT status FROM desk_items WHERE card_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [card.id],
  );
  expect(done[0].status).not.toBe('open');
});

test('approve an owner approval: unified diff accordion, approval binds to the sha, tap plus send', async () => {
  const sha = 'a'.repeat(40);
  const cardId = '0192f3a0-0000-7000-8000-0000000000c1';
  const item = {
    id: '0192f3a0-0000-7000-8000-000000000a01',
    kind: 'question',
    subkind: 'approval_step',
    status: 'open',
    routedTo: 'manager',
    title: 'Approve MOB-1?',
    body: '',
    doing: null,
    options: [],
    recommendation: null,
    blocking: true,
    pinned: false,
    urgent: false,
    affectedCardIds: [cardId],
    affectedCount: 1,
    askedBy: { kind: 'system' },
    card: {
      id: cardId,
      ref: 'MOB-1',
      title: 'Mobile',
      stage: 'owner_approval',
      status: 'waiting',
      projectKey: 'MOB',
    },
    projectId,
    dedupEntries: [],
    answer: null,
    answerOption: null,
    answeredAt: null,
    answeredByName: null,
    decisionPolicy: 'owner_only',
    canAnswer: true,
    createdAt: new Date().toISOString(),
  };
  const diff = `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new ${'x'.repeat(200)}\ndiff --git a/b.ts b/b.ts\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-1\n+2\n`;
  let approveBody: unknown = null;
  await page.route('**/api/desk?*', async (route) => {
    const status = new URL(route.request().url()).searchParams.get('status');
    await route.fulfill({
      json: { items: status === 'open' ? [item] : [], counts: { open: 1, blocking: 1, urgent: 0 } },
    });
  });
  await page.route(`**/api/cards/${cardId}/diff*`, (route) =>
    route.fulfill({ json: { body: diff, truncated: false, sha } }),
  );
  await page.route(`**/api/cards/${cardId}/approve`, async (route) => {
    approveBody = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/desk');
  await page.getByRole('button', { name: 'Approve MOB-1?' }).tap();
  const sheet = page.getByTestId('desk-sheet');
  await sheet.getByTestId('approval-desk-diff-toggle').tap();
  await expect(sheet.getByTestId('diff-view')).toBeVisible();
  const toggles = sheet.getByTestId('diff-file-toggle');
  await expect(toggles).toHaveCount(2);
  await expect(toggles.first()).toHaveAttribute('aria-expanded', 'false');
  await toggles.first().tap();
  expect(await noHorizontalScroll(page)).toBe(true);
  await sheet.getByTestId('approval-desk-approve').tap();
  await expect.poll(() => approveBody).toMatchObject({ sha });
  await page.unroute('**/api/desk?*');
});

test('send a chat message from the desk chat screen', async () => {
  await page.goto('/desk');
  await page.getByRole('button', { name: 'Chat', exact: true }).tap();
  const drawer = page.getByRole('dialog', { name: 'Chat' });
  await drawer.getByLabel('Agent').selectOption({ label: 'Linus (reviewer)' });
  await drawer.getByRole('button', { name: 'Start chat' }).tap();
  await expect(drawer.getByTestId('chat-panel')).toBeVisible();
  const box = await drawer.getByRole('form', { name: 'Compose' }).boundingBox();
  const vp = page.viewportSize();
  expect(box && vp && box.y + box.height <= vp.height + 1).toBe(true);
  await drawer.getByLabel('Message').fill('hello from the phone');
  await drawer.getByRole('button', { name: 'Send' }).tap();
  await expect(drawer.getByTestId('chat-message').last()).toContainText('hello from the phone', {
    timeout: 30_000,
  });
  await expect(drawer.getByTestId('chat-message').last()).toContainText('(turn 1)', { timeout: 30_000 });
  await page.screenshot({ path: '/tmp/aom-e2e-mobile-chat.png' });
});

test('create a card from the intake form (New card) on a phone', async () => {
  await page.goto('/cards/new?project=TOY');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByLabel(/^Title/).fill('Phone-made card');
  const accept = await page.getByTestId('new-card-file-input').getAttribute('accept');
  expect(accept).toContain('image/*');
  await page.getByRole('button', { name: 'Save draft' }).tap();
  await expect
    .poll(async () => (await q<any>(`SELECT 1 FROM cards WHERE title='Phone-made card'`)).length)
    .toBe(1);
});

test('move a card with "Move to..." from the card detail actions sheet', async () => {
  const card = await createCard('Phone move', undefined, false);
  await page.goto(`/cards/${card.ref}`);
  expect(await noHorizontalScroll(page)).toBe(true);
  await page.getByTestId('card-actions').tap();
  await page.getByTestId('move-to').tap();
  const sheet = page.getByTestId('move-to-sheet');
  await expect(sheet).toBeVisible();
  const target = sheet
    .getByRole('button', { pressed: false })
    .filter({ hasNotText: /Current|Close|Move card/ })
    .first();
  const targetId = await target.getAttribute('data-testid');
  await target.tap();
  await sheet.getByLabel('Reason').fill('moved from my phone');
  await sheet.getByRole('button', { name: 'Move card' }).tap();
  await expect(sheet).toHaveCount(0);
  const stage = targetId?.replace('move-to-', '');
  await expect
    .poll(async () => (await q<any>('SELECT stage FROM cards WHERE ref=$1', [card.ref]))[0]?.stage)
    .toBe(stage);
});

const PAGES = [
  '/',
  '/desk',
  '/projects',
  '/p/TOY/board',
  '/p/TOY/archive',
  '/cards/new?project=TOY',
  '/agents',
  '/metrics',
  '/org',
  '/org-chart',
  '/org/ceo',
  '/costs',
  '/workstations',
  '/integrations',
  '/settings',
  '/settings/vaults',
  '/settings/org',
  '/automations',
  '/interests',
  '/ledger',
  '/intake',
  '/help',
  '/help/glossary',
  '/help/contact',
];

test('smoke: every page fits a 390px screen without sideways scrolling', async () => {
  const projects = (await (await api.get('/api/projects')).json()).projects as Array<{ id: string }>;
  const list = [...PAGES, ...projects.slice(0, 2).map((p) => `/projects/${p.id}/settings`)];
  const board = (await (await api.get(`/api/board?projectId=${projectId}`)).json()) as {
    columns: Array<{ cards: Array<{ ref: string }> }>;
  };
  const first = board.columns.flatMap((c) => c.cards)[0];
  if (first) list.push(`/cards/${first.ref}`);
  const offenders: string[] = [];
  for (const path of list) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(250);
    if (!(await noHorizontalScroll(page))) {
      const w = await page.evaluate('document.documentElement.scrollWidth');
      offenders.push(`${path} (${w}px)`);
    }
  }
  expect(offenders, `pages wider than the screen: ${offenders.join(', ')}`).toEqual([]);
});
