import { expect, test } from '@playwright/test';
import { pool } from '../support/db.ts';
import { click } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/settings.ts';
import { createProject, demoApi } from './seed.ts';

/**
 * The Settings video (sidebar section 21): your picture, two-factor login (shown, not enrolled), Expert mode for code
 * changes, the Monday briefing, notifications, the weekly blog digest and your time zone.
 * Output: media/videos/settings.{webm,mp4,vtt,json}
 *   e2e/video/record.sh settings
 */
const SLUG = 'settings';

test.afterAll(async () => {
  await pool.end();
});

test('record the settings video', async ({ browser }) => {
  // ---- seed (demo data only): the Owner is signed in; a project so the sidebar is not empty ---------------------------
  const api = await demoApi();
  await createProject(api, 'SHOP', 'Web shop', { repo: false });

  // ---- voice and camera ----------------------------------------------------------------------------------------------
  const prepared = prepareVideo({ slug: SLUG, title: 'Your settings', cues: allCues(), chapters: CHAPTERS });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const navSettings = page.locator('[data-tour="nav-settings"]');

  await page.goto('/desk');
  await expect(navSettings).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, navSettings);
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await pause(800);
    await click(page, page.getByTestId('change-picture'));
    const dialog = page.getByRole('dialog', { name: 'Your picture' });
    await expect(dialog).toBeVisible();
    await pause(1200);
    await click(page, dialog.getByTestId('avatar-choice').nth(2));
    await pause(600);
    await click(page, dialog.getByTestId('avatar-save'));
    await expect(dialog).toHaveCount(0);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await page.getByTestId('two-factor-panel').scrollIntoViewIfNeeded();
    await page.getByTestId('set-up-2fa').hover();
    await pause(1500);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    const expert = page.getByTestId('git-expert');
    await expert.scrollIntoViewIfNeeded();
    await expect(expert).not.toBeChecked();
    await page.getByText('Show me branches and git controls').hover();
    await pause(1500);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    const briefing = page.getByTestId('weekly-briefing');
    await page.evaluate('window.scrollBy({ top: 360, behavior: "smooth" })');
    await pause(900);
    await briefing.scrollIntoViewIfNeeded();
    await page.getByText('Email me the Monday briefing').hover();
  });
  await narrate('c4-b', async () => {
    const heading = page.getByRole('heading', { name: 'Notifications', exact: true });
    await heading.scrollIntoViewIfNeeded();
    await heading.hover();
  });
  await narrate('c4-c', async () => {
    await page.getByTestId('blog-digest').scrollIntoViewIfNeeded();
    await page.getByText('Email me the weekly blog digest').hover();
  });

  await chapter(5);
  await narrate('c5-a', async () => {
    const zone = page.getByTestId('timezone');
    await zone.scrollIntoViewIfNeeded();
    await click(page, zone, 200);
    await zone.selectOption('Europe/London');
    await expect(page.getByText('Time zone saved')).toBeVisible();
  });
  await narrate('outro-1', async () => {
    await page.evaluate('window.scrollTo({ top: 0, behavior: "smooth" })');
  });

  await finish();
});
