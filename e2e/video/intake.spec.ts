import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { pool, waitFor } from '../support/db.ts';
import { paths } from '../support/env.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/intake.ts';
import { createProject, demoApi, hireAgent, pairWorkstation } from './seed.ts';

/**
 * The Intake video (sidebar section 6): one ticket through the chat with the BA, the Batch tab, and the choice between
 * `Tell your CEO` and `Work with the BA directly`. The tickets are demo Jira tickets served to the mock BA from fixture
 * files (its "Jira skill"); no real Jira is contacted.
 * Output: media/videos/intake.{webm,mp4,vtt,json}
 *   e2e/video/record.sh intake
 */
const SLUG = 'intake';

test.afterAll(async () => {
  await pool.end();
});

test('record the intake video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Intake: bring in tickets',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const home = paths.runnerHome('video');
  const sources = join(home, 'mock-sources');
  mkdirSync(sources, { recursive: true });
  for (const [key, title, body] of [
    [
      'SUP-240',
      'Show the delivery estimate on the order confirmation page',
      'Customers ask when the parcel arrives. Show the expected delivery date on the confirmation page.',
    ],
    [
      'SUP-241',
      'Add a "reorder" button to past orders',
      'Returning customers want to repeat an order in one click.',
    ],
    [
      'SUP-242',
      'Let customers change the delivery address until the order ships',
      'Support gets this request every week.',
    ],
  ] as const)
    writeFileSync(
      join(sources, `${key}.json`),
      JSON.stringify({
        title,
        body,
        project: 'SHOP',
        acceptanceCriteria: ['It works on a phone', 'Support can see the change'],
      }),
    );
  const api = await demoApi();
  const ws = await pairWorkstation(api, "Alex's laptop", home);
  const { projectId } = await createProject(api, 'SHOP', 'Web shop');
  await waitFor(
    'the workstation holds the repository',
    async () =>
      ((await (await api.get('/api/workstations')).json()).workstations as Array<{ repos: unknown[] }>)[0]
        ?.repos.length ?? 0,
    (n) => n >= 1,
    30_000,
  );
  await hireAgent(api, { name: 'Bea', roleKey: 'ba', seniority: 'senior', workstationId: ws });
  expect(projectId).toBeTruthy();

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const nav = page.getByRole('navigation', { name: 'Main' });

  // ---- the walk-through: starts on the Desk, opens Intake from the sidebar -----------------------------------------
  await page.goto('/desk');
  await expect(nav.getByRole('link', { name: 'Intake', exact: true })).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  const form = page.getByRole('form', { name: 'Start an intake' });
  await narrate('c1-a', async () => {
    await click(page, nav.getByRole('link', { name: 'Intake', exact: true }));
    await expect(form).toBeVisible();
    await type(page, form.getByLabel('Ticket or need'), 'SUP-240');
    await expect(page.getByTestId('intake-source')).toContainText('SUP-240');
  });
  await narrate('c1-b', async () => {
    const ceo = page.getByTestId('intake-via-ceo');
    const box = await ceo.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
    await pause(3500);
    const ba = form.getByRole('button', { name: 'Work with the BA directly' });
    const b2 = await ba.boundingBox();
    if (b2) await page.mouse.move(b2.x + b2.width / 2, b2.y + b2.height / 2, { steps: 25 });
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, form.getByRole('button', { name: 'Work with the BA directly' }));
    await expect(page).toHaveURL(/\/intake\/[0-9a-f-]{36}$/);
    await expect(page.getByTestId('chat-panel')).toContainText('Read Jira ticket SUP-240', {
      timeout: 60_000,
    });
  });
  await narrate('c2-b', async () => {
    await expect(page.getByTestId('intake-cards').getByRole('link').first()).toContainText(
      'delivery estimate',
      {
        timeout: 60_000,
      },
    );
    await pause(1500);
  });

  await chapter(3);
  const batch = page.getByRole('form', { name: 'Start a batch intake' });
  await narrate('c3-a', async () => {
    await click(page, nav.getByRole('link', { name: 'Intake', exact: true }));
    await click(page, page.getByRole('tab', { name: 'Batch' }));
    await expect(batch).toBeVisible();
    const box = batch.getByLabel('Tickets, one per line');
    await click(page, box, 100);
    await box.pressSequentially('SUP-241\nSUP-242', { delay: 70 });
    await expect(page.getByTestId('batch-summary')).toContainText('2 ticket(s)');
    await batch.getByLabel('Project (optional)').selectOption({ label: 'SHOP: Web shop' });
    await pause(600);
  });
  await narrate('c3-b', async () => {
    await click(page, batch.getByRole('button', { name: 'Start batch' }));
    await expect(page).toHaveURL(/\/intake\/batches\//);
    await expect(page.getByTestId('batch-items')).toBeVisible();
    await pause(2500);
  });
  await narrate('outro-1', async () => {
    await click(page, nav.getByRole('link', { name: 'Intake', exact: true }));
    await expect(page.getByTestId('intake-list')).toContainText('SUP-240');
    const list = page.getByTestId('intake-list');
    const box = await list.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + 20, { steps: 25 });
  });

  await finish();
});
