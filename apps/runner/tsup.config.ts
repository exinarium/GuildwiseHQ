import { defineConfig } from 'tsup';

const shared = {
  format: ['esm'] as const,
  outDir: 'dist',
  target: 'node22' as const,
  platform: 'node' as const,
  outExtension: () => ({ js: '.mjs' }),
  // `yaml` (a dependency of @aom/shared, bundled in) is CommonJS and calls `require`: give the ESM bundle one.
  banner: {
    js: "import { createRequire as __aomCreateRequire } from 'node:module'; const require = __aomCreateRequire(import.meta.url);",
  },
};

export default defineConfig([
  {
    ...shared,
    entry: { 'aom-runner': 'src/cli.ts', 'mock-agent': 'src/adapters/mock-agent.ts' },
    clean: true,
    noExternal: ['@aom/shared'],
    // Several deps (commander, ws, execa) are CJS/ESM mixes: keep them external, they are runtime dependencies.
  },
  {
    ...shared,
    // `aom` is what agents run. A call with a pipe, redirect, `;` or `cd` stays inside Claude Code's shell sandbox,
    // where node_modules under /home is unreadable: bundle every dependency so the file stands alone.
    entry: { aom: 'src/aom/aom-cli.ts' },
    clean: false,
    noExternal: [/.*/],
  },
]);
