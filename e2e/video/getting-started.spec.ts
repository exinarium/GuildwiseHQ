import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { apiAs } from '../support/api.ts';
import { pool, q, waitFor } from '../support/db.ts';
import { ADMIN, BASE_URL, E2E_DIR, paths, ROOT } from '../support/env.ts';
import { addRepoRoot, pairRunner, startRunner } from '../support/runner.ts';
import { caption, click, installOverlays, sleep, type } from './captions.ts';

/**
 * The "Getting started" help video: creating your first project, hiring agents, creating cards, talking to the BA and
 * testing your running project. A fresh local stack, the real UI, the mock agent runtime (no real Claude, GitHub or Jira
 * is ever contacted), a caption overlay and a visible pointer, recorded with Playwright's `recordVideo`.
 *
 *   pnpm build && pnpm --filter @aom/e2e video
 *
 * Output (served by the app as static files, read by the Help page):
 *   apps/web/public/videos/getting-started.webm   the video (re-encoded small when ffmpeg is available)
 *   apps/web/public/videos/getting-started.json   its length and chapters (seconds), matching the five steps
 */
const OUT_DIR = join(ROOT, 'apps/web/public/videos');
const RAW_DIR = join(E2E_DIR, 'video-raw');
const HOME = paths.runnerHome('video');
const PACE = Number(process.env.AOM_VIDEO_PACE ?? 1); // 1 = human pace; 0.5 is twice as fast (for trying the script)
const pause = (ms: number) => sleep(ms * PACE);

test.afterAll(async () => {
  await pool.end();
});

/** A smaller WebM with the ffmpeg of the machine, or the one Playwright ships (VP8 only, which is all we need). */
function shrink(src: string, dest: string): boolean {
  const candidates = ['ffmpeg'];
  const pw = join(process.env.HOME ?? '', '.cache/ms-playwright');
  if (existsSync(pw))
    for (const d of readdirSync(pw).filter((n) => n.startsWith('ffmpeg-')))
      candidates.push(join(pw, d, 'ffmpeg-linux'));
  for (const bin of candidates) {
    try {
      execFileSync(
        bin,
        ['-y', '-i', src, '-c:v', 'libvpx', '-b:v', '0', '-crf', '34', '-an', '-r', '25', dest],
        { stdio: 'ignore' },
      );
      return true;
    } catch {
      /* try the next */
    }
  }
  return false;
}

