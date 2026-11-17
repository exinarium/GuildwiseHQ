import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('runner.ts node:path imports', () => {
  it('imports delimiter from node:path because it uses it', () => {
    const src = readFileSync(new URL('../src/runner.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/\bjoin\(delimiter\)|split\(delimiter\)/);
    const pathImport = src.match(/import\s*\{([^}]*)\}\s*from\s*'node:path'/);
    expect(pathImport).not.toBeNull();
    const names = pathImport![1]!.split(',').map((s) => s.trim());
    expect(names).toContain('delimiter');
  });
});
