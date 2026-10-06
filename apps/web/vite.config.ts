import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';
import { BRAND } from './src/brand.ts';

const target = 'http://127.0.0.1:4600';

/** index.html cannot import TS: the brand constants are substituted here so a rename stays one edit. */
const brandHtml = (): Plugin => ({
  name: 'brand-html',
  transformIndexHtml: (html) =>
    html.replaceAll('%BRAND_NAME%', BRAND.name).replaceAll('%BRAND_DESCRIPTOR%', BRAND.descriptor),
});

export default defineConfig({
  plugins: [react(), tailwindcss(), brandHtml()],
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
