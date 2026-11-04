import { expect, test } from '@playwright/test';
import { pool } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/forms.ts';
import {
  addLocalStorage,
  createClientLink,
  createProject,
  createRentalForm,
  demoApi,
  pairWorkstation,
  submitPublicForm,
} from './seed.ts';

/**
 * The Forms video (sidebar section 30): the builder (palette, properties, Save, Versions), Preview, the Share tab (public
 * address, QR code, Publish changes), the form as a client sees it, personal links and Submissions.
 * Output: media/videos/forms.{webm,mp4,vtt,json}
 *   e2e/video/record.sh forms
 */
const SLUG = 'forms';

test.afterAll(async () => {
  await pool.end();
});

test('record the forms video', async ({ browser }) => {
  // ---- seed (demo data only): a workstation with a connected local folder, a published form, one personal link and one
  // submission made through the public page ------------------------------------------------------------------------------
  const api = await demoApi();
  await createProject(api, 'LET', 'Lettings', { repo: false });
  const workstationId = await pairWorkstation(api);
  const storageId = await addLocalStorage(browser, api, workstationId, 'Client documents');
  const form = await createRentalForm(api, storageId);
  const link = await createClientLink(api, form.formId, 'client-1042');
  await submitPublicForm(browser, link, {
    name: 'Dana Whitfield',
    email: 'dana.whitfield@client.example',
    phone: '0123 456 7890',
    moveIn: '2027-01-15',
    home: 'One bedroom',
  });

  // ---- voice and camera ----------------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Forms: build a form',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const publicPath = new URL(form.url).pathname;

  await page.goto('/desk');
  await expect(page.getByTestId('nav-forms')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-forms'));
    await expect(page.getByTestId('forms-list')).toContainText('Rental application');
    await pause(1500);
  });
  await narrate('c1-b', async () => {
    await click(page, page.getByTestId('forms-list').getByRole('link', { name: /Rental application/ }));
    await expect(page.getByTestId('form-builder')).toBeVisible();
    await expect(page.getByTestId('canvas-field-0')).toBeVisible();
    await pause(1200);
    await click(page, page.getByTestId('select-field-2'));
    await expect(page.getByTestId('field-properties')).toBeVisible();
    await pause(900);
    await page.getByLabel('Required', { exact: true }).hover();
    await pause(900);
    await click(page, page.getByTestId('palette-long_text'));
    await expect(page.getByTestId('field-properties')).toContainText('Long text field');
    const label = page.getByTestId('field-properties').getByLabel('Label', { exact: true });
    await label.fill('');
    await type(page, label, 'Anything we should know?', 60);
    await pause(900);
  });
  await narrate('c1-c', async () => {
    await click(page, page.getByTestId('save-form'));
    await expect(page.getByTestId('form-version')).toContainText('Version 2');
    await pause(700);
    await click(page, page.getByRole('button', { name: 'Versions' }));
    await pause(1500);
    await page.keyboard.press('Escape');
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, page.getByTestId('tab-preview'));
    await expect(page.getByTestId('preview-frame')).toBeVisible();
    await pause(1500);
    await click(page, page.getByRole('button', { name: 'Phone', exact: true }));
    await pause(1800);
    await click(page, page.getByRole('button', { name: 'Desktop', exact: true }));
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, page.getByTestId('tab-share'));
    await expect(page.getByTestId('publish-panel')).toContainText('Published');
    await pause(1500);
    await page.getByTestId('public-url').hover();
    await pause(1200);
    await click(page, page.getByTestId('publish-form'));
    await expect(page.getByText('Version 2 is live.')).toBeVisible();
    await pause(900);
  });
  await narrate('c3-b', async () => {
    await page.goto(publicPath);
    await expect(page.getByTestId('form-renderer')).toBeVisible();
    await pause(2500);
    await page.mouse.move(640, 360, { steps: 20 });
    await pause(2000);
    await page.goBack();
    await expect(page.getByTestId('form-builder')).toBeVisible();
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await click(page, page.getByTestId('tab-share'));
    await expect(page.getByTestId('client-links')).toContainText('client-1042');
    await click(page, page.getByTestId('new-client-link'));
    await type(page, page.getByTestId('link-reference'), 'client-1043', 90);
    await pause(700);
    await click(page, page.getByRole('button', { name: 'Create link' }));
    await expect(page.getByTestId('client-links')).toContainText('client-1043');
    await pause(1500);
  });
  await narrate('c4-b', async () => {
    await page.getByTestId('submissions').scrollIntoViewIfNeeded();
    await expect(page.getByTestId('submissions')).toContainText('client-1042');
    await pause(2500);
  });
  await narrate('outro-1');

  await finish();
});
