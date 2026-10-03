import { defineConfig } from '@playwright/test';
import { BASE_URL } from './support/env.ts';

// The three specs share one stack (server on 4601 + aom_e2e database + a mock-adapter runner), so they run
// in order in a single worker: auth -> pairing -> core-loop. Build first: `pnpm e2e` does it.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: { baseURL: BASE_URL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'auth', testMatch: 'auth.spec.ts' },
    { name: 'pairing', testMatch: 'pairing.spec.ts', dependencies: ['auth'] },
    { name: 'core-loop', testMatch: 'core-loop.spec.ts', dependencies: ['pairing'] },
    { name: 'devops', testMatch: 'devops.spec.ts', dependencies: ['core-loop'] },
    { name: 'sharing', testMatch: 'sharing.spec.ts', dependencies: ['devops'] },
  ],
});
