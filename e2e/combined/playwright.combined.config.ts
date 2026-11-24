import { defineConfig } from '@playwright/test';
import { BASE_URL, RESULTS_DIR } from '../support/env.ts';

// One worker, in order: the specs share one server and one database (as in the normal e2e suite). Group A first, then B;
// groups C and D add `combined-c` / `combined-d` projects here as their builds land (DESIGN section 6).
export default defineConfig({
  outputDir: `${RESULTS_DIR}/test-results`,
  testDir: './specs',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  expect: { timeout: 30_000 },
  reporter: [['list'], ['json', { outputFile: `${RESULTS_DIR}/results.json` }], ['./support/reporter.ts']],
  use: { baseURL: BASE_URL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  // ONE project: the spec files run in file-name order (a-*, then b-*, then e-*; E7 restarts the server, so it is last), and
  // a red scenario never stops the later groups from running (Playwright skips a project whose dependency failed).
  projects: [{ name: 'combined', testMatch: '{a,b,e}-*.spec.ts' }],
});