test('record the getting-started video', async ({ browser }) => {
  // ---- before the camera rolls: a workstation (it is the subject of its own help article) -------------------
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
  const chapters: Array<{ t: number; title: string }> = [];
  const chapter = async (title: string, text: string) => {
    chapters.push({ t: Math.max(0, Math.round((Date.now() - t0) / 100) / 10), title });
    await caption(page, text, chapters.length);
    await pause(2600);
  };

  // ---- intro ----------------------------------------------------------------------------------------------------
  await page.goto('/');
  await expect(page.getByTestId('palette-button')).toBeVisible();
  await caption(page, 'Guildwise HQ: run a team of AI agents. Here is how to get going in five steps.');
  await pause(3500);

  // ---- 1. your first project ------------------------------------------------------------------------------------
  await chapter('Create your first project', 'Step 1: create your first project');
  await click(page, page.getByRole('link', { name: 'Projects' }).first());
  await click(page, page.getByRole('button', { name: /new project/i }).first());
  const dlg = page.getByRole('dialog');
  await type(page, dlg.getByLabel('Key'), 'SHOP');
  await type(page, dlg.getByLabel('Name'), 'Web shop');
  await click(page, dlg.getByRole('button', { name: /create/i }));
  await expect(page.getByText('SHOP').first()).toBeVisible();
  await caption(page, 'Add the repository the agents will work in', 1);
  await click(page, page.getByRole('link', { name: 'Settings for SHOP' }));
  const add = page.getByRole('form', { name: 'Add repository' });
  await type(page, add.getByLabel('Repository name'), 'shop');
  await click(page, add.getByLabel('Remote URL'), 100);
  await add.getByLabel('Remote URL').fill(paths.origin);
  await pause(800);
  await add.getByLabel('Branch (optional)').fill('main');
  await click(page, add.getByRole('button', { name: /add/i }));
  await expect(page.getByTestId('repos')).toContainText('shop');
  await pause(1500);

  // ---- 2. hire agents -------------------------------------------------------------------------------------------
  await chapter('Hire your agents', 'Step 2: hire agents. Each one has a role and a seniority');
  await click(page, page.getByRole('link', { name: 'Agents' }).first());
  const hire = async (role: string, name: string, seniority?: string) => {
    await click(page, page.getByRole('button', { name: 'Hire agent' }).first());
    const form = page.getByRole('form', { name: 'Hire agent' });
    await form.getByLabel('Role', { exact: true }).selectOption({ label: role });
    if (seniority) await form.getByLabel('Seniority').selectOption(seniority);
    await form.getByLabel('Runtime').selectOption('mock');
    await type(page, form.getByLabel('Name', { exact: true }), name);
    await click(page, form.getByRole('button', { name: 'Hire', exact: true }));
    await expect(page.getByTestId(`agent-${name}`)).toBeVisible();
    await pause(900);
  };
  await hire('Business analyst', 'Bea');
  await hire('Builder', 'Ada');
  await hire('Reviewer', 'Linus', 'senior');
  await hire('Tester', 'Tess');
  await caption(page, 'A business analyst, a builder, a reviewer and a tester: a small team', 2);
  await pause(3000);

  // ---- 3. cards ---------------------------------------------------------------------------------------------------
  await chapter('Create cards', 'Step 3: describe the work as a card');
  await page.goto('/cards/new');
  const form = page.getByRole('form', { name: 'New card' });
  await type(page, form.getByLabel('Title', { exact: true }), 'Show a welcome banner');
  await form.getByLabel('Repository').selectOption({ label: 'shop' });
  await form.getByLabel('Completion action').selectOption('push_branch');
  await form.getByLabel('Context', { exact: true }).fill('Visitors do not know what the shop sells.');
  await form.getByLabel('Requirements').fill('Show a welcome banner on the home page.');
  await form.getByLabel('Acceptance criteria').fill('The banner is visible\nIt can be closed');
  await form.getByLabel('Affected areas').fill('index.js');
  await form.getByLabel('Constraints').fill('None');
  await form.getByLabel('Test plan').fill('Open the home page and close the banner');
  await pause(2500);
  await click(page, form.getByRole('button', { name: 'Specify', exact: true }));
  await expect(page).toHaveURL(/\/cards\/SHOP-1$/);
  await caption(page, 'The agents pick the card up by themselves. You can add more at any time', 3);
  await pause(3000);
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
  await pause(2500);

  // ---- 4. talk to the BA ------------------------------------------------------------------------------------------
  await chapter('Talk to the business analyst', 'Step 4: ask the business analyst anything, in plain words');
  await click(page, page.getByRole('button', { name: 'Chat', exact: true }));
  const drawer = page.getByRole('dialog', { name: 'Chat' });
  const bea = drawer.getByLabel('Agent').locator('option', { hasText: 'Bea' });
  await drawer.getByLabel('Agent').selectOption(await bea.getAttribute('value'));
  await click(page, drawer.getByRole('button', { name: 'Start chat' }));
  await type(page, drawer.getByLabel('Message'), 'What would you add to the shop next?');
  await click(page, drawer.getByRole('button', { name: 'Send' }));
  await expect(drawer.getByTestId('chat-message').last()).toContainText('heard', { timeout: 60_000 });
  await caption(page, 'The BA answers, and can turn a conversation into cards', 4);
  await pause(3500);
  await page.keyboard.press('Escape');

  // ---- 5. test the running project -------------------------------------------------------------------------------
  await chapter('Test your running project', 'Step 5: watch the work move across the board');
  await waitFor(
    'a card reaches review or later',
    () => q<{ stage: string }>(`SELECT stage FROM cards WHERE ref='SHOP-1'`),
    (r) => !!r[0] && r[0].stage !== 'spec' && r[0].stage !== 'build',
    240_000,
  );
  await pause(2000);
  await click(page, page.getByTestId('card-tile-SHOP-1'));
  await expect(page).toHaveURL(/\/cards\/SHOP-1$/);
  await caption(page, 'Open a card to see the plan, the transcript and what it cost', 5);
  await pause(3500);
  await caption(
    page,
    'The tester agent runs your project and reports what it found. Bugs become new cards',
    5,
  );
  await page.mouse.wheel(0, 500);
  await pause(4500);
  await caption(page, 'That is it. Hire, describe, watch. Find more in Help.', undefined);
  await pause(3500);

  // ---- finish: save the video -------------------------------------------------------------------------------------
  const duration = Math.round((Date.now() - t0) / 100) / 10;
  const video = page.video();
  await ctx.close();
  const raw = await video?.path();
  expect(raw).toBeTruthy();
  mkdirSync(OUT_DIR, { recursive: true });
  const dest = join(OUT_DIR, 'getting-started.webm');
  if (!shrink(raw as string, dest)) copyFileSync(raw as string, dest);
  const bytes = statSync(dest).size;
  expect(bytes, 'the video must stay under 20 MB').toBeLessThan(20 * 1024 * 1024);
  writeFileSync(
    join(OUT_DIR, 'getting-started.json'),
    `${JSON.stringify(
      {
        title: 'Getting started with Guildwise HQ',
        src: '/videos/getting-started.webm',
        type: 'video/webm',
        duration,
        chapters,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`video: ${dest} ${(bytes / 1024 / 1024).toFixed(1)} MB, ${duration}s`);
  void sleep;
});
