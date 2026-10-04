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
  // `yaml` (a dependency of @aom/shared, bundled in) is CommonJS and calls `require`: give the ESM bundle one.
  banner: { js: "import { createRequire as __aomCreateRequire } from 'node:module'; const require = __aomCreateRequire(import.meta.url);" },
  // Several deps (commander, ws, execa) are CJS/ESM mixes: keep them external, they are runtime dependencies.
});
