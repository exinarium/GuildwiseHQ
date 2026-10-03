import { defineConfig } from 'vitest/config';

const TEST_DB = 'postgres://aom:aom@127.0.0.1:5433/aom_test';
// globalSetup runs in the main process: tests must only ever touch aom_test.
process.env.DATABASE_URL = TEST_DB;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    // All suites share the aom_test database; run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      // Tests must only ever touch aom_test.
      DATABASE_URL: TEST_DB,
      AOM_PUBLIC_ORIGIN: 'http://aom.test',
      AOM_RATE_LIMIT: 'false',
      LOG_LEVEL: process.env.TEST_LOG ? 'info' : 'silent',
    },
  },
});
