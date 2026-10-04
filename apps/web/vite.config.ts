import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const target = 'http://127.0.0.1:4600';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false, ws: true },
      '/ws': { target, changeOrigin: false, ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: false,
    css: false,
    // jsdom renders are CPU-bound and the packages' suites run side by side: the 5 s default is a guess at an idle
    // machine, not a property of the tests (they wait on conditions, never on fixed sleeps).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
