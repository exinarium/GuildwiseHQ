import { defineConfig, devices } from '@playwright/test';

/**
 * The Environments journeys (tests/environments.spec.ts) against the web app with its in-browser mock server: no backend, no
 * Docker, no runner. `pnpm exec playwright test -c playwright.environments-msw.config.ts` (from e2e/). Chromium only.
 */
const PORT = Number(process.env.AOM_E2E_MSW_PORT ?? 5188);
process.env.AOM_E2E_MSW = '1';
process.env.AOM_E2E_MSW_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests',
  testMatch: 'environments.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'environments-msw' }],
  webServer: {
    command: `pnpm --filter @aom/web exec vite --host 127.0.0.1 --port ${PORT} --strictPort`,
    cwd: '..',
    url: `http://127.0.0.1:${PORT}/login`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: { VITE_MSW: '1', AOM_WEB_PORT: String(PORT) },
  },
});
