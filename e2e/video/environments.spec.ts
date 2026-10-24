import { expect, type Locator, test } from '@playwright/test';
import { pool, waitFor } from '../support/db.ts';
import { click, type } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/environments.ts';
import { createProject, demoApi } from './seed.ts';
import {
  advanceClock,
  computerPlace,
  type DemoComputer,
  demoComputer,
  gitProjectVault,
  headCommit,
  release,
  runningStack,
  saveSetup,
  stackEnv,
  stopDemoSites,
  tryApproveAndTurnOn,
} from './seed-deploy.ts';

/**
 * The Environments video (sidebar section 3): Your app and its DevOps suggestion, the test site and the live site (with
 * "Release the newest version" when nothing is waiting), Places with Check and Reconnect, Add an environment up to a
 * review whose Save is off with its reason, and the Releases switch.
 * Output: media/videos/environments.{webm,mp4,vtt,json}
 *   e2e/video/record.sh environments
 * The demo computers are mock runners with the fake docker of the runner tests (see seed-deploy.ts): the setup, the
 * dry runs and both releases are real runs of the server and runner code against throwaway files.
 */
const SLUG = 'environments';
const computers: DemoComputer[] = [];

test.afterAll(async () => {
  stopDemoSites(computers);
  await pool.end();
});

/** Scrolls an element to the middle of the screen, the way a person would. */
async function scrollTo(target: Locator, ms = 900): Promise<void> {
  await target.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  await pause(ms);
}

