import { defineConfig } from 'vitest/config';

// The server lane adds `globalSetup` here (migrates aom_test) and DB-backed tests.
export default defineConfig({ test: { include: ['test/**/*.test.ts'] } });
