import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('web unit-test environment', () => {
  it('runs on the jsdom major the web package declares', () => {
    expect(navigator.userAgent).toMatch(/jsdom\/31\./);
  });

  it('declares the multi-page build inputs with rolldownOptions, not the deprecated rollupOptions', () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../vite.config.ts'), 'utf8');
    expect(source).toMatch(/rolldownOptions:\s*{\s*input:\s*{\s*main:[^}]*form:/);
    expect(source).not.toMatch(/rollupOptions/);
  });
});
