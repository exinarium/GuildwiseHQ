import { defineConfig, devices } from '@playwright/test';
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
    { name: 'landing', testMatch: 'landing.spec.ts', dependencies: ['auth'] },
    { name: 'mobile-public', testMatch: 'mobile-public.spec.ts', dependencies: ['auth'] },
    { name: 'pairing', testMatch: 'pairing.spec.ts', dependencies: ['auth'] },
    { name: 'core-loop', testMatch: 'core-loop.spec.ts', dependencies: ['pairing'] },
    { name: 'desk', testMatch: 'desk.spec.ts', dependencies: ['core-loop'] },
    { name: 'chat', testMatch: 'chat.spec.ts', dependencies: ['desk'] },
    { name: 'devops', testMatch: 'devops.spec.ts', dependencies: ['chat'] },
    { name: 'sharing', testMatch: 'sharing.spec.ts', dependencies: ['devops'] },
    { name: 'test-loop', testMatch: 'test-loop.spec.ts', dependencies: ['sharing'] },
    { name: 'research', testMatch: 'research.spec.ts', dependencies: ['sharing'] },
    { name: 'intake', testMatch: 'intake.spec.ts', dependencies: ['research'] },
    { name: 'hr', testMatch: 'hr.spec.ts', dependencies: ['intake'] },
    { name: 'workability', testMatch: 'workability.spec.ts', dependencies: ['intake'] },
    { name: 'sandbox', testMatch: 'sandbox.spec.ts', dependencies: ['intake'] },
    { name: 'outbox', testMatch: 'outbox.spec.ts', dependencies: ['intake'] },
    { name: 'architect', testMatch: 'architect.spec.ts', dependencies: ['intake'] },
    { name: 'org-designer', testMatch: 'org-designer.spec.ts', dependencies: ['intake'] },
    { name: 'phases', testMatch: 'phases.spec.ts', dependencies: ['intake'] },
    { name: 'reporter', testMatch: 'reporter.spec.ts', dependencies: ['phases'] },
    { name: 'hygiene', testMatch: 'hygiene.spec.ts', dependencies: ['reporter'] },
    { name: 'interests', testMatch: 'interests.spec.ts', dependencies: ['hygiene'] },
    { name: 'interests-migration', testMatch: 'interests-migration.spec.ts', dependencies: ['interests'] },
    { name: 'ranking', testMatch: 'ranking.spec.ts', dependencies: ['interests-migration'] },
    { name: 'polish', testMatch: 'polish.spec.ts', dependencies: ['ranking'] },
    { name: 'platform', testMatch: 'platform.spec.ts', dependencies: ['polish'] },
    { name: 'org-members', testMatch: 'org-members.spec.ts', dependencies: ['platform'] },
    { name: 'agent-projects', testMatch: 'agent-projects.spec.ts', dependencies: ['platform'] },
    { name: 'schedules', testMatch: 'schedules.spec.ts', dependencies: ['agent-projects'] },
    { name: 'convert', testMatch: 'project-convert.spec.ts', dependencies: ['schedules'] },
    { name: 'budgets', testMatch: 'budgets.spec.ts', dependencies: ['agent-projects'] },
    { name: 'org-chart', testMatch: 'org-chart.spec.ts', dependencies: ['budgets'] },
    { name: 'installer', testMatch: 'installer.spec.ts', dependencies: ['org-chart'] },
    { name: 'support', testMatch: 'support.spec.ts', dependencies: ['installer'] },
    { name: 'tour', testMatch: 'tour.spec.ts', dependencies: ['support'] },
    // Mobile (PWA) flows at iPhone size: WebKit when the browser is installed (AOM_E2E_WEBKIT=1), else Chromium with the
    // iPhone 15 viewport, touch and user agent. Needs only the paired workstation and project TOY (pairing); the spec hires its own builders and reviewer.
    {
      name: 'mobile',
      testMatch: 'mobile.spec.ts',
      dependencies: ['pairing'],
      use: mobileUse(),
    },
    { name: 'mobile-board', testMatch: 'mobile-board.spec.ts', dependencies: ['pairing'], use: mobileUse() },
    // The phone shell (bottom tab bar, More menu, PWA files): needs no other spec.
    {
      name: 'mobile-shell',
      testMatch: 'mobile-nav.spec.ts',
      use: mobileUse(),
    },
    // The screenshot run for docs/guide (never part of `pnpm e2e`): AOM_E2E_GUIDE=1 playwright test --project=guide
    ...(process.env.AOM_E2E_GUIDE === '1'
      ? [
          {
            name: 'guide',
            testMatch: 'guide-screenshots.spec.ts',
            timeout: 600_000,
            use: { actionTimeout: 30_000 },
          },
        ]
      : []),
  ],
});

/** The `iPhone 15` descriptor on WebKit, or on Chromium when WebKit is not installed (its Linux host libraries are optional). */
function mobileUse() {
  const { defaultBrowserType: _ignored, ...phone } = devices['iPhone 15'];
  return {
    ...phone,
    browserName: process.env.AOM_E2E_WEBKIT === '1' ? ('webkit' as const) : ('chromium' as const),
  };
}
