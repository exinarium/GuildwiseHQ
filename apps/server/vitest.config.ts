import { defineConfig } from 'vitest/config';

// A handoff check gives each unit run an id (AOM_TEST_RUN_ID): that run gets a database of its own, aom_test_<id>, which
// test/global-setup.ts creates and drops, so concurrent runs never share test data. An explicit AOM_TEST_DB_URL still wins.
const RUN_ID = /^[a-z0-9]{1,40}$/.test(process.env.AOM_TEST_RUN_ID ?? '')
  ? process.env.AOM_TEST_RUN_ID
  : undefined;
const TEST_DB =
  process.env.AOM_TEST_DB_URL ?? `postgres://aom:aom@127.0.0.1:5433/aom_test${RUN_ID ? `_${RUN_ID}` : ''}`;
// globalSetup runs in the main process: tests must only ever touch aom_test.
process.env.DATABASE_URL = TEST_DB;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // All suites share the aom_test database; run files one at a time.
    fileParallelism: false,
    // The shared CI runners are several times slower than a developer machine: the long multi-turn session tests
    // (a boardroom with several seats, intake batches) need more room there. Failures still fail, only later.
    testTimeout: process.env.CI ? 120_000 : 30_000,
    hookTimeout: process.env.CI ? 120_000 : 30_000,
    env: {
      // Tests must only ever touch aom_test.
      DATABASE_URL: TEST_DB,
      AOM_PUBLIC_ORIGIN: 'http://aom.test',
      AOM_RATE_LIMIT: 'false',
      // Most suites script the mock runtime through card fields; the flag-off behaviour has its own test.
      AOM_MOCK_UI: 'true',
      // Suites written for the code workflow keep it as the default of a new project; the lean team suites keep code v6 active (createTestApp lean: true).
      AOM_DEFAULT_WORKFLOW: 'code',
      // Project graphs are a feature of their own tests: the other suites keep projects without an automatic local vault.
      AOM_PROJECT_GRAPHS: 'false',
      LOG_LEVEL: process.env.TEST_LOG ? 'info' : 'silent',
    },
  },
});
