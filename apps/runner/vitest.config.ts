import { defineConfig } from 'vitest/config';

// Mock-agent shifts spawn real processes (the mock agent and the `aom` CLI): give them room when the machine is busy.
export default defineConfig({ test: { include: ['test/**/*.test.ts'], testTimeout: 30_000 } });
