import { copyFileSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { pool, q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, E2E_DIR, paths, ROOT } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';
import { caption, click, installOverlays, sleep, type } from './captions.ts';
import { allCues, BA_ANSWER, BA_QUESTION, CHAPTERS } from './narration.ts';
import { mux, speak, VOICE, vtt } from './voice.ts';

/**
 * The "Getting started" help video: a spoken tutorial. A female voice (Piper, offline) tells you how to create your
 * first project, hire agents, create cards, talk to the BA and test your running project, while the real UI does it. A
 * fresh local stack, the mock agent runtime (no real Claude, GitHub or Jira is ever contacted), a step banner and a
 * visible pointer, recorded with Playwright's `recordVideo`. Every narrated passage waits for its audio to finish, then
 * the audio is mixed into the recording (VP9 + Opus WebM) and the captions are written as WebVTT.
 *
 *   e2e/video/setup-voice.sh            once: Piper, the voice and a static ffmpeg into ~/.cache/aom-video
 *   pnpm build && pnpm --filter @aom/e2e video
 *
 * Output (served by the app as static files, read by the Help page):
 *   apps/web/public/videos/getting-started.webm   the video with the voice-over
 *   apps/web/public/videos/getting-started.vtt    the captions (the same words as the narration)
 *   apps/web/public/videos/getting-started.json   its length and chapters (seconds), matching the five steps
 */
const OUT_DIR = join(ROOT, 'apps/web/public/videos');
const RAW_DIR = join(E2E_DIR, 'video-raw');
const HOME = paths.runnerHome('video');
const PACE = Number(process.env.AOM_VIDEO_PACE ?? 1); // pauses between actions; 0.5 is twice as fast (the voice sets the pace)
const pause = (ms: number) => sleep(ms * PACE);
const GAP = 0.7; // seconds of quiet after every passage

test.afterAll(async () => {
  await pool.end();
});

test('record the getting-started video', async ({ browser }) => {
  // ---- before the camera rolls: the voice, the scripted BA answer and a workstation ---------------------------------
  const spoken = new Map(speak(allCues()).map((s) => [s.id, s]));
  mkdirSync(E2E_DIR, { recursive: true });
  const repliesFile = join(E2E_DIR, 'video-replies.json');
  writeFileSync(repliesFile, JSON.stringify({ [BA_QUESTION]: BA_ANSWER }));
  process.env.AOM_MOCK_REPLIES_FILE = repliesFile; // read by the runner (recording only)

  const api = await apiAs(ADMIN.email, ADMIN.password);
  const code = (await (await api.post('/api/workstations/pairing-codes', { data: {} })).json())
    .code as string;
  pairRunner(BASE_URL, code, 'My laptop', HOME);
  addRepoRoot(paths.repoRoot, HOME);
  startRunner({}, HOME);
  await waitFor(
    'runner connected',
    async () => (await (await api.get('/api/workstations')).json()).workstations as any[],
    (w) => w[0]?.connected === true,
    30_000,
  );

  rmSync(RAW_DIR, { recursive: true, force: true });
  const ctx = await browser.newContext({
    storageState: await api.storageState(),
    viewport: { width: 1280, height: 720 },
    recordVideo: { dir: RAW_DIR, size: { width: 1280, height: 720 } },
  });
  await installOverlays(ctx);
  const t0 = Date.now();
  const page = await ctx.newPage();
  const now = () => (Date.now() - t0) / 1000;
  const chapters: Array<{ t: number; title: string }> = [];
  const timeline: Array<{ id: string; text: string; start: number; end: number; file: string }> = [];
  const textOf = new Map(allCues().map((c) => [c.id, c.text]));

  /** Speaks the passage while `actions` run on screen; then waits until the voice has finished (and a breath more). */
  const narrate = async (id: string, actions?: () => Promise<void>) => {
    const s = spoken.get(id);
    if (!s) throw new Error(`no audio for ${id}`);
    const start = now();
    const end = start + s.duration;
    timeline.push({ id, text: textOf.get(id) ?? '', start, end, file: s.file });
    if (actions) await actions();
    const rest = end + GAP - now();
    if (rest > 0) await sleep(rest * 1000);
  };
  const chapter = async (n: number) => {
    const c = CHAPTERS[n - 1] as (typeof CHAPTERS)[number];
    chapters.push({ t: Math.max(0, Math.round(now() * 10) / 10), title: c.title });
    await caption(page, c.banner, n);
  };

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
    await add.getByLabel('Branch (optional)').fill('main');
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
    await form.getByLabel('Completion action').selectOption('push_branch');
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
  const duration = Math.round(now() * 10) / 10;
  const video = page.video();
  await ctx.close();
  const raw = await video?.path();
  expect(raw).toBeTruthy();
  mkdirSync(OUT_DIR, { recursive: true });
  const dest = join(OUT_DIR, 'getting-started.webm');
  try {
    mux(
      raw as string,
      timeline.map((c) => ({ file: c.file, start: c.start })),
      dest,
    );
  } catch (e) {
    copyFileSync(raw as string, dest);
    throw new Error(`the narration could not be mixed in (is ffmpeg set up? see setup-voice.sh): ${e}`);
  }
  const bytes = statSync(dest).size;
  expect(bytes, 'the video must stay under 20 MB').toBeLessThan(20 * 1024 * 1024);
  writeFileSync(join(OUT_DIR, 'getting-started.vtt'), vtt(timeline));
  writeFileSync(
    join(OUT_DIR, 'getting-started.json'),
    `${JSON.stringify(
      {
        title: 'Getting started with Guildwise HQ',
        src: '/videos/getting-started.webm',
        type: 'video/webm',
        captions: '/videos/getting-started.vtt',
        voice: `Piper ${VOICE}`,
        duration,
        chapters,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`video: ${dest} ${(bytes / 1024 / 1024).toFixed(1)} MB, ${duration}s`);
});
