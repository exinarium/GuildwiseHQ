import './defaults.ts';
import { defineConfig } from '@playwright/test';
import { BASE_URL } from '../support/env.ts';

/**
 * Records the help videos, one `e2e/video/<slug>.spec.ts` each (never part of `pnpm e2e`, whose config only looks in
 * ./tests). Use `e2e/video/record.sh <slug>...`, or by hand:
 *   pnpm build && AOM_VIDEO_SLUG=backlog pnpm --filter @aom/e2e video
 * AOM_VIDEO_SLUG picks one spec (without it every spec in this folder runs, one after the other, on ONE stack: use
 * record.sh to give each video a fresh stack). It starts its own server, database and mock runner (the same global
 * setup as the e2e suite) and drives the real UI. AOM_VIDEO_PORT, AOM_VIDEO_DB and AOM_VIDEO_DIR_BASE make the stack
 * private to a run, so recordings can run side by side (see defaults.ts).
 */
export default defineConfig({
  testDir: '.',
  testMatch: process.env.AOM_VIDEO_SLUG ? `${process.env.AOM_VIDEO_SLUG}.spec.ts` : '*.spec.ts',
  testIgnore: '**/template/**', // the spec template is never recorded
  globalSetup: '../global-setup.ts',
  workers: 1,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: { baseURL: BASE_URL, actionTimeout: 30_000 }, // a missing control fails in 30 s, not at the end of the test timeout
});
