import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';
import { BRAND } from './src/brand.ts';

// AOM_API_TARGET points the dev proxy at another server (the screenshot harness uses the seeded demo world).
const target = process.env.AOM_API_TARGET ?? 'http://127.0.0.1:4600';
const headers = process.env.AOM_API_TARGET ? { Origin: target } : undefined;

/** index.html cannot import TS: the brand constants are substituted here so a rename stays one edit. */
const brandHtml = (): Plugin => ({
  name: 'brand-html',
  transformIndexHtml: (html) =>
    html.replaceAll('%BRAND_NAME%', BRAND.name).replaceAll('%BRAND_DESCRIPTOR%', BRAND.descriptor),
});

export default defineConfig({
  plugins: [react(), tailwindcss(), brandHtml()],
  server: {
    port: Number(process.env.AOM_WEB_PORT ?? 5173),
    proxy: {
      '/api': { target, changeOrigin: false, ws: true, ...(headers ? { headers } : {}) },
      '/ws': { target, changeOrigin: false, ws: true, ...(headers ? { headers } : {}) },
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
