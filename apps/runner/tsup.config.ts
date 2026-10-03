import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'aom-runner': 'src/cli.ts',
    aom: 'src/aom/aom-cli.ts',
    'mock-agent': 'src/adapters/mock-agent.ts',
  },
  format: ['esm'],
  outDir: 'dist',
  target: 'node22',
  platform: 'node',
  clean: true,
  noExternal: ['@aom/shared'],
  outExtension: () => ({ js: '.mjs' }),
  // Several deps (commander, ws, execa) are CJS/ESM mixes: keep them external, they are runtime dependencies.
});
