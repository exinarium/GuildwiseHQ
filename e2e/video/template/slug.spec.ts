import { expect, test } from '@playwright/test';
import { pool } from '../../support/db.ts';
import { click } from '../captions.ts';
import { pause, prepareVideo, startRecording } from '../harness.ts';
import { allCues, CHAPTERS } from '../narration/slug.ts';
import { createProject, demoApi } from '../seed.ts';

/**
 * TEMPLATE for a section video. To record a new video:
 *   1. copy this file to e2e/video/<slug>.spec.ts and narration/slug.ts to e2e/video/narration/<slug>.ts
 *      (cp e2e/video/template/slug.spec.ts e2e/video/<slug>.spec.ts, then fix the two imports above)
 *   2. write the narration after the entry of the video in docs/guide/VIDEO-PLAN.md
 *   3. seed only what the entry's "Prerequisites and test data" lists, in this file (demo data only)
 *   4. e2e/video/record.sh <slug>
 *   5. in apps/web/src/lib/videos.ts set `published: true` for the slug, then commit the four files
 *      apps/web/public/videos/<slug>.{webm,mp4,vtt,json}
 * This file lives in template/ so that `record.sh` and the video config never run it.
 */
const SLUG = 'slug'; // the key in apps/web/src/lib/videos.ts and the file name stem

test.afterAll(async () => {
  await pool.end();
});

test('record the SLUG video', async ({ browser }) => {
  // ---- seed (demo data only): Acme and its Owner Alex Morgan exist already -----------------------------------------
  const api = await demoApi();
  await createProject(api, 'SHOP', 'Web shop');
  // await pairWorkstation(api);                         // a mock workstation (needed for agents and running cards)
  // await hireAgent(api, { name: 'Bea', roleKey: 'ba', workstationId, projectId });
  // await createCard(api, { projectId, repoId, title: 'Show a welcome banner' });

  // ---- voice and camera ----------------------------------------------------------------------------------------------
  const prepared = prepareVideo({
    slug: SLUG,
    title: 'Title shown above the player',
    cues: allCues(),
    chapters: CHAPTERS,
  }); // a second argument { [question]: answer } scripts a BA reply (call before pairWorkstation)
  const { page, narrate, chapter, finish } = await startRecording(prepared, browser, api);

  // ---- the walk-through: start on the page the video is about, reached through the sidebar (plan rule 3) --------------
  await page.goto('/p/SHOP/board');
  await narrate('intro-1');

  await chapter(1);
  await narrate('c1-a', async () => {
    await click(page, page.getByTestId('nav-backlog')); // click() and type() move a visible pointer
    await expect(page.getByTestId('backlog-list')).toBeVisible();
    await pause(1000);
  });
  await narrate('outro-1');

  await finish(); // writes apps/web/public/videos/<slug>.{webm,mp4,vtt,json}
});
