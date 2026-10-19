// Copies the tree-sitter runtime and the grammars the project graph indexer needs into `dist/grammars/`, together with
// THIRD_PARTY_NOTICES, so the release tarball (scripts/package-runner.sh copies `dist/`) ships them
// (docs/design/project-graphs.md owner decision 7). The package is a pinned devDependency: nothing is fetched at install.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(join(root, 'package.json'));
const wasm = join(dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
const out = join(root, 'dist', 'grammars');
mkdirSync(out, { recursive: true });
// The runtime is a CommonJS (UMD) file. The runner package is `type: module`, which would make a `.js` file here an ES
// module (and break the runtime's `__filename` lookup), so it ships as `.cjs`.
const files = [
  'tree-sitter.wasm',
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-c-sharp.wasm',
];
for (const f of files) {
  if (!existsSync(join(wasm, f))) throw new Error(`grammar asset missing: ${join(wasm, f)}`);
  copyFileSync(join(wasm, f), join(out, f));
}
copyFileSync(join(wasm, 'tree-sitter.js'), join(out, 'tree-sitter.cjs'));
copyFileSync(join(root, 'THIRD_PARTY_NOTICES'), join(root, 'dist', 'THIRD_PARTY_NOTICES'));
console.log(`copied ${files.length + 1} grammar assets and THIRD_PARTY_NOTICES to dist/`);
