import { defineConfig } from 'tsup';

// Single ESM bundle `dist/main.mjs`; @aom/shared is TypeScript source and is bundled in.
// SQL migrations are read at runtime from `../migrations` (or AOM_MIGRATIONS_DIR).
export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  target: 'node22',
  noExternal: [/^@aom\//],
  outExtension: () => ({ js: '.mjs' }),
  clean: true,
  sourcemap: true,
});
