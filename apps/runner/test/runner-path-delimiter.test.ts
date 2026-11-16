import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// runner.ts builds PATH lists with `delimiter`; a missing import only shows up at typecheck and at ship time.
describe('runner.ts PATH handling', () => {
  it('imports delimiter from node:path wherever it uses it', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'runner.ts'), 'utf8');
    const usesDelimiter = /\(delimiter\)/.test(src);
    const importLine = src.split('\n').find((l) => l.includes("from 'node:path'")) ?? '';
    expect(usesDelimiter).toBe(true);
    expect(importLine).toMatch(/\bdelimiter\b/);
  });
});
