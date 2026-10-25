import { expect, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/discovery.ts';
import { createProject, demoApi, hireAgent, pairWorkstation } from './seed.ts';

/**
 * The Discovery video: a new discovery with a facilitating analyst (mock runtime), the questions, a proposal, the panel,
 * the PRD, the checklist, the approval and the hand-over to the BA.
 * Output: media/videos/discovery.{webm,mp4,vtt,json}
 *   e2e/video/record.sh discovery
 */
const SLUG = 'discovery';

test.afterAll(async () => {
  await pool.end();
});

test('record the discovery video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Discovery: from an idea to a PRD',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const api = await demoApi();
  const ws = await pairWorkstation(api, "Alex's laptop", undefined, {
    AOM_MOCK_STEP_MS: '150',
    AOM_MOCK_CHAT_TOKEN_MS: '15',
  });
  const { projectId } = await createProject(api, 'SHOP', 'Web shop');
  expect((await api.put(`/api/projects/${projectId}/manual-qa`, { data: { enabled: false } })).ok()).toBe(
    true,
  );
  await hireAgent(api, {
    name: 'Ana',
    roleKey: 'analyst',
    seniority: 'senior',
    workstationId: ws,
    projectId,
  });
  await hireAgent(api, { name: 'Ben', roleKey: 'ba', seniority: 'senior', workstationId: ws, projectId });
  await waitFor(
    'the runner announces the session verbs',
    async () =>
      (
        await q<{ capabilities: string[] }>(
          'SELECT capabilities FROM workstation_capabilities WHERE workstation_id=$1',
          [ws],
        )
      )[0]?.capabilities,
    (c) => Array.isArray(c) && c.includes('session-verbs:1'),
    30_000,
  );

  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);
  const answerFirst = async (title: string) => {
    const card = page.getByTestId('question-card').filter({ hasText: title }).last();
    await expect(card).toBeVisible({ timeout: 60_000 });
    await pause(1200);
    await click(page, card.getByTestId('option-o1'));
    await expect(card.getByTestId('question-answer')).toBeVisible({ timeout: 30_000 });
  };

  // ---- the walk-through: starts on the board, opens Discovery from the sidebar ----------------------------------------
  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('board')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  const dialog = page.getByRole('dialog');
  await narrate('c1-a', async () => {
    await click(page, page.getByRole('link', { name: 'Discovery', exact: true }));
    await expect(page.getByText('No discovery sessions yet')).toBeVisible();
    await click(page, page.getByTestId('new-discovery'));
    await type(page, dialog.getByLabel('Title'), 'Invoicing for freelancers');
    await type(
      page,
      dialog.getByLabel('Starting idea (optional)'),
      'Invoices that chase late payers by themselves',
    );
    await dialog.getByLabel('Project (optional)').selectOption({ label: 'SHOP: Web shop' });
    await pause(600);
  });
  await narrate('c1-b', async () => {
    const stance = dialog.getByLabel('How should the analyst work?');
    await stance.selectOption({ label: 'Partner' });
    await pause(1500);
    await stance.selectOption({ label: 'Ideate for me' });
    await pause(1500);
    await stance.selectOption({ label: 'Facilitator' });
    await pause(500);
  });
  await narrate('c1-c', async () => {
    const ceo = dialog.getByLabel('CEO', { exact: true });
    await ceo.scrollIntoViewIfNeeded();
    await ceo.selectOption({ label: 'With the CEO' });
    await pause(1500);
    await ceo.selectOption({ label: 'CEO prepares first' });
    await pause(2000);
    await ceo.selectOption({ label: 'Just me' });
    await pause(500);
  });
  await narrate('c1-d', async () => {
    await dialog.getByLabel('Time limit').scrollIntoViewIfNeeded();
    await dialog.getByLabel('Time limit').selectOption('60');
    await type(page, dialog.getByLabel('Cost limit in USD (optional)'), '25');
    await pause(500);
    await click(page, dialog.getByRole('button', { name: 'Start' }));
    await expect(page).toHaveURL(/\/discovery\/[0-9a-f-]{36}$/);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await expect(page.getByTestId('question-card').first()).toContainText('Who is the primary user?', {
      timeout: 60_000,
    });
    await pause(2500);
    await answerFirst('Who is the primary user?');
  });
  await narrate('c2-b', async () => {
    await answerFirst('What is their biggest pain today?');
    await answerFirst('How will we know it worked?');
    await expect(page.getByTestId('phase-diverge')).toHaveAttribute('aria-current', 'step', {
      timeout: 60_000,
    });
    await answerFirst('Which idea do we keep');
  });
  await narrate('c2-c', async () => {
    const proposal = page.getByTestId('proposal-card').first();
    await expect(proposal).toContainText('Make reminders part of the first version', { timeout: 60_000 });
    await pause(3000);
    await click(page, proposal.getByTestId('proposal-apply'));
    await expect(page.getByTestId('panel-decisions')).toContainText('Payment reminders are in scope', {
      timeout: 30_000,
    });
    await pause(1000);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    // answer whatever the analyst asks until it moves on to Capture (a new question replaces an open one)
    const isOpen = page.getByTestId('question-card').and(page.locator('[data-status="open"]'));
    for (let i = 0; i < 8; i++) {
      if (await page.getByTestId('session-drafts').getByTestId('doc-prd').isVisible()) break;
      const shown = await isOpen
        .last()
        .waitFor({ state: 'visible', timeout: 20_000 })
        .then(
          () => true,
          () => false,
        );
      if (!shown) continue;
      await pause(1500);
      await click(page, isOpen.last().getByTestId('option-o1'));
      await expect(isOpen).toHaveCount(0, { timeout: 30_000 });
      await pause(2500);
    }
    await expect(page.getByTestId('phase-capture')).toHaveAttribute('aria-current', 'step', {
      timeout: 60_000,
    });
    const drafts = page.getByTestId('session-drafts');
    await expect(drafts.getByTestId('doc-prd')).toBeVisible({ timeout: 60_000 });
    await drafts.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    await pause(2200);
    await click(page, drafts.getByTestId('validate-prd'));
    await expect(drafts.getByTestId('prd-validation')).toBeVisible({ timeout: 60_000 });
    await pause(1500);
  });
  await narrate('c3-b', async () => {
    const drafts = page.getByTestId('session-drafts');
    await drafts
      .getByTestId('approve-doc')
      .evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
    await pause(800);
    await click(page, drafts.getByTestId('approve-doc'));
    await expect(drafts.getByTestId('doc-status')).toHaveText('Approved', { timeout: 30_000 });
    await pause(800);
    await click(page, drafts.getByTestId('hand-to-ba'));
    await expect(drafts.getByTestId('doc-status')).toHaveText('Handed to the BA', { timeout: 30_000 });
    await pause(1500);
  });
  await narrate('outro-1', async () => {
    await click(page, page.getByTestId('pause-session'));
    await expect(page.getByTestId('resume-session')).toBeVisible();
  });

  await finish();
});
