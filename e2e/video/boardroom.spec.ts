import { expect, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/boardroom.ts';
import { createProject, demoApi, hireAgent, pairWorkstation } from './seed.ts';

/**
 * The Boardroom video: a new boardroom (topic, format, the fixed seats and the cast), the sealed first round, the Chair's
 * decision point with an @mention, the whiteboard, the minutes and Pull into PRD. The mock runtime plays the personas and
 * the Chair (AOM_MOCK_BOARD_DECIDE makes the mock Chair stop for a decision, so the topic reads naturally).
 * Output: media/videos/boardroom.{webm,mp4,vtt,json}
 *   e2e/video/record.sh boardroom
 */
const SLUG = 'boardroom';

test.afterAll(async () => {
  await pool.end();
});

test('record the boardroom video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Boardroom: a debate with a Chair',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const api = await demoApi();
  const ws = await pairWorkstation(api, "Alex's laptop", undefined, {
    AOM_MOCK_STEP_MS: '7000',
    AOM_MOCK_CHAT_TOKEN_MS: '15',
    AOM_MOCK_BOARD_DECIDE: '1',
  });
  const { projectId } = await createProject(api, 'SHOP', 'Web shop');
  await hireAgent(api, {
    name: 'Ana',
    roleKey: 'analyst',
    seniority: 'senior',
    workstationId: ws,
    projectId,
  });
  await waitFor(
    'the runner announces the board verbs',
    async () =>
      (
        await q<{ capabilities: string[] }>(
          'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
          [ws],
        )
      )[0]?.capabilities,
    (c) => Array.isArray(c) && c.includes('board-verbs:1'),
    30_000,
  );

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const dialog = page.getByRole('dialog');

  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('board')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByRole('link', { name: 'Boardroom', exact: true }));
    await expect(page.getByText('No boardrooms yet')).toBeVisible();
    await click(page, page.getByTestId('new-boardroom'));
    await type(page, dialog.getByLabel('Topic'), 'Should we launch a pilot with our first customer?');
    await type(page, dialog.getByLabel('Brief (optional)'), 'We have one friendly customer and eight weeks.');
    await dialog.getByLabel('Format').selectOption('pre_mortem');
    await pause(800);
  });
  await narrate('c1-b', async () => {
    await dialog.getByTestId('fixed-seat-optimist').scrollIntoViewIfNeeded();
    await pause(2500);
    await click(page, dialog.getByRole('checkbox', { name: 'User Advocate' }));
    await click(page, dialog.getByRole('checkbox', { name: 'Cost Hawk' }));
    await dialog.getByLabel('Name', { exact: true }).scrollIntoViewIfNeeded();
    await type(page, dialog.getByLabel('Name', { exact: true }), 'Regulator');
    await type(
      page,
      dialog.getByLabel('Brief', { exact: true }),
      'A cautious compliance officer who asks what could get us fined',
    );
    await click(page, dialog.getByTestId('add-adhoc'));
    await expect(dialog.getByRole('list', { name: 'Chosen cast' })).toContainText('Regulator');
    await dialog.getByRole('list', { name: 'Chosen cast' }).scrollIntoViewIfNeeded();
    await pause(1500);
  });
  await narrate('c1-c', async () => {
    await dialog.getByTestId('suggest-cast').scrollIntoViewIfNeeded();
    await pause(2500);
    await dialog.getByLabel('Round cap').scrollIntoViewIfNeeded();
    await type(page, dialog.getByLabel('Round cap'), '6');
    await type(page, dialog.getByLabel('Cost limit in USD (optional)'), '25');
    await dialog.getByLabel('Time limit').selectOption('60');
    for (const l of ['Personas run on', 'The Chair runs on', 'Minutes are written by'])
      await dialog.getByLabel(l).selectOption({ label: 'Mock: Mock' });
    await pause(1200);
    await click(page, dialog.getByTestId('start-boardroom'));
    await expect(page).toHaveURL(/\/boardroom\/[0-9a-f-]{36}$/);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await expect(page.getByTestId('sealed-round')).toBeVisible({ timeout: 60_000 });
    await pause(3000);
  });
  await narrate('c2-b', async () => {
    await expect(page.getByTestId('board-turn')).toHaveCount(5, { timeout: 120_000 });
    await pause(1500);
    await expect(page.getByTestId('column-risks')).toContainText('Adoption is assumed', { timeout: 30_000 });
    await page
      .getByTestId('whiteboard')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(2500);
  });

  await chapter(3);
  const card = page.getByTestId('decision-card').first();
  await narrate('c3-a', async () => {
    await expect(card).toContainText('The Chair needs your decision', { timeout: 120_000 });
    await card.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(1500);
    const box = page.getByPlaceholder(/Decide above/);
    await type(page, box, 'What does this cost us? @cost-h');
    await click(page, page.getByTestId('mention-cost-hawk'));
    await click(page, page.getByRole('button', { name: /send/i }));
    await pause(800);
    await click(page, card.getByTestId('decision-option-o2'));
    await type(page, card.getByLabel('Your decision'), 'with ten paying users');
    await click(page, card.getByTestId('decide'));
    await expect(page.getByTestId('decision-card').first()).toContainText('You decided', { timeout: 30_000 });
  });
  await narrate('c3-b', async () => {
    const board = page.getByTestId('whiteboard');
    await board.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(800);
    await type(page, board.getByLabel('New ideas note'), 'Pilot with one friendly partner');
    await click(page, board.getByRole('button', { name: 'Add to Ideas' }));
    const mine = page
      .getByTestId('column-ideas')
      .getByTestId('board-note')
      .filter({ hasText: 'Pilot with one friendly partner' });
    await expect(mine).toBeVisible();
    await click(page, mine.getByTestId('vote-note'));
    await expect(mine.getByTestId('vote-note')).toHaveAttribute('aria-pressed', 'true');
    await mine.getByLabel('Move to').selectOption('decisions');
    await expect(page.getByTestId('column-decisions')).toContainText('Pilot with one friendly partner');
    await pause(1500);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await pause(800);
    await click(page, page.getByTestId('end-session'));
    await click(page, page.getByRole('dialog').getByRole('button', { name: 'End session' }));
    await expect(page.getByText('This session is over')).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('minutes-body')).toContainText('Unresolved disagreements', {
      timeout: 60_000,
    });
    await page
      .getByTestId('minutes-panel')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(2200);
    await page.evaluate(() => window.scrollBy({ top: 420, behavior: 'smooth' }));
    await pause(2500);
  });
  await narrate('c4-b', async () => {
    await click(page, page.getByTestId('pull-into-prd'));
    await expect(page).toHaveURL(/\/discovery\/[0-9a-f-]{36}$/, { timeout: 30_000 });
    await expect(page.getByText('I read the boardroom minutes')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('panel-decisions')).toContainText('Prove demand first', {
      timeout: 30_000,
    });
    await page
      .getByTestId('panel-decisions')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(3000);
  });
  await narrate('outro-1', async () => {
    await click(page, page.getByRole('link', { name: 'Boardroom', exact: true }));
    await expect(page.getByTestId('boardroom-row').first()).toContainText('Over');
  });

  await finish();
});
