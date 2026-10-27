import { lstatSync, mkdirSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureGuildwiseAlias, layoutFor } from '../src/update/layout.ts';
import { cleanupTmp, tmp } from './helpers.ts';

cleanupTmp();

function world() {
  const dir = tmp();
  const root = join(dir, 'runner');
  const pkg = join(root, '0.1.60', 'aom-runner');
  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(pkg, 'aom-runner'), '#!/bin/sh\n');
  symlinkSync(pkg, join(root, 'current'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  return { layout: layoutFor(root, pkg), bin, launcher: join(root, 'current', 'aom-runner') };
}

describe('guildwise-runner alias for existing installs', () => {
  it('adds the link beside the installer made aom-runner link, once', () => {
    const w = world();
    symlinkSync(w.launcher, join(w.bin, 'aom-runner'));
    expect(ensureGuildwiseAlias(w.layout, w.bin)).toBe(true);
    expect(readlinkSync(join(w.bin, 'guildwise-runner'))).toBe(w.launcher);
    expect(ensureGuildwiseAlias(w.layout, w.bin)).toBe(false);
  });
  it('leaves things alone when aom-runner is not the installer link, when the alias exists, or the folder is missing', () => {
    const w = world();
    expect(ensureGuildwiseAlias(w.layout, w.bin)).toBe(false);
    writeFileSync(join(w.bin, 'aom-runner'), 'x');
    expect(ensureGuildwiseAlias(w.layout, w.bin)).toBe(false);
    expect(() => lstatSync(join(w.bin, 'guildwise-runner'))).toThrow();
    expect(ensureGuildwiseAlias(w.layout, join(w.bin, 'nope'))).toBe(false);
  });
  it('does not replace an existing guildwise-runner', () => {
    const w = world();
    symlinkSync(w.launcher, join(w.bin, 'aom-runner'));
    writeFileSync(join(w.bin, 'guildwise-runner'), 'mine');
    expect(ensureGuildwiseAlias(w.layout, w.bin)).toBe(false);
    expect(lstatSync(join(w.bin, 'guildwise-runner')).isSymbolicLink()).toBe(false);
  });
});
