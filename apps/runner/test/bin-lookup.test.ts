import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lookupBin } from '../src/adapters/bin-lookup.ts';
import { binHome } from './bin-home.ts';

const uid = process.geteuid?.() ?? null;

/** `<home>/lib/claude.exe` (the real install) and `<home>/bin/claude` (the PATH link). */
function install(home = binHome(), mode = 0o755): { home: string; real: string; link: string; bin: string } {
  const lib = join(home, 'lib');
  const bin = join(home, 'bin');
  mkdirSync(lib, { recursive: true, mode: 0o755 });
  mkdirSync(bin, { recursive: true, mode: 0o755 });
  const real = join(lib, 'claude.exe');
  writeFileSync(real, '#!/bin/sh\necho hi\n');
  chmodSync(real, mode);
  const link = join(bin, 'claude');
  symlinkSync(real, link);
  return { home, real, link, bin };
}

describe('runner-bare-bin: lookupBin', () => {
  it('a bare name is found on the PATH (first hit) and resolved to its real path', () => {
    const i = install();
    const r = lookupBin('claude', `relative/dir::${join(i.home, 'none')}:${i.bin}:/usr/bin`, { uid });
    expect(r).toEqual({ ok: true, path: i.link, real: i.real });
  });

  it('an absolute name is checked as given', () => {
    const i = install();
    expect(lookupBin(i.link, '', { uid })).toEqual({ ok: true, path: i.link, real: i.real });
  });

  it('a bare name missing from the PATH is refused and the folders are named', () => {
    const i = install();
    const r = lookupBin('claude', join(i.home, 'none'), { uid });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/not found on the runner's PATH .*none/);
  });

  it('a relative path with a slash is refused', () => {
    for (const n of ['./x/claude', 'x/claude', '../claude']) {
      const r = lookupBin(n, '/usr/bin', { uid });
      expect(!r.ok && r.reason).toMatch(/relative path: give an absolute path or a bare name/);
    }
  });

  it('relative and empty PATH entries are skipped (never resolved against the cwd)', () => {
    const i = install();
    const r = lookupBin('claude', `.:bin:`, { uid });
    expect(r.ok).toBe(false);
    void i;
  });

  it('a non-executable first hit is refused, never skipped for a later one', () => {
    const a = install(binHome(), 0o644);
    const b = install();
    const r = lookupBin('claude', `${a.bin}:${b.bin}`, { uid });
    expect(!r.ok && r.reason).toMatch(/not executable/);
  });

  it('a folder or a broken link is refused', () => {
    const h = binHome();
    mkdirSync(join(h, 'bin', 'claude'), { recursive: true });
    expect(lookupBin('claude', join(h, 'bin'), { uid }).ok).toBe(false);
    const h2 = binHome();
    mkdirSync(join(h2, 'bin'));
    symlinkSync(join(h2, 'gone'), join(h2, 'bin', 'claude'));
    const r = lookupBin('claude', join(h2, 'bin'), { uid });
    expect(!r.ok && r.reason).toMatch(/does not exist/);
  });

  it('R2: a hit or a real path under a forbidden root is refused (the link and the target both)', () => {
    const i = install();
    expect(lookupBin('claude', i.bin, { uid, forbiddenRoots: [join(i.home, 'lib')] }).ok).toBe(false);
    expect(lookupBin('claude', i.bin, { uid, forbiddenRoots: [i.bin] }).ok).toBe(false);
    expect(lookupBin('claude', i.bin, { uid, forbiddenRoots: [join(i.home, 'other')] }).ok).toBe(true);
    // a binary in the system tmp
    const t = join(tmpdir(), `aom-bl-${process.pid}`);
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
    const r = lookupBin(join(t, 'claude'), '', { uid, forbiddenRoots: [tmpdir()] });
    expect(!r.ok && r.reason).toMatch(/folder agents or boxes can write/);
  });

  it('R3: a group-writable file or parent folder is refused', () => {
    const i = install();
    chmodSync(join(i.home, 'lib'), 0o775);
    const r = lookupBin('claude', i.bin, { uid });
    expect(!r.ok && r.reason).toMatch(/writable by group or others/);
    chmodSync(join(i.home, 'lib'), 0o755);
    chmodSync(i.bin, 0o777);
    expect(lookupBin('claude', i.bin, { uid }).ok).toBe(false);
    chmodSync(i.bin, 0o755);
    chmodSync(i.real, 0o775);
    expect(lookupBin('claude', i.bin, { uid }).ok).toBe(false);
    chmodSync(i.real, 0o755);
    expect(lookupBin('claude', i.bin, { uid }).ok).toBe(true);
  });

  it.skipIf(uid === null || uid === 0)(
    'R3: the PATH link itself owned by another user is refused (the lstat owner branch)',
    () => {
      const i = install();
      // judged as a different runner uid: the link (lstat) belongs to neither that uid nor root, so the link branch refuses first
      const r = lookupBin('claude', i.bin, { uid: (uid as number) + 1 });
      expect(r).toEqual({ ok: false, reason: `${i.link} belongs to another user` });
      // a root-owned system binary passes the same check (root may own the file and every folder above it)
      expect(lookupBin('true', '/usr/bin', { uid: (uid as number) + 1 })).toMatchObject({
        ok: true,
        path: '/usr/bin/true',
      });
    },
  );

  it.skipIf(uid === null || uid === 0)('R3: a file owned by another user is refused', () => {
    const i = install();
    // the same tree judged as if the runner were a different uid: every entry the test user owns is foreign
    const r = lookupBin('claude', i.bin, { uid: (uid as number) + 1 });
    expect(!r.ok && r.reason).toMatch(/another user/);
  });
});
