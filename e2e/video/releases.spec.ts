import { expect, test } from '@playwright/test';
import { pool, q, waitFor } from '../support/db.ts';
import { click } from './captions.ts';
import { pause, prepareVideo, startRecording } from './harness.ts';
import { allCues, CHAPTERS } from './narration/releases.ts';
import { createProject, demoApi } from './seed.ts';
import {
  advanceClock,
  computerPlace,
  type DemoComputer,
  demoCommit,
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
 * The Releases video (sidebar section 14): the queue (Release, Not now), What is live, the history and its filters, the
 * standard rule and the advanced rule sets, Freeze all releases and Lift the freeze.
 * Output: apps/web/public/videos/releases.{webm,mp4,vtt,json}
 *   e2e/video/record.sh releases
 * The demo computers are mock runners with the fake docker of the runner tests (see seed-deploy.ts). The two queued
 * versions come from the merge trigger (its queue row, due at once): the server picks the version from the standard
 * rule, queues it for the Owner and runs the release.
 */
const SLUG = 'releases';
const computers: DemoComputer[] = [];

test.afterAll(async () => {
  stopDemoSites(computers);
  await pool.end();
});

test('record the releases video', async ({ browser }) => {
  // ---- seed (demo data only) ---------------------------------------------------------------------------------------
  const api = await demoApi();
  const { projectId } = await createProject(api, 'SHOP', 'Web shop');
  const laptop = await demoComputer(api, "Alex's laptop", 'laptop');
  const office = await demoComputer(api, 'Office PC', 'office');
  computers.push(laptop, office);
  const testStack = await runningStack(laptop, { folder: 'shop-test', project: 'shop-test' });
  const liveStack = await runningStack(office, { folder: 'shop', project: 'shop' });
  const demoStack = await runningStack(office, {
    folder: 'shop-demo',
    project: 'shop-demo',
    service: 'demo',
    withDb: false,
  });
  await gitProjectVault(api, projectId, 'shop', [laptop, office]);
  await computerPlace(api, projectId, laptop, { appUrl: `http://127.0.0.1:${testStack.port}` });
  await computerPlace(api, projectId, office, {
    appUrl: `http://127.0.0.1:${liveStack.port}`,
    production: true,
  });
  // the live site and the customer demo follow each merge, but only the Owner releases them. The test site is
  // released by hand here (how it updates is not part of this video).
  const owner = { trigger: ['after_merge'], releasedBy: 'owner', gate: 'none' };
  await saveSetup(api, projectId, {
    environments: [
      {
        ...stackEnv(testStack, { name: 'test', label: 'Test site', target: "Alex's laptop", role: 'test' }),
        trigger: ['on_request'],
      },
      {
        ...stackEnv(liveStack, { name: 'live', label: 'Live site', target: 'Office PC', role: 'live' }),
        ...owner,
      },
      {
        ...stackEnv(demoStack, { name: 'demo', label: 'Customer demo', target: 'Office PC', role: 'other' }),
        ...owner,
      },
    ],
  });
  await tryApproveAndTurnOn(api, projectId);
  const first = headCommit();
  await release(api, projectId, 'test', first);
  await release(api, projectId, 'live', first);
  await release(api, projectId, 'demo', first);
  // the standard rule of the project: a site on a live place follows the test site after 10 healthy minutes
  const preset = await api.put('/api/delivery/presets', {
    data: {
      name: 'standard',
      gate: { requires: [{ envHealthy: 'test', sameCommit: true, forMinutes: 10 }] },
    },
  });
  expect(preset.ok(), await preset.text()).toBe(true);
  const bind = await api.put('/api/delivery/bindings', {
    data: { projectId, envMatch: 'production', preset: 'standard' },
  });
  expect(bind.ok(), await bind.text()).toBe(true);
  // a new version on the test site; then the merge trigger asks for the sites that follow merges. Without a commit of
  // its own, each takes what the test site runs (the standard rule) and waits for the Owner.
  const second = demoCommit('Show a gift message on the order page');
  await release(api, projectId, 'test', second);
  // the standard rule: the test site healthy on the same version for 10 minutes (a merge trigger whose rule does not
  // hold yet is refused, not queued)
  await advanceClock(11 * 60_000);
  await q(
    `INSERT INTO deploy_trigger_queue (project_id, trigger, commit, due_at, created_at)
     VALUES ($1, 'after_merge', NULL, '2000-01-01', now())`,
    [projectId],
  );
  await waitFor(
    'two releases wait',
    () =>
      q<{ env: string; status: string }>(
        `SELECT env, status FROM deploy_runs WHERE project_id=$1 AND commit=$2 AND NOT dry_run`,
        [projectId, second],
      ),
    (r) => r.filter((x) => x.status === 'waiting_release').length === 2,
    120_000,
  );
  const prepared = prepareVideo({ slug: SLUG, title: 'Releases', cues: allCues(), chapters: CHAPTERS });
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through ----------------------------------------------------------------------------------------------
  await page.goto('/p/SHOP/board');
  await expect(page.getByTestId('nav-releases')).toBeVisible();
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-releases'));
    await expect(page.getByTestId('release-queue')).toBeVisible();
    await expect(page.getByTestId('release-SHOP-live')).toBeVisible();
    await expect(page.getByTestId('release-SHOP-demo')).toBeVisible();
  });
  await narrate('c1-b', async () => {
    const button = page.getByTestId('release-SHOP-live-button');
    await expect(button).toBeEnabled();
    await pause(800);
    await click(page, button);
    await expect(page.getByTestId('release-SHOP-live')).toHaveCount(0, { timeout: 30_000 });
  });
  await narrate('c1-c', async () => {
    await click(page, page.getByTestId('release-SHOP-demo').getByRole('button', { name: 'Not now' }));
    await expect(page.getByTestId('release-queue-empty')).toBeVisible();
  });

  await chapter(2);
  await narrate('c2-a', async () => {
    await click(page, page.getByTestId('releases-tab-live'));
    await expect(page.getByTestId('live-row-SHOP-live')).toBeVisible();
    await expect(page.getByTestId('live-row-release-SHOP-demo')).toBeVisible({ timeout: 60_000 });
    await pause(1500);
    await page.getByTestId('live-row-release-SHOP-demo').hover();
  });
  await narrate('c2-b', async () => {
    await click(page, page.getByTestId('releases-tab-history'));
    await expect(page.getByTestId('deploy-runs')).toBeVisible();
    await pause(800);
    const result = page.getByTestId('history-filters').getByLabel('Result');
    await click(page, result, 200);
    await result.selectOption('ok');
    await pause(1000);
    // the newest release: the live site, asked for by a rule and released by the Owner a moment ago
    await click(page, page.locator('[data-testid^="run-"] > button').first());
    await expect(page.getByText('Released by')).toBeVisible();
    await pause(1500);
  });

  await chapter(3);
  await narrate('c3-a', async () => {
    await click(page, page.getByTestId('releases-tab-rules'));
    await expect(page.getByTestId('rules-list')).toBeVisible();
    await pause(1500);
    await click(page, page.getByTestId('rules-advanced').locator('summary'));
    await expect(page.getByTestId('gate-presets')).toBeVisible();
    await pause(800);
  });
  await narrate('c3-b', async () => {
    const freeze = page.getByTestId('freeze-toggle');
    await click(page, freeze);
    await expect(freeze).toHaveText('Lift the freeze');
    await pause(1800);
    await click(page, freeze);
    await expect(freeze).toHaveText('Freeze all releases');
  });
  await narrate('outro-1');

  await finish();
});
