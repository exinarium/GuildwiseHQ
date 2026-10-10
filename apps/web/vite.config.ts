import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createServer, type ResolvedConfig } from 'vite';
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
 * The landing page is its own entry (landing.html: React and the page, none of the app). The server hands it to visitors
 * without a session cookie; this does the same on the dev server so `/` behaves like production.
 */
const landingInDev = (): Plugin => ({
  name: 'landing-in-dev',
  apply: 'serve',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      const [path, query] = (req.url ?? '').split('?');
      if (req.method === 'GET' && (path === '/privacy' || path === '/terms')) req.url = '/legal.html';
      else if (req.method === 'GET' && path === '/' && !/(^|;\s*)aom_sid=/.test(req.headers.cookie ?? ''))
        req.url = `/landing.html${query ? `?${query}` : ''}`;
      next();
    });
  },
});

/**
 * Builds landing.html with its markup already in it (search engines and the first paint get the whole page; React
 * hydrates it). Renders src/landing/render.tsx through a throwaway Vite server once the bundle is written.
 */
const prerenderLanding = (): Plugin => {
  let cfg: ResolvedConfig;
  return {
    name: 'prerender-landing',
    apply: 'build',
    configResolved(c) {
      cfg = c;
    },
    async closeBundle() {
      const server = await createServer({
        configFile: false,
        root: webRoot,
        appType: 'custom',
        logLevel: 'silent',
        plugins: [react()],
        server: { middlewareMode: true },
        optimizeDeps: { noDiscovery: true, include: [] },
      });
      try {
        const mod = (await server.ssrLoadModule('/src/landing/render.tsx')) as { render: () => string };
        const legalMod = (await server.ssrLoadModule('/src/landing/render-legal.tsx')) as {
          renderLegal: (doc: 'privacy' | 'terms') => { html: string; title: string; description: string };
        };
        const file = resolve(cfg.root, cfg.build.outDir, 'landing.html');
        const html = readFileSync(file, 'utf8');
        if (!html.includes('<!--app-html-->') && !html.includes('<div id="root"></div>'))
          throw new Error('landing.html has no mount point to prerender into');
        // the headline font arrives with the markup, so the text does not reflow when it swaps in
        const font = readdirSync(resolve(cfg.root, cfg.build.outDir, 'assets')).find((f) =>
          /^geist-latin-wght-normal-.*\.woff2$/.test(f),
        );
        const preload = font
          ? `<link rel="preload" as="font" type="font/woff2" href="/assets/${font}" crossorigin />`
          : '';
        writeFileSync(
          file,
          html
            .replace('</head>', `${preload}</head>`)
            .replace(/<div id="root">(?:<!--app-html-->)?<\/div>/, `<div id="root">${mod.render()}</div>`),
        );
        // /privacy and /terms: the same shell with the text of src/legal/*.md already in it (the server sends them as static files).
        const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const legalFile = resolve(cfg.root, cfg.build.outDir, 'legal.html');
        const shell = readFileSync(legalFile, 'utf8');
        for (const doc of ['privacy', 'terms'] as const) {
          const r = legalMod.renderLegal(doc);
          writeFileSync(
            resolve(cfg.root, cfg.build.outDir, `${doc}.html`),
            shell
              .replaceAll('%LEGAL_TITLE%', attr(r.title))
              .replaceAll('%LEGAL_DESCRIPTION%', attr(r.description))
              .replaceAll('%LEGAL_PATH%', `/${doc}`)
              .replace('</head>', `${preload}</head>`)
              .replace(/<div id="root">(?:<!--app-html-->)?<\/div>/, `<div id="root">${r.html}</div>`),
          );
        }
        rmSync(legalFile);
      } finally {
        await server.close();
      }
    },
  };
};

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion()) },
  plugins: [react(), tailwindcss(), brandHtml(), landingInDev(), prerenderLanding()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(webRoot, 'index.html'),
        landing: resolve(webRoot, 'landing.html'),
        legal: resolve(webRoot, 'legal.html'),
      },
    },
  },
  server: {
    port: Number(process.env.AOM_WEB_PORT ?? 5173),
    proxy: {
      '/api': { target, changeOrigin: false, ws: true, ...(headers ? { headers } : {}) },
      '/ws': { target, changeOrigin: false, ws: true, ...(headers ? { headers } : {}) },
      // The public blog is rendered by the server (it changes every few hours; the landing page is prerendered).
      '^/blog(/|$)': { target, changeOrigin: false },
      '/sitemap.xml': { target, changeOrigin: false },
      '/robots.txt': { target, changeOrigin: false },
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
