import { describe, expect, it } from 'vitest';
import { hashCapabilityFiles, parseTomlLite, shimBmadText, tomlString } from '../src/index.ts';

describe('toml-lite and shim hardening', () => {
  it('does not pollute Object.prototype through a table path or key', () => {
    const t = parseTomlLite(
      '[__proto__]\npolluted = "yes"\n[a.constructor]\nx = 1\n__proto__ = "x"\n[[prototype]]\ny=2',
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(t, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(t)).toBeNull();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
  it('survives hostile input quickly and without throwing', () => {
    const t0 = Date.now();
    parseTomlLite(`[${' '.repeat(20000)}x`);
    parseTomlLite(`[${' '.repeat(20000)}x]${' '.repeat(20000)}y`);
    parseTomlLite('a = "\\UFFFFFFFF \\ud800"\n');
    expect(tomlString(parseTomlLite('a = "\\UFFFFFFFF"').a)).toBe('\uFFFD');
    parseTomlLite(`a = ${'['.repeat(50000)}`);
    parseTomlLite(`${'[['.repeat(5000)}x`);
    const deep = parseTomlLite(`[${Array.from({ length: 30 }, (_, i) => `k${i}`).join('.')}]\nz=1`);
    expect(JSON.stringify(deep)).not.toContain('"z"');
    shimBmadText(`#${' '.repeat(50000)}x ${' '.repeat(50000)}.`, { pack: 'p', known: new Set() });
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('hashes ambiguous file sets differently', () => {
    expect(hashCapabilityFiles({ a: 'b\u0000c' })).not.toBe(hashCapabilityFiles({ 'a\u0000b': 'c' }));
    expect(hashCapabilityFiles({ a: 'x\u0001b\u0000y' })).not.toBe(hashCapabilityFiles({ a: 'x', b: 'y' }));
  });
});
