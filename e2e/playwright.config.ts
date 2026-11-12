import { defineConfig, devices } from '@playwright/test';
import { BASE_URL, RESULTS_DIR } from './support/env.ts';

/**
 * Projects that need a Docker daemon. Tester shifts have none: with AOM_E2E_NO_DOCKER=1 (script `full:shift`) they are left
 * out and named in the JSON report's metadata, and DevOps runs them (script `docker`). Nothing is skipped inside a spec.
 */
export const DOCKER_PROJECTS = [
  'deploy-setup',
  'deploy-connect',
  'deploy-move',
  'journey-containers',
  'journey-containers-teardown',
  'deploy-setup-journey',
];
const NO_DOCKER = process.env.AOM_E2E_NO_DOCKER === '1';
const NO_DOCKER_REASON = 'Docker is not available in tester shifts: run by DevOps';

// The specs share one stack (server on 4601 + aom_e2e database + a mock-adapter runner), so they run
// in order in a single worker: auth -> pairing -> core-loop -> desk -> chat. Build first: `pnpm e2e` does it.
const config = defineConfig({
  metadata: NO_DOCKER
    ? { excludedProjects: DOCKER_PROJECTS.map((name) => ({ name, reason: NO_DOCKER_REASON })) }
    : {},
  outputDir: `${RESULTS_DIR}/test-results`,
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  globalSetup: process.env.AOM_E2E_GUIDE === '1' ? './guide-global-setup.ts' : './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [
    ['list'],
    ['json', { outputFile: `${RESULTS_DIR}/results.json` }],
    ['html', { outputFolder: `${RESULTS_DIR}/report`, open: 'never' }],
  ],
  use: { baseURL: BASE_URL, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'auth', testMatch: 'auth.spec.ts' },
    { name: 'pairing', testMatch: 'pairing.spec.ts', dependencies: ['auth'] },
    { name: 'core-loop', testMatch: 'core-loop.spec.ts', dependencies: ['pairing'] },
    { name: 'desk', testMatch: 'desk.spec.ts', dependencies: ['core-loop'] },
    { name: 'chat', testMatch: 'chat.spec.ts', dependencies: ['desk'] },
    { name: 'ceo-chat', testMatch: 'ceo-chat.spec.ts', dependencies: ['chat'] },
    { name: 'devops', testMatch: 'devops.spec.ts', dependencies: ['chat'] },
    { name: 'sharing', testMatch: 'sharing.spec.ts', dependencies: ['devops'] },
    { name: 'test-loop', testMatch: 'test-loop.spec.ts', dependencies: ['sharing'] },
    { name: 'research', testMatch: 'research.spec.ts', dependencies: ['sharing'] },
    { name: 'intake', testMatch: 'intake.spec.ts', dependencies: ['research'] },
    // Discovery Studio (phase B): its own user, runner and project; needs only the shared stack.
    { name: 'pr-only', testMatch: 'pr-only.spec.ts', dependencies: ['auth'] },
    { name: 'discovery', testMatch: 'discovery.spec.ts', dependencies: ['auth'] },
    // Boardroom (phase C): its own user and runner; needs only the shared stack.
    { name: 'boardroom', testMatch: 'boardroom.spec.ts', dependencies: ['auth'] },
    { name: 'hr', testMatch: 'hr.spec.ts', dependencies: ['intake'] },
    { name: 'workability', testMatch: 'workability.spec.ts', dependencies: ['intake'] },
    { name: 'sandbox', testMatch: 'sandbox.spec.ts', dependencies: ['intake'] },
    { name: 'outbox', testMatch: 'outbox.spec.ts', dependencies: ['intake'] },
    { name: 'architect', testMatch: 'architect.spec.ts', dependencies: ['intake'] },
    { name: 'org-designer', testMatch: 'org-designer.spec.ts', dependencies: ['intake'] },
    { name: 'phases', testMatch: 'phases.spec.ts', dependencies: ['intake'] },
    // Release prep (docs and videos): its own owner, guest, runner (mock) and two local origins; needs only the shared stack.
    { name: 'release-docs-prep', testMatch: 'release-docs-prep.spec.ts', dependencies: ['auth'] },
    // Guided run steps and Scan with DevOps (v1a): its own user, runner and project; needs only the shared stack.
    { name: 'run-steps', testMatch: 'run-steps.spec.ts', dependencies: ['auth'] },
    // Business mode: its own user and paired mock workstation (no runner process); needs only the shared stack.
    { name: 'business-mode', testMatch: 'business-mode.spec.ts', dependencies: ['auth'] },
    // Business card types (enquiry, quote, ...): its own user and mock runner, an organization with no repository.
    { name: 'business-card-types', testMatch: 'business-card-types.spec.ts', dependencies: ['auth'] },
    // Business mode wording (Knowledge, Rules & decisions): its own user and organization; needs only the shared stack.
    { name: 'business-terms', testMatch: 'business-terms.spec.ts', dependencies: ['auth'] },
    // Storage connections (Organization settings > Storage): its own user and mock runner; a local folder under the e2e dir.
    { name: 'storage', testMatch: 'storage.spec.ts', dependencies: ['auth'] },
    // Public form files straight from the browser to an https S3 stand-in (presigned PUT), and the local relay: its own
    // user and mock runner.
    { name: 'storage-direct', testMatch: 'storage-direct.spec.ts', dependencies: ['auth'] },
    // Guided deploy setup (v1b): adopts a real throwaway Docker Compose stack (own project name and port, removed at the end).
    { name: 'deploy-setup', testMatch: 'deploy-setup.spec.ts', dependencies: ['auth'] },
    // Guided connect (v2): a REAL sshd in a throwaway container acting as the VPS (removed at the end); own runner and project.
    { name: 'deploy-connect', testMatch: 'deploy-connect.spec.ts', dependencies: ['auth'] },
    // Moving to a new server (v3): TWO real sshd containers (old and new server, each with a fake docker); own runner and project.
    { name: 'deploy-move', testMatch: 'deploy-move.spec.ts', dependencies: ['auth'] },
    // Retiring a workstation with agent handover: its own Owner (paired mock workstations, no runner process), an Admin and a Member.
    { name: 'workstation-retire', testMatch: 'workstation-retire.spec.ts', dependencies: ['auth'] },
    // The Environments redesign (docs/design/environments-ux.md section 12): the page against the real server; the full journeys run
    // with the mocked web app (playwright.environments-msw.config.ts).
    { name: 'environments', testMatch: 'environments.spec.ts', dependencies: ['pairing'] },
    // The deploy-setup journey: a stack outside /opt with a literal tag on a throwaway sshd + fake docker, a real registry container,
    // every update method, a second environment, merge of a DevOps proposal, removal. Own runner and project.
    {
      name: 'journey-containers',
      testMatch: 'journey-containers.setup.ts',
      teardown: 'journey-containers-teardown',
    },
    { name: 'journey-containers-teardown', testMatch: 'journey-containers.teardown.ts' },
    {
      name: 'deploy-setup-journey',
      testMatch: 'deploy-setup-journey.spec.ts',
      dependencies: ['auth', 'journey-containers'],
    },
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
    { name: 'tour', testMatch: 'tour.spec.ts', dependencies: ['installer'] },
    // Journeys (designer, instances, handoffs, the shared record): its own user, organization and project.
    { name: 'journeys', testMatch: 'journeys.spec.ts', dependencies: ['auth'] },
    // Journey waits, gates and webhooks: its own user, project and mock runner; moves the server's test clock by minutes and hours.
    { name: 'journey-waits', testMatch: 'journey-waits.spec.ts', dependencies: ['auth'] },
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

export default NO_DOCKER
  ? { ...config, projects: (config.projects ?? []).filter((p) => !DOCKER_PROJECTS.includes(p.name ?? '')) }
  : config;

/** The `iPhone 15` descriptor on WebKit, or on Chromium when WebKit is not installed (its Linux host libraries are optional). */
function mobileUse() {
  const { defaultBrowserType: _ignored, ...phone } = devices['iPhone 15'];
  return {
    ...phone,
    browserName: process.env.AOM_E2E_WEBKIT === '1' ? ('webkit' as const) : ('chromium' as const),
  };
}
