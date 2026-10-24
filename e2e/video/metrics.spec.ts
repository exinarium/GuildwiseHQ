import { expect, type Locator, type Page, test } from '@playwright/test';
import { pool } from '../support/db.ts';
import { click } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/metrics.ts';
import { demoApi } from './seed.ts';
import { seedDemoHistory } from './seed-history.ts';

/**
 * The Metrics video (sidebar section 16): the range and Project filter, then the six panels. A mock run lasts minutes,
 * so 30 days of finished cards, waits, test runs and shifts across two projects are written by seed-history.ts.
 * Output: media/videos/metrics.{webm,mp4,vtt,json}
 *   e2e/video/record.sh metrics
 */
const SLUG = 'metrics';

test.afterAll(async () => {
  await pool.end();
});

/** Scrolls a panel near the top (below the step banner) and moves the pointer onto its heading. */
async function showPanel(page: Page, heading: Locator): Promise<void> {
  const box = await heading.boundingBox();
  if (box) await page.evaluate(`window.scrollBy({ top: ${Math.round(box.y - 110)}, behavior: 'smooth' })`);
  await pause(900);
  const b = await heading.boundingBox();
  if (b) await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 25 });
}

test('record the metrics video', async ({ browser }) => {
  // ---- seed (demo data only): two projects, five agents, 30 days of history ------------------------------------------
  const api = await demoApi();
  await seedDemoHistory(api);

  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Metrics',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through: starts on the Board, then opens Metrics from the sidebar --------------------------------------
  await page.goto('/p/SHOP/board');
  const nav = page.locator('[data-tour="nav-metrics"]');
  await expect(nav).toBeVisible();
  await narrate('intro-1');

  const h = (name: string) => page.getByRole('heading', { name, exact: true });
  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, nav);
    await expect(page.getByTestId('metrics')).toBeVisible();
    await expect(page.getByTestId('metric-throughput-total')).not.toHaveText('0');
    await pause(600);
    const range = page.getByRole('group', { name: 'Range' });
    await click(page, range.getByRole('button', { name: '7 days' }), 900);
    await click(page, range.getByRole('button', { name: '30 days' }), 900);
    await click(page, page.getByLabel('Project'));
    await page.getByLabel('Project').selectOption({ label: 'SHOP Web shop' });
    await pause(1200);
    await page.getByLabel('Project').selectOption({ label: 'All projects' });
    await pause(600);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await showPanel(page, h('Throughput'));
    await pause(3500);
    await showPanel(page, h('Time blocked on you'));
    await pause(1000);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await showPanel(page, h('Bounce rate per builder'));
    await expect(page.getByTestId('metric-bounce')).toBeVisible();
    await pause(4000);
    await showPanel(page, h('Bugs escaped past test'));
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await showPanel(page, h('Duration'));
    await pause(4000);
    await showPanel(page, h('Queue depth per column'));
    await expect(page.getByTestId('metric-queue')).toBeVisible();
  });
  await narrate('outro-1', async () => {
    await page.evaluate("window.scrollTo({ top: 0, behavior: 'smooth' })");
  });

  await finish();
});
