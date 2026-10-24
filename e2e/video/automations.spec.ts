import { expect, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { BASE_URL } from '../support/env.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/automations.ts';
import { createProject, demoApi } from './seed.ts';

/**
 * The Automations video (sidebar section 7, nav id `schedules`): the `New automation` wizard (When, What, Details),
 * `Run now`, `History` and Pause. One automation already exists with a short history (a run on schedule and one by hand).
 * Output: media/videos/automations.{webm,mp4,vtt,json}
 *   e2e/video/record.sh automations
 */
const SLUG = 'automations';

test.afterAll(async () => {
  await pool.end();
});

const runsOf = (name: string) =>
  q<{ status: string; trigger: string }>(
    `SELECT r.status, r.trigger FROM schedule_runs r JOIN schedules s ON s.id = r.schedule_id WHERE s.name=$1 ORDER BY r.started_at`,
    [name],
  );

test('record the automations video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const prepared = prepareVideo({ slug: SLUG, title: 'Automations', cues: allCues(), chapters: CHAPTERS });
  const api = await demoApi();
  const { projectId } = await createProject(api, 'SHOP', 'Web shop');
  // an automation that already ran: once on schedule (the test clock moves to the next 07:00) and once by hand
  const EXISTING = 'Daily dependency check';
  const made = await api.post('/api/schedules', {
    data: {
      name: EXISTING,
      trigger: { kind: 'cron', cron: '0 7 * * *', timezone: 'UTC' },
      action: {
        kind: 'create_card',
        projectId,
        template: {
          title: 'Check for outdated dependencies',
          fields: { context: 'Keep the shop safe and up to date.', requirements: 'List outdated packages.' },
        },
      },
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const clock = (advanceMs: number) =>
    fetch(`${BASE_URL}/api/test/clock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ advanceMs }),
    });
  const now = new Date(((await (await clock(0)).json()) as { now: string }).now);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 7, 0, 5);
  expect((await clock(next - now.getTime())).ok).toBe(true);
  await waitFor(
    'the run on schedule',
    () => runsOf(EXISTING),
    (r) => r.length >= 1 && r[0]?.status === 'ok',
    60_000,
  );
  expect((await clock(2 * 3_600_000)).ok).toBe(true);
  const id = (made.ok() ? ((await made.json()) as { id: string }).id : '') as string;
  const run = await api.post(`/api/schedules/${id}/run`, { data: {} });
  expect(run.ok(), await run.text()).toBe(true);
  await waitFor(
    'the run by hand',
    () => runsOf(EXISTING),
    (r) => r.length >= 2 && r[1]?.status === 'ok',
    60_000,
  );

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const nav = page.getByRole('navigation', { name: 'Main' });

  // ---- the walk-through: starts on the Desk, opens Automations from the sidebar -------------------------------------
  await page.goto('/desk');
  await expect(nav.getByRole('link', { name: 'Automations', exact: true })).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  const existing = page.getByTestId(`schedule-${EXISTING}`);
  await narrate('c1-a', async () => {
    await click(page, nav.getByRole('link', { name: 'Automations', exact: true }));
    await expect(existing).toBeVisible();
    const when = existing.getByTestId('schedule-when');
    const box = await when.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 25 });
    await pause(1200);
  });

  await chapter(2);
  const wiz = page.getByTestId('schedule-wizard');
  await narrate('c2-a', async () => {
    await click(page, page.getByTestId('new-schedule'));
    await expect(wiz).toBeVisible();
  });
  await narrate('c2-b', async () => {
    await click(page, wiz.getByTestId('tile-cron'));
    const runs = wiz.getByLabel('Runs');
    await runs.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(700);
    const box = await runs.boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
    await runs.selectOption({ label: 'Weekdays at 07:00' });
    await pause(1500);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, page.getByTestId('wizard-next'));
    await click(page, wiz.getByTestId('tile-create_card'));
    await pause(1200);
    await click(page, page.getByTestId('wizard-next'));
  });
  const NEW = 'Morning bug sweep';
  await narrate('c3-b', async () => {
    await type(page, wiz.getByLabel('Name', { exact: true }).first(), NEW);
    await wiz.getByLabel('Project').selectOption({ label: 'SHOP Web shop' });
    await type(page, wiz.getByLabel('Title'), 'Sweep new bug reports');
  });

  await chapter(4);
  const row = page.getByTestId(`schedule-${NEW}`);
  await narrate('c4-a', async () => {
    await click(page, page.getByTestId('wizard-save'));
    await expect(row).toBeVisible();
    await expect(row.getByTestId('schedule-when')).toContainText('07:00');
    await click(page, row.getByRole('button', { name: /Run now/ }));
    await expect(row.getByTestId('run-result')).toContainText('Emitted SHOP-');
  });
  await narrate('c4-b', async () => {
    await click(page, existing.getByTestId('toggle-history'));
    await expect(existing.getByTestId('run-row').first()).toBeVisible();
    await pause(2500);
  });
  await narrate('c4-c', async () => {
    await click(page, row.getByRole('button', { name: 'Pause', exact: true }));
    await expect(row.getByText('Paused').first()).toBeVisible();
    await pause(1200);
  });
  await narrate('outro-1');

  await finish();
});
