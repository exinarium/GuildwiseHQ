import { expect, test } from '@playwright/test';
import { pool } from '../support/db.ts';
import { paths } from '../support/env.ts';
import { killRunner } from '../support/runner.ts';
import { click } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/workstations.ts';
import { createProject, demoApi, pairWorkstation } from './seed.ts';

/**
 * The Workstations video (sidebar section 13): the Add a workstation wizard, pairing with a code, the workstation card
 * (health, Shifts at once, git hosts) and Check for updates.
 * Output: media/videos/workstations.{webm,mp4,vtt,json}
 *   e2e/video/record.sh workstations
 */
const SLUG = 'workstations';

test.afterAll(async () => {
  await pool.end();
});

test('record the workstations video', async ({ browser }) => {
  // ---- seed (demo data only): two mock workstations, one online and one offline -----------------------------------
  const api = await demoApi();
  await createProject(api, 'SHOP', 'Web shop');
  const studioHome = paths.runnerHome('video-studio');
  await pairWorkstation(api, 'Studio Mac mini', studioHome);
  killRunner('SIGKILL', studioHome); // the second machine is switched off: it stays paired but offline
  await pairWorkstation(api, "Alex's laptop");

  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Workstations',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through: starts on the Board, then opens Workstations from the sidebar ---------------------------------
  await page.goto('/p/SHOP/board');
  const nav = page.locator('[data-tour="nav-workstations"]');
  await expect(nav).toBeVisible();
  await narrate('intro-1');

  const laptop = page.getByTestId("workstation-Alex's laptop");
  const studio = page.getByTestId('workstation-Studio Mac mini');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, nav);
    await expect(laptop).toBeVisible();
    await expect(studio).toBeVisible();
    await expect(studio.getByTestId('connection-dot')).toHaveAttribute('data-connected', 'false');
    await expect(laptop.getByTestId('connection-dot').first()).toHaveAttribute('data-connected', 'true');
  });
  const wizard = page.getByTestId('add-workstation');
  await narrate('c1-b', async () => {
    await click(page, page.getByTestId('add-workstation-button'));
    await expect(wizard).toBeVisible();
    await pause(800);
    await page.mouse.move(640, 300, { steps: 20 }); // point at the three choices
    await click(page, page.getByTestId('where-local'));
  });
  await narrate('c1-c', async () => {
    await click(page, page.getByTestId('os-linux'));
    await expect(page.getByTestId('install-command')).toBeVisible();
    await pause(1200);
    const progress = page.getByTestId('stage-started');
    await progress.scrollIntoViewIfNeeded();
    await expect(progress).toContainText('Waiting for you to run the command');
    const box = await progress.boundingBox();
    if (box) await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 25 });
    await pause(1000);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, page.getByTestId('pair-with-code'));
    const dlg = page.getByRole('dialog', { name: 'Pair with a code' });
    await expect(dlg).toBeVisible();
    await pause(600);
    await click(page, dlg.getByRole('button', { name: 'Generate pairing code' }));
    await expect(page.getByTestId('pairing-code')).toBeVisible();
    await pause(2500);
    await click(page, dlg.getByRole('button', { name: 'Close dialog' }));
    await expect(dlg).toBeHidden();
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    const dot = laptop.getByTestId('connection-dot').first();
    const box = await dot.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
    await pause(1200);
    const count = laptop.getByText(/shifts? running/);
    const cb = await count.boundingBox();
    if (cb) await page.mouse.move(cb.x + cb.width / 2, cb.y + cb.height / 2, { steps: 20 });
    await pause(1200);
    await click(page, laptop.getByTestId('workstation-toggle'));
    await expect(laptop.getByTestId('workstation-details')).toBeVisible();
  });
  await narrate('c3-b', async () => {
    const shifts = laptop.getByTestId('workstation-shifts');
    await shifts.scrollIntoViewIfNeeded();
    const sb = await shifts.boundingBox();
    if (sb) await page.mouse.move(sb.x + 40, sb.y + sb.height / 2, { steps: 25 });
    await pause(1500);
    const limit = laptop.getByLabel('Shifts at once');
    await click(page, limit);
    await page.keyboard.press('Escape');
    await pause(1500);
    const git = laptop.getByTestId('git-connections');
    await git.scrollIntoViewIfNeeded();
    const gb = await git.boundingBox();
    if (gb) await page.mouse.move(gb.x + 60, gb.y + 12, { steps: 25 });
    await pause(1500);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await laptop.scrollIntoViewIfNeeded();
    await page.evaluate('window.scrollTo(0, 0)');
    await pause(500);
    await click(page, laptop.getByTestId('update-check-button'));
    await expect(laptop.getByTestId('update-check-result')).toBeVisible({ timeout: 20_000 });
    await pause(1500);
  });
  await narrate('outro-1');

  await finish();
});
