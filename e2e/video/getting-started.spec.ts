import { expect, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { paths } from '../support/env.ts';
import { caption, click, sleep, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, BA_ANSWER, BA_QUESTION, CHAPTERS } from './narration/getting-started.ts';
import { demoApi, pairWorkstation } from './seed.ts';

/**
 * The "Getting started" help video: a spoken tutorial. A female voice (Piper, offline) tells you how to create your
 * first project, hire agents, create cards, talk to the BA and test your running project, while the real UI does it. A
 * fresh local stack, the mock agent runtime (no real Claude, GitHub or Jira is ever contacted), a step banner and a
 * visible pointer. The harness (harness.ts) speaks, films, mixes and writes the files.
 *
 *   e2e/video/setup-voice.sh            once: Piper, the voice and a static ffmpeg into ~/.cache/aom-video
 *   pnpm build && e2e/video/record.sh getting-started
 *
 * Output: apps/web/public/videos/getting-started.{webm,mp4,vtt,json}
 */
const SLUG = 'getting-started';

test.afterAll(async () => {
  await pool.end();
});

test('record the getting-started video', async ({ browser }) => {
  // ---- before the camera rolls: the voice, the scripted BA answer and a workstation ---------------------------------
  const prepared = prepareVideo(
    {
      slug: SLUG,
      title: 'Getting started with Guildwise HQ',
      cues: allCues(),
      chapters: CHAPTERS,
    },
    { [BA_QUESTION]: BA_ANSWER },
  );
  const api = await demoApi();
  await pairWorkstation(api);
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- intro ----------------------------------------------------------------------------------------------------
  await page.goto('/');
  await expect(page.getByTestId('palette-button')).toBeVisible();
  await narrate('intro-1');
  await narrate('intro-2');

  // ---- 1. your first project ------------------------------------------------------------------------------------
  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByRole('link', { name: 'Projects' }).first());
    await click(page, page.getByRole('button', { name: /new project/i }).first());
  });
  const dlg = page.getByRole('dialog');
  await narrate('c1-b', async () => {
    await type(page, dlg.getByLabel('Key'), 'SHOP');
    await type(page, dlg.getByLabel('Name'), 'Web shop');
    await pause(600);
    await click(page, dlg.getByRole('button', { name: /create/i }));
    await expect(page.getByText('SHOP').first()).toBeVisible();
  });
  await narrate('c1-c', async () => {
    await click(page, page.getByRole('link', { name: 'Settings for SHOP' }));
    const add = page.getByRole('form', { name: 'Add repository' });
    await type(page, add.getByLabel('Repository name'), 'shop');
    await click(page, add.getByLabel('Remote URL'), 100);
    await add.getByLabel('Remote URL').fill(paths.origin);
    await pause(800);
    await click(page, add.getByRole('button', { name: /add/i }));
    await expect(page.getByTestId('repos')).toContainText('shop');
  });

  // ---- 2. hire agents -------------------------------------------------------------------------------------------
  await chapter(2);
  const hire = async (role: string, name: string, seniority?: string) => {
    await click(page, page.getByRole('button', { name: 'Hire agent' }).first());
    const form = page.getByRole('form', { name: 'Hire agent' });
    await form.getByLabel('Role', { exact: true }).selectOption({ label: role });
    if (seniority) await form.getByLabel('Seniority').selectOption(seniority);
    await form.getByLabel('Runtime').selectOption('mock');
    await type(page, form.getByLabel('Name', { exact: true }), name);
    await click(page, form.getByRole('button', { name: 'Hire', exact: true }));
    await expect(page.getByTestId(`agent-${name}`)).toBeVisible();
    await pause(600);
  };
  await narrate('c2-a', async () => {
    await click(page, page.getByRole('link', { name: 'Agents' }).first());
  });
  await narrate('c2-b', () => hire('Business analyst', 'Bea'));
  await narrate('c2-c', async () => {
    await hire('Builder', 'Ada');
    await hire('Reviewer', 'Linus', 'senior');
    await hire('Tester', 'Tess');
  });
  await narrate('c2-d');

  // ---- 3. cards ---------------------------------------------------------------------------------------------------
  await chapter(3);
  const form = page.getByRole('form', { name: 'New card' });
  await narrate('c3-a', async () => {
    await page.goto('/cards/new');
    await expect(form).toBeVisible();
  });
  await narrate('c3-b', async () => {
    await type(page, form.getByLabel('Title', { exact: true }), 'Show a welcome banner');
    await form.getByLabel('Repository').selectOption({ label: 'shop' });
    await form.getByLabel('Context', { exact: true }).fill('Visitors do not know what the shop sells.');
    await form.getByLabel('Requirements').fill('Show a welcome banner on the home page.');
    await form.getByLabel('Acceptance criteria').fill('The banner is visible\nIt can be closed');
    await form.getByLabel('Affected areas').fill('index.js');
    await form.getByLabel('Constraints').fill('None');
    await form.getByLabel('Test plan').fill('Open the home page and close the banner');
  });
  await narrate('c3-c', async () => {
    await click(page, form.getByRole('button', { name: 'Specify', exact: true }));
    await expect(page).toHaveURL(/\/cards\/[^/]+$/);
  });
  await narrate('c3-d', async () => {
    // a second card, quickly, through the API: the video is about the first
    const projects = (await (await api.get('/api/projects')).json()).projects as Array<{
      id: string;
      key: string;
    }>;
    const projectId = projects.find((p) => p.key === 'SHOP')?.id as string;
    const repoId = (await (await api.get(`/api/projects/${projectId}`)).json()).repos[0].id as string;
    await api.post('/api/cards', {
      data: {
        projectId,
        title: 'Add a contact page',
        cardType: 'feature',
        repoId,
        completionAction: 'push_branch',
        fields: {
          context: 'Customers cannot reach us.',
          requirements: 'Add a contact page.',
          acceptanceCriteria: ['The page exists', 'It lists an email address'],
          affectedAreas: 'index.js',
          constraints: 'None',
          testPlan: 'Open the page',
        },
        specify: true,
      },
    });
    await page.goto('/p/SHOP/board');
    await expect(page.getByTestId('board')).toBeVisible();
  });

  // ---- 4. talk to the BA ------------------------------------------------------------------------------------------
  await chapter(4);
  const drawer = page.getByRole('dialog', { name: 'Chat' });
  await narrate('c4-a', async () => {
    await click(page, page.getByRole('button', { name: 'Chat with an agent' }));
    const bea = drawer.getByLabel('Agent').locator('option', { hasText: 'Bea' });
    await drawer.getByLabel('Agent').selectOption(await bea.getAttribute('value'));
    await click(page, drawer.getByRole('button', { name: 'Start chat' }));
  });
  await narrate('c4-b', async () => {
    await type(page, drawer.getByLabel('Message'), BA_QUESTION);
    await click(page, drawer.getByRole('button', { name: 'Send' }));
  });
  await narrate('c4-c', async () => {
    await expect(drawer.getByTestId('chat-message').last()).toContainText('search box', { timeout: 60_000 });
  });
  await page.keyboard.press('Escape');

  // ---- 5. test the running project -------------------------------------------------------------------------------
  await chapter(5);
  await narrate('c5-a', async () => {
    await waitFor(
      'a card reaches review or later',
      () => q<{ stage: string }>(`SELECT stage FROM cards WHERE ref='SHOP-1'`),
      (r) => !!r[0] && r[0].stage !== 'spec' && r[0].stage !== 'build',
      240_000,
    );
  });
  await narrate('c5-b', async () => {
    await click(page, page.getByTestId('card-tile-SHOP-1'));
    await expect(page).toHaveURL(/\/cards\/[^/]+$/);
  });
  await narrate('c5-c', async () => {
    await sleep(2500);
    await page.mouse.wheel(0, 500);
  });
  await caption(page, 'Hire, describe, watch. More guides are in Help.', undefined);
  await narrate('outro-1');

  // ---- finish: mix the voice into the recording, write the captions and the chapter list ----------------------------
  await finish();
});
