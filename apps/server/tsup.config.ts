import { defineConfig } from 'tsup';

// ESM bundles `dist/main.mjs` (server) and `dist/admin-create.mjs`, `dist/superadmin-create.mjs`, `dist/superadmin-reset-password.mjs` `dist/orgs-migrate.mjs`, `dist/restructure-migrate.mjs` `dist/ranking-migrate.mjs`, `dist/ledger-cleanup.mjs` and `dist/deploy-reset.mjs` (the CLI scripts for the image); @aom/shared is TypeScript source and is bundled in.
// SQL migrations are read at runtime from `../migrations` (or AOM_MIGRATIONS_DIR).
export default defineConfig({
  entry: {
    main: 'src/main.ts',
    'admin-create': 'scripts/admin-create.ts',
    'superadmin-create': 'scripts/superadmin-create.ts',
    'superadmin-reset-password': 'scripts/superadmin-reset-password.ts',
    'orgs-migrate': 'scripts/orgs-migrate.ts',
    'restructure-migrate': 'scripts/restructure-migrate.ts',
    'ranking-migrate': 'scripts/ranking-migrate.ts',
    'ledger-cleanup': 'scripts/ledger-cleanup-2026-10.ts',
    'deploy-reset': 'scripts/deploy-reset.ts',
    'vapid-generate': 'scripts/vapid-generate.ts',
    'video-worker': 'src/video-worker.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  target: 'node22',
  noExternal: [/^@aom\//],
  // Playwright is loaded at runtime by the video worker (a dependency of the server package, so tsup keeps it external anyway).
  external: ['playwright-core'],
  outExtension: () => ({ js: '.mjs' }),
  // `yaml` (a dependency of @aom/shared, bundled in) is CommonJS and calls `require`: give the ESM bundle one.
  banner: {
    js: "import { createRequire as __aomCreateRequire } from 'node:module'; const require = __aomCreateRequire(import.meta.url);",
  },
  clean: true,
  sourcemap: true,
  // The assistant's knowledge pack is a committed text file too (src/assistant/pack, built by `assistant:pack`).
  // The release notes (CHANGELOG.md, What's New) and the video library manifest are copied by the package "build" script:
  // tsup's onSuccess runner mangled those steps (CHANGELOG.md came out as an empty directory).
  // The installer scripts are real files (lintable) read at runtime: ship them beside the bundle.
  onSuccess:
    'rm -rf dist/installer-templates && cp -r src/installer/templates dist/installer-templates && rm -rf dist/assistant-pack && cp -r src/assistant/pack dist/assistant-pack && rm -rf dist/blog-launch && cp -r src/blog/launch dist/blog-launch',
});