test('record the environments video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const api = await demoApi();
  const { projectId } = await createProject(api, 'SHOP', 'Web shop');
  const laptop = await demoComputer(api, "Alex's laptop", 'laptop');
  const office = await demoComputer(api, 'Office PC', 'office');
  const reception = await demoComputer(api, 'Reception PC', 'reception', { noCompose: true });
  computers.push(laptop, office, reception);
  const testStack = await runningStack(laptop, { folder: 'shop-test', project: 'shop-test' });
  const liveStack = await runningStack(office, { folder: 'shop', project: 'shop' });
  await runningStack(reception, { folder: 'shop-demo', project: 'shop-demo' });
  await gitProjectVault(api, projectId, 'shop', [laptop, office]);
  await computerPlace(api, projectId, laptop, { appUrl: `http://127.0.0.1:${testStack.port}` });
  await computerPlace(api, projectId, office, {
    appUrl: `http://127.0.0.1:${liveStack.port}`,
    production: true,
  });
  await saveSetup(api, projectId, {
    environments: [
      stackEnv(testStack, { name: 'test', label: 'Test site', target: "Alex's laptop", role: 'test' }),
      stackEnv(liveStack, {
        name: 'live',
        label: 'Live site',
        target: 'Office PC',
        role: 'live',
        testEnv: 'test',
      }),
    ],
  });
  await tryApproveAndTurnOn(api, projectId);
  const sha = headCommit();
  await release(api, projectId, 'test', sha);
  // the live site's rule: the test site healthy on the same version for 10 minutes
  await advanceClock(11 * 60_000);
  await release(api, projectId, 'live', sha);
  // a server the project can use later (never contacted in the video)
  const server = await api.post(`/api/projects/${projectId}/deploy-targets`, {
    data: {
      name: 'Cloud server',
      kind: 'remote_ssh',
      host: 'shop.example.com',
      notes: '',
      workstationId: laptop.id,
    },
  });
  expect(server.status(), await server.text()).toBe(201);
  // DevOps scans how to start the app: its suggestion waits on the page
  const scan = await api.post(`/api/projects/${projectId}/scan`, {
    data: { area: 'run', workstationId: laptop.id },
  });
  expect(scan.status(), await scan.text()).toBe(202);
  await waitFor(
    'the DevOps suggestion',
    async () => (await (await api.get(`/api/projects/${projectId}/run-plan`)).json()).proposal?.proposal?.run,
    (r) => !!r,
    120_000,
  );

  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Environments: where your app runs',
    cues: allCues(),
    chapters: CHAPTERS,
  });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through ----------------------------------------------------------------------------------------------
  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('nav-environments')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-environments'));
    await expect(page.getByTestId('environments-page')).toBeVisible();
    await expect(page.getByTestId('env-chip-live')).toHaveText('Healthy');
  });
  await narrate('c1-b', async () => {
    await pause(1500);
    await click(page, page.getByTestId('proposal-review-open'));
    await expect(page.getByText('1 question before you can use this')).toBeVisible();
    await pause(800);
    await scrollTo(page.getByText('Which page shows that the website is ready?'));
  });
  await narrate('c1-c', async () => {
    await click(page, page.getByTestId('your-app').getByRole('button', { name: 'Answer', exact: true }));
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('DevOps asks')).toBeVisible();
    await pause(1500);
    await click(page, dialog.getByRole('button', { name: 'Save' }));
    await expect(page.getByText('Your answers')).toBeVisible();
    const use = page.getByRole('button', { name: 'Use these steps' });
    await scrollTo(use, 600);
    await click(page, use);
    await expect(page.getByTestId('your-app-chip')).toHaveText('Ready');
    await scrollTo(page.getByTestId('your-app-chip'), 600);
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await scrollTo(page.getByTestId('env-card-test'));
    await expect(page.getByTestId('env-chip-test')).toHaveText('Healthy');
  });
  await narrate('c2-b', async () => {
    const rel = page.getByTestId('env-release-live');
    await scrollTo(page.getByTestId('env-card-live'));
    await expect(rel).toHaveText('Release the newest version');
    await pause(1500);
    await click(page, rel);
    const sheet = page.getByRole('dialog', { name: 'Release to Live site' });
    await expect(sheet).toBeVisible();
    await pause(3500);
    await click(page, sheet.getByRole('button', { name: 'Cancel' }));
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await scrollTo(page.getByTestId('places'));
    await click(page, page.getByTestId("place-check-Alex's laptop"));
    await pause(1500);
  });
  await narrate('c3-b', async () => {
    await click(page, page.getByTestId('place-reconnect-Cloud server'));
    const dialog = page.getByRole('dialog', { name: 'Reconnect Cloud server' });
    await expect(dialog.getByText('Which computer signs in?')).toBeVisible();
    await pause(3500);
    await click(page, dialog.getByRole('button', { name: 'Cancel' }).last());
    await expect(dialog).toHaveCount(0);
  });

  await chapter(4);
  await narrate('c4-a', async () => {
    await scrollTo(page.getByTestId('setup-add-below'), 500);
    await click(page, page.getByTestId('setup-add-below'));
    await click(page, page.getByTestId('role-other'));
    await type(page, page.getByTestId('env-label'), 'Demo');
    await click(page, page.getByTestId('place-choice-Reception PC'));
    const stack = page.getByTestId('stack-choice').filter({ hasText: 'shop-demo' });
    await click(page, stack);
    await click(page, page.getByTestId('when-manual'));
  });
  await narrate('c4-b', async () => {
    await click(page, page.getByTestId('env-next'));
    await click(page, page.getByTestId('env-to-review'));
    const reason = page.getByTestId('review-save-reason');
    await expect(reason).toContainText('still needs something set up first');
    await expect(page.getByTestId('review-save')).toBeDisabled();
    await scrollTo(page.getByText('Docker Compose is not installed').first(), 1200);
    await scrollTo(reason, 2500);
  });

  await chapter(5);
  await narrate('c5-a', async () => {
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('environment-dialog')).toHaveCount(0);
    await scrollTo(page.getByTestId('releases-switch'), 600);
    await click(page, page.getByTestId('releases-toggle'));
    await expect(page.getByTestId('releases-pause-dialog')).toBeVisible();
    await pause(2500);
    await click(page, page.getByTestId('releases-pause-confirm'));
    await expect(page.getByTestId('releases-toggle')).toHaveText('Paused');
  });
  await narrate('c5-b', async () => {
    await click(page, page.getByTestId('releases-toggle'));
    await expect(page.getByTestId('releases-toggle')).toHaveText('On');
  });
  await narrate('outro-1');

  await finish();
});
