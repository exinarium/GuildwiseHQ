import { expect, test } from '@playwright/test';
import { pool, q } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/agents.ts';
import { createProject, demoApi, pairWorkstation, provisionCeo } from './seed.ts';

/**
 * The Agents video (sidebar section 9): Hire agent, Pause and Resume, Change model, the recommendations (apply one,
 * dismiss one) and the Project filter.
 * Output: media/videos/agents.{webm,mp4,vtt,json}
 *   e2e/video/record.sh agents
 */
const SLUG = 'agents';

test.afterAll(async () => {
  await pool.end();
});

test('record the agents video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const api = await demoApi();
  const prepared = prepareVideo({ slug: SLUG, title: 'Your agents', cues: allCues(), chapters: CHAPTERS });
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
  await hire('Max', 'builder', [shop]);
  await hire('Ben', 'builder', [shop]);
  await hire('Cleo', 'builder', [shop]);
  await hire('Linus', 'reviewer', [shop], 'senior');
  await hire('Tess', 'tester', [blog]);
  // Ben and Cleo were hired ten days ago and never had work: HR suggests firing or reassigning them (Max covers SHOP).
  await q(`UPDATE agents SET hired_at = now() - interval '10 days' WHERE name = ANY($1)`, [['Ben', 'Cleo']]);
  const recs = (await (await api.get('/api/hr/board')).json()).recommendations as Array<{
    id: string;
    kind: string;
  }>;
  expect(
    recs.filter((r) => r.kind === 'fire_idle'),
    JSON.stringify(recs),
  ).toHaveLength(2);

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through ----------------------------------------------------------------------------------------------
  await page.goto('/p/SHOP/board');
  await expect(page.locator('[data-tour="nav-agents"]')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  const form = page.getByRole('form', { name: 'Hire agent' });
  await narrate('c1-a', async () => {
    await click(page, page.locator('[data-tour="nav-agents"]'));
    await expect(page.getByTestId('agent-Max')).toBeVisible();
    await pause(800);
    await click(page, page.getByRole('button', { name: 'Hire agent' }).first());
    await expect(form).toBeVisible();
  });
  await narrate('c1-b', async () => {
    await form.getByLabel('Role', { exact: true }).selectOption({ label: 'Tester' });
    await pause(500);
    await form.getByLabel('Seniority').selectOption('senior');
    await pause(500);
    await form.getByLabel('Runtime').selectOption('mock');
    await pause(500);
    await form.getByLabel('Effort').selectOption('high');
  });
  await narrate('c1-c', async () => {
    await click(page, form.getByLabel('Allow BLOG'));
    await type(page, form.getByLabel('Name', { exact: true }), 'Grace');
    await click(page, form.getByRole('button', { name: 'Hire', exact: true }));
    await expect(page.getByTestId('agent-Grace')).toBeVisible();
    await page.getByTestId('agent-Grace').scrollIntoViewIfNeeded();
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await page.getByTestId('agent-Max').scrollIntoViewIfNeeded();
    await click(page, page.getByRole('button', { name: 'Pause Max' }));
    await expect(page.getByTestId('agent-Max').getByTestId('agent-paused')).toBeVisible();
    await pause(1500);
    await click(page, page.getByRole('button', { name: 'Resume Max' }));
    await expect(page.getByTestId('agent-Max').getByTestId('agent-paused')).toHaveCount(0);
  });
  await narrate('c2-b', async () => {
    await page.getByTestId('agent-Linus').scrollIntoViewIfNeeded();
    await click(page, page.getByRole('button', { name: 'Change model of Linus' }));
    const dlg = page.getByRole('form', { name: 'Change model' });
    await dlg.getByLabel('Effort').selectOption('high');
    await pause(800);
    await click(page, dlg.getByRole('button', { name: 'Change model' }));
    await expect(dlg).toHaveCount(0);
    await expect(page.getByTestId('agent-Linus').getByTestId('agent-model')).toContainText('high');
  });

  await chapter(3);
  const recList = page.getByTestId('recommendations');
  const cleoId = (await q<{ id: string }>(`SELECT id FROM agents WHERE name='Cleo'`))[0]?.id as string;
  const benId = (await q<{ id: string }>(`SELECT id FROM agents WHERE name='Ben'`))[0]?.id as string;
  const cleoRec = recList.locator(`[data-rec-id="fire_idle:${cleoId}"]`);
  const benRec = recList.locator(`[data-rec-id="fire_idle:${benId}"]`);
  await narrate('c3-a', async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await expect(recList).toBeVisible();
    await pause(800);
    await click(page, cleoRec.getByText('Evidence'));
  });
  await narrate('c3-b', async () => {
    await click(page, cleoRec.getByTestId('apply-fire_idle'));
    await expect(cleoRec.getByTestId('rec-applied')).toBeVisible();
  });
  await narrate('c3-c', async () => {
    await expect(benRec).toBeVisible();
    await click(page, benRec.getByTestId('dismiss-fire_idle'));
    const confirm = page.getByRole('dialog').getByRole('button', { name: 'Dismiss', exact: true });
    await pause(800);
    await click(page, confirm);
    await expect(benRec).toHaveCount(0);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await page.getByLabel('Project', { exact: true }).selectOption({ label: 'BLOG Company blog' });
    await expect(page.getByTestId('agent-Max')).toHaveCount(0);
    await expect(page.getByTestId('agent-Tess')).toBeVisible();
  });
  await narrate('outro-1');

  await finish();
});
