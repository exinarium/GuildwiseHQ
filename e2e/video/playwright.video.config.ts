import './defaults.ts';
import { defineConfig } from '@playwright/test';
import { BASE_URL } from '../support/env.ts';

/**
 * Records the "Getting started" help video (never part of `pnpm e2e`, whose config only looks in ./tests):
 *   pnpm build && pnpm --filter @aom/e2e video
 * It starts its own server, database and mock runner (the same global setup as the e2e suite) and drives the real UI.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'getting-started.spec.ts',
  globalSetup: '../global-setup.ts',
  workers: 1,
  retries: 0,
  timeout: 900_000,
  expect: { timeout: 60_000 },
  reporter: [['list']],
  use: { baseURL: BASE_URL },
});
