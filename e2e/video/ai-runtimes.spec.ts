import { expect, test } from '@playwright/test';
import { pool, q } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/ai-runtimes.ts';
import { createProject, demoApi, pairWorkstation } from './seed.ts';

/**
 * The AI runtimes video: Integrations > AI runtime (the tiles, a named key account, Make main, account sharing) and
 * Settings > Model providers (an organization key and its monthly cap). The mock runner has no Codex or Gemini CLI, so the
 * facts a runner with those programs would report are written into the workstation's runtime report (demo accounts
 * only); the key flows are real, with an obviously fake key that no provider would accept.
 * Output: media/videos/ai-runtimes.{webm,mp4,vtt,json}
 *   e2e/video/record.sh ai-runtimes
 */
const SLUG = 'ai-runtimes';
const FAKE_KEY = 'sk-ant-demo-0000000000000000000000';

test.afterAll(async () => {
  await pool.end();
});

test('record the ai-runtimes video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'AI runtimes and model providers',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const api = await demoApi();
  await createProject(api, 'SHOP', 'Web shop');
  const ws = await pairWorkstation(api, "Alex's laptop");
  // Codex as a runner with the program would report it: installed, one main login. The Gemini CLI and opencode are not installed.
  const injectCodex = async () => {
    const [w] = await q<{ runtimes: Array<Record<string, unknown>> }>(
      'SELECT runtimes FROM workstations WHERE id=$1',
      [ws],
    );
    const rest = (w?.runtimes ?? []).filter((r) => r.id !== 'codex');
    rest.push({
      id: 'codex',
      version: '0.46.0',
      available: true,
      capabilities: [],
      accounts: [{ key: 'main', main: true, login: 'ok', usage: 'ok', email: 'alex.morgan@example.com' }],
    });
    await q('UPDATE workstations SET runtimes=$2::jsonb WHERE id=$1', [ws, JSON.stringify(rest)]);
  };
  await injectCodex();

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const dialog = page.getByRole('dialog');
  const scrollTo = async (testId: string, block: 'start' | 'center' = 'start') => {
    await page
      .getByTestId(testId)
      .evaluate(
        (el, b) => el.scrollIntoView({ behavior: 'smooth', block: b as ScrollLogicalPosition }),
        block,
      );
    await pause(900);
  };

  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('board')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-integrations'));
    const choose = page.getByTestId(`choose-${ws}`);
    if (await choose.isVisible().catch(() => false)) await click(page, choose);
    await expect(page.getByRole('heading', { name: "Integrations on Alex's laptop" })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('ai-section')).toBeVisible({ timeout: 30_000 });
    await scrollTo('ai-section');
    await pause(1500);
  });
  await narrate('c1-b', async () => {
    await expect(page.getByTestId('ai-tile-codex')).toBeVisible();
    await scrollTo('ai-tile-codex');
    await pause(2500);
    await scrollTo('ai-tile-gemini');
    await pause(3000);
  });
  await narrate('c1-c', async () => {
    await scrollTo('ai-tile-codex');
    await expect(page.getByTestId('ai-signin-codex-main')).toBeVisible();
    await page.getByTestId('ai-signin-codex-main').hover();
    await pause(3500);
  });

  await chapter(2);
  const tile = page.getByTestId('ai-tile-anthropic');
  await narrate('c2-a', async () => {
    await scrollTo('ai-tile-anthropic');
    await click(page, tile.getByTestId('ai-setkey-anthropic-main'));
    await type(page, dialog.getByTestId('ai-key-key-anthropic'), FAKE_KEY);
    await pause(1000);
    await click(page, dialog.getByTestId('ai-key-save'));
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(tile.getByTestId('ai-status-anthropic-main'))
      .toContainText(/key set|ok|ready/i, { timeout: 30_000 })
      .catch(() => undefined);
    await pause(1500);
  });
  await narrate('c2-b', async () => {
    await click(page, tile.getByTestId('ai-add-anthropic'));
    await type(page, dialog.getByTestId('ai-key-name'), 'work');
    await type(page, dialog.getByTestId('ai-key-key-anthropic'), FAKE_KEY);
    await pause(800);
    await click(page, dialog.getByTestId('ai-key-save'));
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(tile.getByTestId('ai-account-anthropic-work')).toBeVisible({ timeout: 30_000 });
    await pause(1200);
  });
  await narrate('c2-c', async () => {
    await click(page, tile.getByTestId('ai-promote-anthropic-work'));
    await pause(3000);
    await click(
      page,
      page
        .getByRole('dialog')
        .getByRole('button', { name: 'Make main' })
        .or(page.getByRole('alertdialog').getByRole('button', { name: /Make/ }))
        .first(),
    );
    await pause(1500);
  });
  await narrate('c2-d', async () => {
    await scrollTo('ai-share-accounts', 'center');
    await click(page, page.getByTestId('ai-share-accounts').getByRole('checkbox'));
    await expect(page.getByTestId('ai-share-accounts').getByRole('checkbox')).toBeChecked({
      timeout: 15_000,
    });
    await pause(1500);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, page.getByTestId('ai-models-link'));
    await expect(page.getByTestId('org-providers')).toBeVisible();
    const p = page.getByTestId('org-provider-anthropic');
    await p.scrollIntoViewIfNeeded();
    await click(page, page.getByTestId('org-provider-set-anthropic'));
    await type(page, dialog.getByTestId('org-set-key-anthropic'), FAKE_KEY);
    await pause(1200);
    await click(page, dialog.getByTestId('org-set-send'));
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  });
  await narrate('c3-b', async () => {
    const cap = page.getByTestId('org-provider-cap-input-anthropic');
    await cap.scrollIntoViewIfNeeded();
    await type(page, cap, '200');
    await click(page, page.getByTestId('org-provider-cap-save-anthropic'));
    await pause(2500);
  });
  await narrate('c3-c', async () => {
    await page
      .getByTestId('org-provider-anthropic')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(3500);
  });
  await narrate('outro-1', async () => {
    await pause(800);
  });

  await finish();
});
