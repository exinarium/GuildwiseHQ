import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type LinkOps, neutraliseOutsideSymlinks, nodeLinkOps } from '../src/review/symlink-guard.ts';
import { cleanupTmp, tmp } from './helpers.ts';

afterEach(() => cleanupTmp());

const MARKER = 'OUTSIDE-MARKER-7f3a';

function setup() {
  const base = realpathSync(tmp());
  const outside = join(base, 'outside');
  mkdirSync(join(outside, 'dir'), { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), MARKER);
  writeFileSync(join(outside, 'dir', 'f.txt'), MARKER);
  const root = join(base, 'co');
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(join(root, 'docs', 'v2'), { recursive: true });
  mkdirSync(join(root, 'sub'), { recursive: true });
  writeFileSync(join(root, 'docs', 'v2', 'index.md'), 'in tree');
  writeFileSync(join(root, 'a.txt'), 'a');
  return { base, outside, root };
}

const isLink = (p: string) => lstatSync(p).isSymbolicLink();

describe('neutraliseOutsideSymlinks', () => {
  it('replaces absolute, relative, chain, directory and dangling outside links; keeps in-tree ones', () => {
    const { outside, root } = setup();
    const secret = join(outside, 'secret.txt');
    symlinkSync(secret, join(root, 'abs-link'));
    mkdirSync(join(root, 'deep'));
    symlinkSync(`${'../'.repeat(40)}${secret.slice(1)}`, join(root, 'deep', 'rel-link'));
    mkdirSync(join(root, 'chain'));
    symlinkSync('b', join(root, 'chain', 'a'));
    symlinkSync(secret, join(root, 'chain', 'b'));
    symlinkSync(join(outside, 'dir'), join(root, 'outside-dir'));
    symlinkSync(join(outside, 'missing.txt'), join(root, 'gone-outside'));
    symlinkSync('v2', join(root, 'docs', 'latest'));
    symlinkSync('a.txt', join(root, 'link-to-a'));
    symlinkSync('does-not-exist.txt', join(root, 'gone-inside'));
    symlinkSync('.', join(root, 'self'));

    const done = neutraliseOutsideSymlinks(root);
    expect(done.map((d) => d.path)).toEqual([
      'abs-link',
      'chain/a',
      'chain/b',
      'deep/rel-link',
      'gone-outside',
      'outside-dir',
    ]);
    expect(done.find((d) => d.path === 'abs-link')?.linkText).toBe(secret);
    for (const d of done) {
      const p = join(root, d.path);
      expect(lstatSync(p).isFile()).toBe(true);
      expect(readFileSync(p, 'utf8')).not.toContain(MARKER);
      expect(readFileSync(p, 'utf8')).toContain('removed by the review checkout');
      expect(lstatSync(p).mode & 0o222).toBe(0);
    }
    expect(() => readdirSync(join(root, 'outside-dir'))).toThrow(/ENOTDIR/);
    expect(isLink(join(root, 'docs', 'latest'))).toBe(true);
    expect(readFileSync(join(root, 'docs', 'latest', 'index.md'), 'utf8')).toBe('in tree');
    expect(readFileSync(join(root, 'link-to-a'), 'utf8')).toBe('a');
    expect(readlinkSync(join(root, 'gone-inside'))).toBe('does-not-exist.txt');
    expect(isLink(join(root, 'self'))).toBe(true);
  });

  it('judges a chain whose first hop is in tree and second hop leaves the tree', () => {
    const { outside, root } = setup();
    symlinkSync(join(outside, 'secret.txt'), join(root, 'hop2'));
    symlinkSync('hop2', join(root, 'hop1'));
    const done = neutraliseOutsideSymlinks(root);
    expect(done.map((d) => d.path)).toEqual(['hop1', 'hop2']);
  });

  it('replaces a loop without hanging', () => {
    const { root } = setup();
    symlinkSync('b', join(root, 'a'));
    symlinkSync('a', join(root, 'b'));
    expect(neutraliseOutsideSymlinks(root).map((d) => d.path)).toEqual(['a', 'b']);
  });

  it('judges links that go through an in-tree directory link by the real path', () => {
    const { outside, root } = setup();
    symlinkSync('sub', join(root, 'd'));
    // d/../../outside/secret.txt: d is sub, so .. is the root, .. again is the parent of the root
    symlinkSync('d/../../outside/secret.txt', join(root, 'x'));
    symlinkSync('d/../a.txt', join(root, 'y'));
    const done = neutraliseOutsideSymlinks(root);
    expect(done.map((d) => d.path)).toEqual(['x']);
    expect(readFileSync(join(root, 'y'), 'utf8')).toBe('a');
    expect(outside).toBeTruthy();
  });

  it('keeps in-tree links when the root is reached through a symlinked parent', () => {
    const { base, root } = setup();
    symlinkSync('a.txt', join(root, 'ok'));
    symlinkSync(base, join(base, 'via'));
    const done = neutraliseOutsideSymlinks(join(base, 'via', 'co'));
    expect(done).toEqual([]);
    expect(isLink(join(root, 'ok'))).toBe(true);
  });

  it('does not look at the root .git', () => {
    const { outside, root } = setup();
    symlinkSync(join(outside, 'secret.txt'), join(root, '.git', 'link'));
    expect(neutraliseOutsideSymlinks(root)).toEqual([]);
  });

  it('throws when a directory cannot be listed or a link cannot be replaced, and names no target', () => {
    const { outside, root } = setup();
    symlinkSync(join(outside, 'secret.txt'), join(root, 'bad'));
    const unlinkFails: LinkOps = {
      ...nodeLinkOps,
      unlink: () => {
        throw Object.assign(new Error('x'), { code: 'EACCES' });
      },
    };
    expect(() => neutraliseOutsideSymlinks(root, unlinkFails)).toThrow(/EACCES at "bad"/);
    const readdirFails: LinkOps = {
      ...nodeLinkOps,
      readdir: () => {
        throw Object.assign(new Error('x'), { code: 'EIO' });
      },
    };
    expect(() => neutraliseOutsideSymlinks(root, readdirFails)).toThrow(/EIO/);
    const writeFails: LinkOps = {
      ...nodeLinkOps,
      writePlaceholder: () => {
        throw Object.assign(new Error('x'), { code: 'EEXIST' });
      },
    };
    try {
      neutraliseOutsideSymlinks(root, writeFails);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain(MARKER);
      expect(String(e)).not.toContain('secret.txt');
    }
  });

  it('does nothing and returns an empty list for a tree without links', () => {
    const { root } = setup();
    expect(neutraliseOutsideSymlinks(root)).toEqual([]);
  });
});
