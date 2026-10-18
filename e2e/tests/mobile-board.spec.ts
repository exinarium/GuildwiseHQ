import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { apiAs, storagePath } from '../support/api.ts';
import { pool, q } from '../support/db.ts';
import { MEMBER } from '../support/env.ts';

// The project board on a phone: an accordion list, Move to... instead of drag and drop, no sideways scroll. Runs on
// WebKit's iPhone 15 when AOM_E2E_WEBKIT=1, else Chromium at the same viewport with touch. Needs only the pairing spec
// (member, project TOY); its cards stay drafts (no `specify`), so no runner or agent is involved.
test.describe.configure({ mode: 'serial' });

const SHOTS = process.env.AOM_E2E_SHOTS;
let page: Page;
let api: APIRequestContext;
let projectId: string;
let repoId: string;
const card: { ref: string; id: string } = { ref: '', id: '' };

const noHorizontalScroll = (p: Page) =>
  p.evaluate(`document.documentElement.scrollWidth <= ${p.viewportSize()?.width ?? 390}`) as Promise<boolean>;

test.beforeAll(async ({ browser }) => {
  page = await (
    await browser.newContext({ storageState: storagePath('member'), ...test.info().project.use })
  ).newPage();
  api = await apiAs(MEMBER.email, MEMBER.password);
  const projects = (await (await api.get('/api/projects')).json()).projects;
  projectId = projects.find((p: { key: string }) => p.key === 'TOY').id;
  repoId = (await (await api.get(`/api/projects/${projectId}`)).json()).repos[0].id;
  const res = await api.post('/api/cards', {
    data: {
      projectId,
      title: 'Phone board card',
      cardType: 'feature',
      repoId,
      completionAction: 'merge',
      fields: {
        context: 'Phone flow.',
        requirements: 'Move it.',
        acceptanceCriteria: ['It moves'],
        affectedAreas: 'index.js',
        constraints: 'None',
        testPlan: 'None',
      },
      specify: false,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const body = await res.json();
  card.ref = body.card.ref;
  card.id = body.card.id;
});
test.afterAll(async () => {
  await pool.end();
});

test('the board is an accordion: expand a stage, no sideways scroll, New card above the tab bar', async () => {
  await page.goto('/p/TOY/board');
  await expect(page.getByTestId('stage-strip')).toBeVisible();
  const tile = page.getByTestId(`card-tile-${card.ref}`);
  const section = page.getByRole('region').filter({ has: tile });
  const header = section
    .getByRole('button', { expanded: true })
    .or(section.getByRole('button', { expanded: false }))
    .first();
  if ((await header.getAttribute('aria-expanded')) === 'false') await header.tap();
  await expect(tile).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
  // the first section and its first card are above the fold
  await expect(page.getByRole('region').first().getByRole('button').first()).toBeInViewport({ ratio: 1 });
  await expect(tile).toBeInViewport({ ratio: 1 });
  const fab = page.getByTestId('new-card-fab');
  await expect(fab).toBeInViewport();
  expect((await fab.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  if (SHOTS) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: `${SHOTS}/board-${scheme}.png` });
    }
    await page.emulateMedia({ colorScheme: 'light' });
  }
});

test('Move to... moves the card through the sheet', async () => {
  await page.goto('/p/TOY/board');
  await expect(page.getByTestId('stage-strip')).toBeVisible();
  const tile = page.getByTestId(`card-tile-${card.ref}`);
  await expect(tile).toBeAttached();
  if (!(await tile.isVisible())) {
    await page
      .getByRole('region')
      .filter({ has: tile })
      .getByRole('button', { expanded: false })
      .first()
      .tap();
  }
  await expect(tile).toBeVisible();
  await page.getByTestId(`card-actions-${card.ref}`).tap();
  const sheet = page.getByTestId('move-to-sheet');
  await expect(sheet).toBeVisible();
  const before = (await q<{ stage: string }>('SELECT stage FROM cards WHERE id=$1', [card.id]))[0]?.stage;
  await sheet
    .getByRole('list', { name: 'Target stage' })
    .getByRole('button', { disabled: false })
    .first()
    .tap();
  await sheet.getByLabel('Reason').fill('moved from the phone');
  await sheet.getByRole('button', { name: 'Move card' }).tap();
  await expect(sheet).toBeHidden();
  const after = (await q<{ stage: string }>('SELECT stage FROM cards WHERE id=$1', [card.id]))[0]?.stage;
  expect(after).not.toBe(before);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('the projects list stacks and does not scroll sideways', async () => {
  await page.goto('/projects');
  await expect(page.getByTestId('project-counts-TOY')).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});
