import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GRAMMAR_FILES, grammarDir } from '../src/graph/parse.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('the grammars ship with the runner (design owner decision 7)', () => {
  it('every grammar the indexer loads exists in the pinned package and is copied by the build script', () => {
    const dir = grammarDir();
    const script = readFileSync(join(root, 'scripts', 'copy-grammars.mjs'), 'utf8');
    for (const f of GRAMMAR_FILES) {
      expect(existsSync(join(dir, f)), f).toBe(true);
      expect(script, f).toContain(`'${f}'`);
    }
    expect(existsSync(join(dir, 'tree-sitter.wasm'))).toBe(true);
    expect(script).toContain("'tree-sitter.wasm'");
    expect(script).toContain('tree-sitter.cjs'); // the package is `type: module`: the runtime ships as .cjs
  });

  it('the parser package is pinned exactly and the licences are in the package', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies['@vscode/tree-sitter-wasm']).toMatch(/^\d+\.\d+\.\d+$/);
    const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES'), 'utf8');
    for (const name of [
      'tree-sitter',
      'tree-sitter-typescript',
      'tree-sitter-javascript',
      'tree-sitter-python',
      'tree-sitter-go',
      'tree-sitter-c-sharp',
    ])
      expect(notices, name).toContain(name);
    expect(notices).toContain('Permission is hereby granted, free of charge');
    expect(notices).toContain('Max Brunsfeld');
  });

  it('the release script puts the notices next to the bundle', () => {
    const script = readFileSync(join(root, '..', '..', 'scripts', 'package-runner.sh'), 'utf8');
    expect(script).toContain('THIRD_PARTY_NOTICES');
  });
});
