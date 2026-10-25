import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vitest/config';
import { BRAND } from './src/brand.ts';

// AOM_API_TARGET points the dev proxy at another server (the screenshot harness uses the seeded demo world).
const target = process.env.AOM_API_TARGET ?? 'http://127.0.0.1:4600';
const headers = process.env.AOM_API_TARGET ? { Origin: target } : undefined;

/** What "Contact us" tells support about the build: the package version and the commit (APP_VERSION_SHA in a Docker build, where there is no .git). */
const appVersion = (): string => {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  let sha = process.env.APP_VERSION_SHA ?? '';
  if (!sha)
    try {
      sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
    } catch {
      sha = 'dev';
    }
  return `${pkg.version}+${sha}`;
};

/** index.html cannot import TS: the brand constants are substituted here so a rename stays one edit. */
const brandHtml = (): Plugin => ({
  name: 'brand-html',
  transformIndexHtml: (html) =>
    html
      .replaceAll('%BRAND_NAME%', BRAND.name)
      .replaceAll('%BRAND_DESCRIPTOR%', BRAND.descriptor)
      .replaceAll('%BRAND_DOMAIN%', BRAND.domain),
});

const webRoot = fileURLToPath(new URL('.', import.meta.url));

/**
 * A hosted build adds its own web extension (src/extension/types.ts): `AOM_WEB_EXTENSION` names the module that default-exports
 * it. Its directory is added to Tailwind's sources, so the classes it uses are generated too. Unset: no extension.
 */
const extensionEntry = process.env.AOM_WEB_EXTENSION ? resolve(process.env.AOM_WEB_EXTENSION) : null;
const extensionAlias = extensionEntry ?? resolve(webRoot, 'src/extension/none.ts');
const extensionSources = (): Plugin => ({
  name: 'web-extension-sources',
  enforce: 'pre',
  transform(code, id) {
    if (!extensionEntry || !/\/src\/index\.css($|\?)/.test(id)) return null;
    return `${code}\n@source "${dirname(extensionEntry)}";\n`;
  },
});

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: [extensionSources(), react(), tailwindcss(), brandHtml()],
  resolve: { alias: { '@aom/web-extension': extensionAlias } },
  build: { rollupOptions: { input: { main: resolve(webRoot, 'index.html') } } },
  server: {
    port: Number(process.env.AOM_WEB_PORT ?? 5173),
    proxy: {
      '/api': { target, changeOrigin: false, ws: true, ...(headers ? { headers } : {}) },
      '/ws': { target, changeOrigin: false, ws: true, ...(headers ? { headers } : {}) },
      // The public blog is rendered by the server (it changes every few hours; the landing page is prerendered).
      '^/blog(/|$)': { target, changeOrigin: false },
      '/sitemap.xml': { target, changeOrigin: false },
      '/robots.txt': { target, changeOrigin: false },
      // The help videos are served by the media container, through the app server (AOM_MEDIA_URL).
      '/videos': { target, changeOrigin: false },
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
