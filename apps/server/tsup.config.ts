import { defineConfig } from 'tsup';

// ESM bundles `dist/main.mjs` (server) and `dist/admin-create.mjs` (first-admin script for the image); @aom/shared is TypeScript source and is bundled in.
// SQL migrations are read at runtime from `../migrations` (or AOM_MIGRATIONS_DIR).
export default defineConfig({
  entry: { main: 'src/main.ts', 'admin-create': 'scripts/admin-create.ts' },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  target: 'node22',
  noExternal: [/^@aom\//],
  outExtension: () => ({ js: '.mjs' }),
  clean: true,
  sourcemap: true,
});
