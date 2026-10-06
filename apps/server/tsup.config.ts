import { defineConfig } from 'tsup';

// ESM bundles `dist/main.mjs` (server) and `dist/admin-create.mjs`, `dist/superadmin-create.mjs`, `dist/superadmin-reset-password.mjs` and `dist/orgs-migrate.mjs` (the CLI scripts for the image); @aom/shared is TypeScript source and is bundled in.
// SQL migrations are read at runtime from `../migrations` (or AOM_MIGRATIONS_DIR).
export default defineConfig({
  entry: {
    main: 'src/main.ts',
    'admin-create': 'scripts/admin-create.ts',
    'superadmin-create': 'scripts/superadmin-create.ts',
    'superadmin-reset-password': 'scripts/superadmin-reset-password.ts',
    'orgs-migrate': 'scripts/orgs-migrate.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  target: 'node22',
  noExternal: [/^@aom\//],
  outExtension: () => ({ js: '.mjs' }),
  // `yaml` (a dependency of @aom/shared, bundled in) is CommonJS and calls `require`: give the ESM bundle one.
  banner: {
    js: "import { createRequire as __aomCreateRequire } from 'node:module'; const require = __aomCreateRequire(import.meta.url);",
  },
  clean: true,
  sourcemap: true,
});
