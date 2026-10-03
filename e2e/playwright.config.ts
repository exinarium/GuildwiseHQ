import { defineConfig } from '@playwright/test';

// Skeleton: the e2e lane starts server (4601, aom_test), web preview and a mock-adapter runner in global-setup.ts.
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  use: { baseURL: 'http://localhost:5173' },
});
