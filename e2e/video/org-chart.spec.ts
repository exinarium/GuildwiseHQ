import { expect, test } from '@playwright/test';
import { pool } from '../support/db.ts';
import { click } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/org-chart.ts';
import { createProject, demoApi, pairWorkstation, provisionCeo } from './seed.ts';

/**
 * The Org chart video (sidebar section 10): the chart, an agent's details, Allowed on project, the Chart and List
 * views, and the Workstations and DevOps panel.
 * Output: media/videos/org-chart.{webm,mp4,vtt,json}
 *   e2e/video/record.sh org-chart
 */
const SLUG = 'org-chart';

test.afterAll(async () => {
  await pool.end();
});

test('record the org-chart video', async ({ browser }) => {
  // ---- seed (demo data only): six agents on two projects, the CEO, one workstation with its DevOps engineer ----------
  const api = await demoApi();
  const prepared = prepareVideo({ slug: SLUG, title: 'The org chart', cues: allCues(), chapters: CHAPTERS });
  const { projectId: shop } = await createProject(api, 'SHOP', 'Web shop');
  const { projectId: blog } = await createProject(api, 'BLOG', 'Company blog', { repo: false });
  await provisionCeo(api);
  const workstationId = await pairWorkstation(api);
  const hire = async (name: string, roleKey: string, allowed: string[] | null, seniority = 'junior') => {
    const r = await api.post('/api/agents', {
      data: { name, roleKey, seniority, runtime: 'mock', workstationId, allowedProjectIds: allowed },
    });
    expect(r.status(), `${name}: ${await r.text()}`).toBe(201);
  };
  await hire('Bea', 'ba', null, 'senior');
  await hire('Max', 'builder', [shop], 'senior');
  await hire('Ben', 'builder', [shop]);
  await hire('Linus', 'reviewer', [shop], 'senior');
  await hire('Nora', 'planner', [blog]);
  await hire('Tess', 'tester', [shop, blog]);

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through ----------------------------------------------------------------------------------------------
  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('nav-org-chart')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-org-chart'));
    await expect(page.getByTestId('org-chart')).toBeVisible();
    await expect(page.getByTestId('org-manager')).toBeVisible();
    await pause(1500);
  });
  await narrate('c1-l', async () => {
    await page
      .getByRole('list', { name: 'Legend' })
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'end' }));
    await pause(1000);
  });
  await narrate('c1-b', async () => {
    await click(page, page.locator('[data-testid="org-agent"][data-agent="Max"]').first());
    await expect(page.getByTestId('org-agent-card')).toBeVisible();
    await pause(5000);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('org-agent-card')).toHaveCount(0);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await pause(800);
    await click(page, page.getByTestId('org-project-filter'), 200);
    await page.getByTestId('org-project-filter').selectOption({ label: 'BLOG Company blog' });
    await expect(page.getByTestId('org-summary')).toContainText('allowed on BLOG');
    await pause(2500);
    await page.getByTestId('org-project-filter').selectOption({ label: 'All projects' });
  });
  await narrate('c2-b', async () => {
    const view = page.getByRole('radiogroup', { name: 'View' });
    await click(page, view.getByRole('button', { name: 'List' }));
    await expect(page.getByTestId('org-chart')).toHaveCount(0);
    await pause(2500);
    await click(page, view.getByRole('button', { name: 'Chart' }));
    await expect(page.getByTestId('org-chart')).toBeVisible();
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    const panel = page.getByTestId('org-devops');
    await panel.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await expect(panel.getByTestId('org-workstation')).toHaveCount(1);
    await pause(1000);
  });
  await narrate('outro-1');

  await finish();
});
