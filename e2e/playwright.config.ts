import { defineConfig } from '@playwright/test';
import { BASE_URL } from './support/env.ts';

// The specs share one stack (server on 4601 + aom_e2e database + a mock-adapter runner), so they run
// in order in a single worker: auth -> pairing -> core-loop -> desk -> chat. Build first: `pnpm e2e` does it.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  globalSetup: process.env.AOM_E2E_GUIDE === '1' ? './guide-global-setup.ts' : './global-setup.ts',
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
    { name: 'desk', testMatch: 'desk.spec.ts', dependencies: ['core-loop'] },
    { name: 'chat', testMatch: 'chat.spec.ts', dependencies: ['desk'] },
    { name: 'devops', testMatch: 'devops.spec.ts', dependencies: ['chat'] },
    { name: 'sharing', testMatch: 'sharing.spec.ts', dependencies: ['devops'] },
    { name: 'test-loop', testMatch: 'test-loop.spec.ts', dependencies: ['sharing'] },
    { name: 'feeds', testMatch: 'feeds.spec.ts', dependencies: ['sharing'] },
    { name: 'research', testMatch: 'research.spec.ts', dependencies: ['feeds'] },
    { name: 'intake', testMatch: 'intake.spec.ts', dependencies: ['research'] },
    { name: 'hr', testMatch: 'hr.spec.ts', dependencies: ['intake'] },
    { name: 'sandbox', testMatch: 'sandbox.spec.ts', dependencies: ['intake'] },
    { name: 'outbox', testMatch: 'outbox.spec.ts', dependencies: ['intake'] },
    { name: 'org-designer', testMatch: 'org-designer.spec.ts', dependencies: ['intake'] },
    // The screenshot run for docs/guide (never part of `pnpm e2e`): AOM_E2E_GUIDE=1 playwright test --project=guide
    ...(process.env.AOM_E2E_GUIDE === '1' ? [{ name: 'guide', testMatch: 'guide-screenshots.spec.ts', timeout: 600_000 }] : []),
  ],
});
