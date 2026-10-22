import { expect, test } from '@playwright/test';
import { pool } from '../support/db.ts';
import { paths } from '../support/env.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/ceo.ts';
import { ceoAct, createProject, demoApi, pairWorkstation, provisionCeo } from './seed.ts';

/**
 * The CEO video (sidebar section 11): Overview, Authority, Reporting & alerts, Ask {CEO}, the Activity log with Undo,
 * and the Workstations tab.
 * Output: apps/web/public/videos/ceo.{webm,mp4,vtt,json}
 *   e2e/video/record.sh ceo
 */
const SLUG = 'ceo';

test.afterAll(async () => {
  await pool.end();
});

test('record the ceo video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const api = await demoApi();
  const prepared = prepareVideo({ slug: SLUG, title: 'Your CEO', cues: allCues(), chapters: CHAPTERS });
  const { projectId, repoId } = await createProject(api, 'SHOP', 'Web shop');
  const ceo = await provisionCeo(api); // the Owner's first workstation becomes its home
  expect(ceo.name).toBe('Ada'); // the narration names it
  const workstationId = await pairWorkstation(api);
  await pairWorkstation(api, 'Studio desktop', paths.runnerHome('studio'));
  const r = await api.post('/api/agents', {
    data: {
      name: 'Ben',
      roleKey: 'builder',
      seniority: 'junior',
      runtime: 'mock',
      workstationId,
      allowedProjectIds: [projectId],
    },
  });
  expect(r.status(), await r.text()).toBe(201);
  for (const title of ['Product search box', 'Order confirmation email']) {
    const c = await api.post('/api/cards', {
      data: {
        projectId,
        title,
        cardType: 'feature',
        repoId,
        completionAction: 'merge',
        fields: {
          context: 'Demo context.',
          requirements: title,
          acceptanceCriteria: ['It works', 'It is visible'],
          affectedAreas: 'index.js',
          constraints: 'None',
          testPlan: 'Open the page',
        },
        specify: true,
      },
    });
    expect(c.status(), await c.text()).toBe(201);
  }
  // A short activity log: real decisions through the CEO's action engine, checked against its policy.
  const results = ceoAct([
    {
      action: 'move',
      params: { card: 'SHOP-1', to: 'build', note: 'the brief is complete' },
      reason: 'SHOP-1 has a complete brief: straight to build',
    },
    {
      action: 'raise-model',
      params: { card: 'SHOP-1', model: 'opus', effort: 'high', note: 'search touches many files' },
      reason: 'the search change touches many files: a stronger model for this card',
    },
    { action: 'priority', params: { card: 'SHOP-2', to: 2 }, reason: 'customers ask for order emails first' },
    {
      action: 'pause-agent',
      params: { agent: 'Ben', reason: 'idle while the builder queue is empty' },
      reason: 'Ben has been idle while no builder work waits',
    },
  ]);
  for (const x of results) expect(x.mode, JSON.stringify(results)).toBe('decided');
  expect(results).toHaveLength(4);

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through ----------------------------------------------------------------------------------------------
  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('nav-ceo')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-ceo'));
    await expect(page.getByTestId('ceo-name')).toHaveText('Ada');
    await pause(1500);
    await page.getByTestId('ceo-pause').hover();
  });

  await chapter(2);
  const tab = (name: string | RegExp) => page.getByRole('tab', { name });
  await narrate('c2-a', async () => {
    await click(page, tab('Authority'));
    await expect(page.getByTestId('ceo-authority')).toBeVisible();
  });
  await narrate('c2-b', async () => {
    await page
      .getByTestId('ceo-class-card.move')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(1000);
    await page.getByTestId('ceo-class-card.raise_model').hover();
    await pause(1200);
    await page.getByTestId('ceo-class-card.send_to_tester').hover();
  });
  await narrate('c2-c', async () => {
    await page
      .getByTestId('ceo-desk-map')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(1000);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await click(page, tab('Reporting & alerts'));
    await expect(page.getByRole('form', { name: 'Reporting and alerts' })).toBeVisible();
    await pause(2000);
    await page.mouse.wheel(0, 350);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await click(page, page.getByTestId('ask-ceo-button'));
    await expect(page.getByTestId('ceo-chat-screen')).toBeVisible();
    const box = page.getByPlaceholder('Message Ada');
    await type(page, box, 'How is the desk today?');
    await box.press('Enter');
    await expect(page.getByText(/open items? on the desk/).first()).toBeVisible({ timeout: 60_000 });
  });
  await narrate('c4-b', async () => {
    await click(page, page.getByTestId('ceo-chat-new'));
    await expect(page.getByTestId('ceo-chat-row')).toHaveCount(2);
    await pause(1200);
  });

  await chapter(5);
  const row = page.getByTestId('ceo-action').filter({ hasText: 'Ben' }).first();
  await narrate('c5-a', async () => {
    await click(page, page.getByTestId('nav-ceo'));
    await click(page, tab('Activity log'));
    await expect(page.getByTestId('ceo-action')).toHaveCount(4);
    await page.getByTestId('ceo-activity').getByRole('table').hover();
    await pause(1500);
  });
  await narrate('c5-b', async () => {
    await click(page, row.getByRole('button', { name: 'Undo' }));
    await pause(800);
    await click(page, page.getByRole('dialog').getByRole('button', { name: 'Undo', exact: true }));
    await expect(row).toHaveAttribute('data-status', 'undone');
  });

  await chapter(6);
  await narrate('c6-a', async () => {
    await click(page, tab('Workstations'));
    await expect(page.getByTestId('ceo-home')).toContainText("Alex's laptop");
    await pause(800);
    await click(page, page.getByRole('button', { name: 'Move the CEO to Studio desktop' }));
    await expect(page.getByTestId('ceo-home')).toContainText('Studio desktop');
  });
  await narrate('outro-1');

  await finish();
});
