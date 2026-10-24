import { expect, type Locator, type Page, test } from '@playwright/test';
import { pool } from '../support/db.ts';
import { click } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/costs.ts';
import { demoApi } from './seed.ts';
import { monthSpendMicros, seedDemoHistory } from './seed-history.ts';

/**
 * The Costs video (sidebar section 17): range and project, Total spend and By day, By project with the budget meter,
 * By agent and By model, What the agents delivered, Export CSV and Currency and prices. 30 days of shift costs across
 * two projects are written by seed-history.ts; the web shop's
 * monthly budget is then set through the API so that this month's spend is at about 80 percent of it.
 * Output: media/videos/costs.{webm,mp4,vtt,json}
 *   e2e/video/record.sh costs
 */
const SLUG = 'costs';

test.afterAll(async () => {
  await pool.end();
});

async function showPanel(page: Page, target: Locator, offset = 110): Promise<void> {
  const box = await target.boundingBox();
  if (box) await page.evaluate(`window.scrollBy({ top: ${Math.round(box.y - offset)}, behavior: 'smooth' })`);
  await pause(900);
}

async function pointAt(page: Page, target: Locator, dx = 0.5): Promise<void> {
  const box = await target.boundingBox();
  if (box) await page.mouse.move(box.x + box.width * dx, box.y + box.height / 2, { steps: 25 });
}

test('record the costs video', async ({ browser }) => {
  // ---- seed (demo data only): two projects, five agents, 30 days of costs, a budget at about 80 percent -----------------
  const api = await demoApi();
  const { shop } = await seedDemoHistory(api);
  const spent = (await monthSpendMicros(shop)) / 1_000_000;
  expect(spent).toBeGreaterThan(1);
  const budget = Math.ceil(spent / 0.8 / 5) * 5; // a round number, so the meter sits just under 80 percent
  const r = await api.put(`/api/projects/${shop}/budget`, { data: { monthly: budget } });
  expect(r.status(), await r.text()).toBe(200);

  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Costs and budgets',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through: starts on the Board, then opens Costs from the sidebar ----------------------------------------
  await page.goto('/p/SHOP/board');
  const nav = page.getByTestId('nav-costs');
  await expect(nav).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, nav);
    await expect(page.getByTestId('costs-total')).toBeVisible();
    await pause(500);
    const range = page.getByRole('group', { name: 'Range' });
    await click(page, range.getByRole('button', { name: 'Last month' }), 900);
    await click(page, range.getByRole('button', { name: 'Last 30 days' }), 900);
    await expect(range.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
    await pointAt(page, page.getByLabel('From'));
    await pause(700);
    await pointAt(page, page.getByLabel('Project'));
  });
  await narrate('c1-b', async () => {
    await showPanel(page, page.getByTestId('costs-total'), 150);
    await pointAt(page, page.getByTestId('costs-total'));
    await pause(1800);
    await pointAt(page, page.getByRole('heading', { name: 'By day' }));
  });

  await chapter(2);
  const byProject = page.getByTestId('costs-by-project');
  await narrate('c2-a', async () => {
    await showPanel(page, byProject);
    await pause(800);
    const shopRow = byProject.getByTestId('costs-project-row').filter({ hasText: 'Web shop' });
    await pointAt(page, shopRow.getByRole('cell').nth(2));
  });
  await narrate('c2-c', async () => {
    await showPanel(page, page.getByTestId('costs-by-agent'));
    await pointAt(page, page.getByTestId('costs-by-agent'), 0.2);
    await pause(1800);
    await pointAt(page, page.getByTestId('costs-by-model'), 0.2);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    const value = page.getByTestId('value-panel');
    await expect(value).toBeVisible();
    await showPanel(page, value, 160);
    await pointAt(page, page.getByTestId('value-headline'), 0.3);
    await pause(2500);
    const actions = page.getByTestId('value-actions');
    if (await actions.isVisible()) await pointAt(page, actions, 0.2);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await page.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })");
    await pause(800);
    await pointAt(page, page.getByTestId('costs-export'));
    await pause(2000);
    const currency = page.getByRole('heading', { name: 'Currency and prices' });
    await showPanel(page, currency);
    await pointAt(page, page.getByTestId('currency-code'));
    await pause(1200);
    await click(page, page.getByText('Prices used (US dollars per million tokens)'));
    await expect(page.getByTestId('costs-prices')).toBeVisible();
  });
  await narrate('outro-1');

  await finish();
});
