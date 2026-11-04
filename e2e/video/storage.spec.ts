import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { pool } from '../support/db.ts';
import { E2E_DIR } from '../support/env.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/storage.ts';
import { createProject, demoApi, pairWorkstation } from './seed.ts';

/**
 * The Storage video (sidebar section 32, no sidebar entry of its own): Organization settings > Storage. The empty tab, Add
 * storage (a local folder), Connect, Test connection, Rename, and the other types.
 * Output: media/videos/storage.{webm,mp4,vtt,json}
 *   e2e/video/record.sh storage
 */
const SLUG = 'storage';
const FOLDER = join(E2E_DIR, 'Client documents');

test.afterAll(async () => {
  await pool.end();
});

test('record the storage video', async ({ browser }) => {
  mkdirSync(FOLDER, { recursive: true });
  // ---- seed (demo data only): one online workstation, no storage -----------------------------------------------------
  const api = await demoApi();
  await createProject(api, 'LET', 'Lettings', { repo: false });
  const workstationId = await pairWorkstation(api);

  // ---- voice and camera ----------------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Storage connections',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const tab = (name: string) => page.getByRole('tab', { name, exact: true });
  // The sealing of the folder uses the real time of the workstation (the test clock may be ahead, see seed.ts).
  await page.route('**/api/workstations/*/integrations', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    if (typeof body?.serverTime === 'string') body.serverTime = new Date().toISOString();
    await route.fulfill({ response: res, json: body });
  });

  await page.goto('/desk');
  await expect(page.getByTestId('nav-organization')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-organization'));
    await click(page, tab('Storage'));
    await expect(page.getByTestId('storage-tab')).toBeVisible();
    await expect(page.getByText('No storage connected yet')).toBeVisible();
    await pause(1500);
  });

  await chapter(2);
  const add = page.getByTestId('storage-add-dialog');
  await narrate('c2-a', async () => {
    await click(page, page.getByTestId('storage-new'));
    await expect(add).toBeVisible();
    await pause(600);
    await add.getByLabel('Type').selectOption('local');
    await type(page, add.getByLabel('Display name'), 'Client documents', 90);
    await expect(add.getByLabel('Workstation')).toHaveValue(workstationId);
    await pause(800);
    await click(page, page.getByTestId('storage-add-next'));
  });
  const dialog = page.getByTestId('storage-connect-dialog');
  await narrate('c2-b', async () => {
    await expect(dialog).toBeVisible();
    await type(page, dialog.getByLabel('Folder on the workstation'), FOLDER, 40);
    await expect(page.getByTestId('storage-seal-connect')).toBeEnabled();
    await click(page, page.getByTestId('storage-seal-connect'));
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  });

  await chapter(3);
  const row = page.locator('[data-testid^="storage-row-"]').first();
  await narrate('c3-a', async () => {
    await expect(row.locator('[data-testid^="storage-state-"]')).toHaveText('Connected', { timeout: 20_000 });
    await pause(800);
    await click(page, row.locator('[data-testid^="storage-test-"]'));
    await expect(page.getByTestId('storage-test-ok')).toHaveText('Test passed.', { timeout: 30_000 });
    await pause(800);
  });
  await narrate('c3-b', async () => {
    await click(page, row.getByRole('button', { name: 'Rename' }));
    const rename = page.getByRole('dialog', { name: 'Rename storage' });
    await expect(rename).toBeVisible();
    await rename.getByLabel('Display name').fill('Client files (office)');
    await pause(600);
    await click(page, rename.getByRole('button', { name: 'Save' }));
    await expect(row).toContainText('Client files (office)');
    await pause(1500);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await click(page, page.getByTestId('storage-new'));
    await expect(add).toBeVisible();
    await pause(800);
    for (const kind of ['onedrive', 'google_drive', 's3', 'vault']) {
      await add.getByLabel('Type').selectOption(kind);
      await pause(1800);
    }
    await click(page, page.getByRole('button', { name: 'Cancel' }));
    await expect(add).toHaveCount(0);
  });
  await narrate('outro-1');

  await finish();
});
