import { expect, test } from '@playwright/test';
import { pool } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/backlog.ts';
import { createProject, demoApi } from './seed.ts';

/**
 * The Backlog video (sidebar section 2): quick add, flag, sort, drop, and choosing what to send to the BA.
 * Output: apps/web/public/videos/backlog.{webm,mp4,vtt,json}
 *   e2e/video/record.sh backlog
 */
const SLUG = 'backlog';

test.afterAll(async () => {
  await pool.end();
});

test('record the backlog video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const api = await demoApi();
  const { projectId } = await createProject(api, 'SHOP', 'Web shop');
  for (const [title, priority] of [
    ['Product search box', 'high'],
    ['Customer reviews on product pages', 'normal'],
    ['Order confirmation email', 'normal'],
    ['Gift wrapping option', 'low'],
  ] as const) {
    const r = await api.post(`/api/projects/${projectId}/backlog`, { data: { title, priority } });
    expect(r.status(), await r.text()).toBe(201);
  }

  const prepared = prepareVideo({
    slug: SLUG,
    title: 'The project backlog',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through: starts on the Board so the sidebar knows the project, then opens Backlog from it --------------
  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('nav-backlog')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-backlog'));
    await expect(page.getByTestId('backlog-list')).toBeVisible();
  });
  await narrate('c1-b', async () => {
    await type(page, page.getByLabel('Add to the backlog'), 'Wishlist for returning customers');
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('backlog-row')).toHaveCount(5);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, page.getByRole('button', { name: 'Flag Product search box' }));
  });
  await narrate('c2-b', async () => {
    await page.getByLabel('Sort').selectOption({ label: 'Newest' });
    await pause(1500);
  });
  await narrate('c2-s', async () => {
    await type(page, page.getByLabel('Search the backlog'), 'review');
    await expect(page.getByTestId('backlog-row')).toHaveCount(1);
    await pause(1200);
    await page.getByLabel('Search the backlog').fill('');
    await expect(page.getByTestId('backlog-row')).toHaveCount(5);
  });
  await narrate('c2-c', async () => {
    await click(page, page.getByRole('button', { name: 'Actions for Gift wrapping option' }));
    await click(page, page.getByRole('menuitem', { name: 'Drop' }));
    await click(page, page.getByRole('dialog').getByRole('button', { name: 'Drop' }));
    await expect(page.getByTestId('backlog-row')).toHaveCount(4);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, page.getByLabel('Select Product search box'));
    await click(page, page.getByLabel('Select Order confirmation email'));
    await expect(page.getByRole('button', { name: 'Send 2 to the BA' })).toBeVisible();
    await pause(1500);
  });
  await narrate('outro-1');

  await finish();
});
