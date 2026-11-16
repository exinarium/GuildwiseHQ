import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('runner.ts node:path imports', () => {
  it('imports delimiter, which the sandboxed project commands use to build PATH', () => {
    const source = readFileSync(new URL('../src/runner.ts', import.meta.url), 'utf8');
    const match = source.match(/import \{([^}]*)\} from 'node:path';/);
    expect(match).not.toBeNull();
    const names = (match?.[1] ?? '').split(',').map((n) => n.trim());
    if (/\bdelimiter\b/.test(source.replace(match?.[0] ?? '', ''))) {
      expect(names).toContain('delimiter');
    }
  });
});
