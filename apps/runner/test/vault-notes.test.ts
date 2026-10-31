import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countVaultNotes, noteCountField } from '../src/vaults/notes.ts';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vault-notes-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const put = (rel: string, body = '# x') => {
  const f = join(root, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, body);
};

describe('countVaultNotes', () => {
  it('does not count files the system writes itself', () => {
    for (const f of [
      'standing-orders.md',
      'org/graph/drafts.md',
      '.git/x.md',
      'p/graph/a.md',
      'delivery/r.md',
      'p/taste.md',
      'p/decisions/x.md',
      'p/docs/x.md',
      'org/docs/x.md',
      'p/PROJECT.md',
      'readme.txt',
    ])
      put(f);
    expect(countVaultNotes(root)).toBe(0);
  });

  it('counts a note the user wrote, in any folder, case-insensitively', () => {
    put('standing-orders.md');
    put('notes/a.md');
    put('p/deep/b.MD');
    expect(countVaultNotes(root)).toBe(2);
  });

  it('does not follow symlinks', () => {
    const outside = mkdtempSync(join(tmpdir(), 'vault-outside-'));
    try {
      writeFileSync(join(outside, 'z.md'), 'z');
      symlinkSync(outside, join(root, 'link'));
      symlinkSync(join(outside, 'z.md'), join(root, 'z.md'));
      expect(countVaultNotes(root)).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('stops at the cap', () => {
    for (let i = 0; i < 5; i++) put(`n${i}.md`);
    expect(countVaultNotes(root, 3)).toBe(3);
  });

  it('returns undefined for an unreadable folder, and the report then leaves the count out', () => {
    const missing = join(root, 'nope');
    expect(countVaultNotes(missing)).toBeUndefined();
    expect(noteCountField(missing)).toEqual({});
    put('a.md');
    expect(noteCountField(root)).toEqual({ noteCount: 1 });
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    expect(noteCountField(root)).toEqual({ noteCount: 0 });
  });
});
