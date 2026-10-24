import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `crypto.randomUUID` is undefined on a page served over plain HTTP (a LAN address used for testing), so a raw call in
 * browser code crashes the component on mount. Browser code uses `newId()` from lib/secure.ts.
 */
const ROOTS = [join(__dirname, '..'), join(__dirname, '../../../../packages/shared/src')];
const ALLOWED = new Set(['lib/secure.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'test' && name !== 'node_modules') walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('browser code does not call crypto.randomUUID directly', () => {
  it('has no raw crypto.randomUUID outside lib/secure.ts', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const f of walk(root)) {
        const rel = relative(root, f);
        if (ALLOWED.has(rel)) continue;
        if (/\bcrypto\.randomUUID\b|\brandomUUID\s*\(/.test(readFileSync(f, 'utf8'))) offenders.push(f);
      }
    }
    expect(offenders).toEqual([]);
  });
});
