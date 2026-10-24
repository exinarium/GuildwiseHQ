import { expect, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { makeVault } from '../support/vault.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/interests.ts';
import { demoApi, hireAgent, pairWorkstation } from './seed.ts';

/**
 * The Interests video (sidebar section 18): New interest with its run and delivery schedules, taste rules, the daily
 * quiet cap, Deliver now, archive and restore.
 * Output: media/videos/interests.{webm,mp4,vtt,json}
 *   e2e/video/record.sh interests
 */
const SLUG = 'interests';

test.afterAll(async () => {
  await pool.end();
});

const story = (site: string, n: number, title: string, kind = 'article') => ({
  kind,
  url: `https://${site}.example.com/story-${n}`,
  title,
  source: `${site[0]?.toUpperCase()}${site.slice(1)} Example`,
  publishedAt: '2026-10-20',
  summary: `${title}: a short summary written from the page.`,
});

test('record the interests video', async ({ browser }) => {
  // ---- seed (demo data only): Acme and its Owner Alex Morgan exist already -----------------------------------------
  const api = await demoApi();
  // the organization vault first (a throwaway bare repository), so the workstation clones it when it pairs
  const vault = makeVault('video-interests', { 'README.md': '# Acme notes\n' });
  const v = await api.post('/api/vaults', {
    data: { kind: 'org', remoteUrl: vault.origin, syncIntervalSec: 5 },
  });
  expect(v.status(), await v.text()).toBe(201);
  const workstationId = await pairWorkstation(api, "Alex's laptop", undefined, { AOM_MOCK_STEP_MS: '400' });
  await waitFor(
    'the runner cloned the vault',
    () => q<{ local_path: string | null }>('SELECT local_path FROM workstation_vaults'),
    (r) => r.some((x) => !!x.local_path),
    60_000,
  );
  await hireAgent(api, { name: 'Sky', roleKey: 'scout', workstationId });
  await hireAgent(api, { name: 'Cora', roleKey: 'curator', workstationId });

  const createInterest = async (body: Record<string, unknown>) => {
    const r = await api.post('/api/interests', { data: body });
    expect(r.status(), await r.text()).toBe(201);
    return (await r.json()).id as string;
  };
  const runAndWait = async (id: string, items: unknown[]) => {
    const r = await api.post(`/api/interests/${id}/run`, { data: { mock: { mockFeed: { items } } } });
    expect(r.status(), await r.text()).toBe(201);
    const { ref } = (await r.json()) as { ref: string };
    await waitFor(
      `${ref} done`,
      () => q<{ status: string }>('SELECT status FROM cards WHERE ref=$1', [ref]),
      (rows) => rows[0]?.status === 'done',
      180_000,
    );
  };

  // one interest that delivers as soon as a run finishes: its digest is on the desk already
  const coffee = await createInterest({
    name: 'Coffee market news',
    description: 'Prices, harvests and new roasters. Skip recipes and gear reviews.',
    kinds: ['article', 'video'],
    scan: { cron: '0 7 * * *', timezone: 'Europe/London', maxItems: 5 },
    delivery: { mode: 'immediate' },
    tasteRules: ['Prefer reports with numbers'],
  });
  await runAndWait(coffee, [
    story('beans', 1, 'Arabica prices climb after a short harvest'),
    story('beans', 2, 'Three new roasters open in the city centre'),
    story('beans', 3, 'How a cooperative doubled its export volume', 'video'),
  ]);

  // one interest that delivers once a day: what it found waits for the delivery time
  const perf = await createInterest({
    name: 'Web performance',
    description: 'Page speed, Core Web Vitals and image formats, for an online shop.',
    kinds: ['article'],
    scan: { cron: '0 7 * * 1-5', timezone: 'Europe/London', maxItems: 5 },
    delivery: { mode: 'scheduled', cron: '0 18 * * *', timezone: 'Europe/London' },
    tasteRules: ['Skip vendor press releases'],
  });
  await runAndWait(perf, [
    story('speed', 1, 'Smaller product images without losing quality'),
    story('speed', 2, 'What slows down a checkout page'),
    story('speed', 3, 'Measuring Core Web Vitals on real phones'),
  ]);
  await waitFor(
    'three items wait for delivery',
    async () => (await (await api.get(`/api/interests/${perf}`)).json()).interest.stats.items.held as number,
    (n) => n === 3,
    30_000,
  );
  const cap = await api.put('/api/reporting', { data: { interestDigestCap: 20 } });
  expect(cap.ok(), await cap.text()).toBeTruthy();

  // ---- voice and camera ----------------------------------------------------------------------------------------------
  const prepared = prepareVideo({ slug: SLUG, title: 'Interests', cues: allCues(), chapters: CHAPTERS });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  await page.goto('/desk');
  await expect(page.getByTestId('nav-interests')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-interests'));
    await expect(page.getByTestId('interest-Web performance')).toBeVisible();
    await expect(page.getByTestId('interest-Web performance')).toContainText('3 waiting for delivery');
    await pause(800);
    await page.getByTestId('interest-Coffee market news').getByTestId('interest-ratings').hover();
  });

  await chapter(2);
  const dialog = page.getByTestId('interest-new-dialog');
  await narrate('c2-a', async () => {
    await click(page, page.getByTestId('interest-new'));
    await expect(dialog).toBeVisible();
    await type(page, dialog.getByTestId('interest-name'), 'Electric bikes');
    await type(page, dialog.getByTestId('interest-description'), 'New models and city rules. No sales.', 200);
  });
  await narrate('c2-b', async () => {
    await click(page, dialog.getByTestId('interest-preset'), 200);
    await dialog.getByTestId('interest-preset').selectOption({ label: 'Mondays at 07:00' });
    await pause(1200);
    await click(page, dialog.getByTestId('interest-delivery-mode'), 200);
    await dialog.getByTestId('interest-delivery-mode').selectOption({ label: 'As one digest at set times' });
    await dialog.getByTestId('interest-delivery-preset').selectOption({ label: 'Mondays at 07:00' });
    await pause(1000);
  });
  await narrate('c2-c', async () => {
    await type(page, dialog.getByTestId('taste-rule-input'), 'Skip sponsored reviews', 150);
    await click(page, dialog.getByTestId('taste-rule-add'), 300);
    await click(page, page.getByTestId('interest-save'));
    await expect(page.getByTestId('interest-detail')).toBeVisible();
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, page.getByTestId('interest-tab-taste'));
    await expect(page.getByTestId('taste-tab')).toBeVisible();
    await expect(page.getByLabel('Rule 1', { exact: true })).toHaveValue('Skip sponsored reviews');
    await pause(800);
  });
  await narrate('c3-b', async () => {
    await click(page, page.getByTestId('nav-interests'));
    const capPanel = page.getByTestId('quiet-cap');
    await capPanel.scrollIntoViewIfNeeded();
    await click(page, page.getByTestId('quiet-cap-edit'));
    await page.getByTestId('quiet-cap-input').fill('');
    await type(page, page.getByTestId('quiet-cap-input'), '15', 200);
    await click(page, page.getByTestId('quiet-cap-save'));
    await expect(page.getByTestId('quiet-cap-line')).toContainText('At most 15');
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await page.evaluate('window.scrollTo(0, 0)');
    await click(page, page.getByTestId('interest-Web performance').getByTestId('interest-edit'));
    await expect(page.getByTestId('interest-detail')).toBeVisible();
    // the button reads "Deliver 3 now" while the voice explains it; the click comes at the end of the passage
    await page.getByTestId('interest-deliver').hover();
    await pause(4500);
    await click(page, page.getByTestId('interest-deliver'));
    await expect(page.getByTestId('interest-deliver')).toHaveCount(0);
  });
  await narrate('c4-b', async () => {
    await click(page, page.getByTestId('interest-tab-digest'));
    await expect(page.getByTestId('digest-items').getByRole('listitem')).toHaveCount(3);
    await pause(800);
  });

  await chapter(5);
  await narrate('c5-a', async () => {
    await click(page, page.getByTestId('nav-interests'));
    await click(page, page.getByTestId('interest-Electric bikes').getByTestId('interest-edit'));
    await expect(page.getByTestId('interest-detail')).toBeVisible();
    await click(page, page.getByRole('button', { name: 'More actions' }));
    await click(page, page.getByRole('menuitem', { name: /Archive/ }));
    await click(page, page.getByRole('dialog').getByRole('button', { name: 'Archive', exact: true }));
    await expect(page.getByText('Archived', { exact: true }).first()).toBeVisible();
  });
  await narrate('c5-b', async () => {
    await click(page, page.getByTestId('nav-interests'));
    await expect(page.getByTestId('interest-Electric bikes')).toHaveCount(0);
    await click(page, page.getByTestId('interests-archived'));
    await click(page, page.getByTestId('interest-Electric bikes').getByTestId('interest-edit'));
    await click(page, page.getByRole('button', { name: 'More actions' }));
    await click(page, page.getByRole('menuitem', { name: 'Restore' }));
    await expect(page.getByTestId('interest-run')).toBeVisible();
  });
  await narrate('outro-1', async () => {
    await click(page, page.getByTestId('nav-interests'));
    await expect(page.getByTestId('interest-Electric bikes')).toBeVisible();
  });

  await finish();
});
