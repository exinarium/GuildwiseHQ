import { describe, expect, it } from 'vitest';
import { designSizeFlags, parseArgs } from '../src/aom/aom-cli.ts';

const flags = (...argv: string[]) => designSizeFlags(parseArgs(argv, 'design'));

describe('aom design --size --path --risk --seam', () => {
  it('AC1: reads the estimate, the paths, the declared risk and the seams', () => {
    expect(
      flags(
        '--size',
        '640',
        '--path',
        'apps/server/src',
        '--path',
        'apps/web/src/components/Panel.tsx',
        '--risk',
        'medium',
        '--seam',
        'Server: apps/server/src',
        '--seam',
        '[web] Card panel: apps/web/src/components, apps/web/src/lib',
      ),
    ).toEqual({
      estimate: 640,
      paths: ['apps/server/src', 'apps/web/src/components/Panel.tsx'],
      risk: 'medium',
      seams: [
        { title: 'Server', folders: ['apps/server/src'] },
        { title: 'Card panel', folders: ['apps/web/src/components', 'apps/web/src/lib'], repo: 'web' },
      ],
    });
  });
  it('sends nothing when neither --size nor --path is given', () => {
    expect(flags('--report', 'docs/x.md')).toBeUndefined();
  });
  it('refuses a size that is not a whole number, or a path without a size', () => {
    expect(() => flags('--size', '12.5', '--path', 'a/b')).toThrow(/whole number/);
    expect(() => flags('--size', '-3')).toThrow(/whole number/);
    expect(() => flags('--path', 'a/b')).toThrow(/--size/);
  });
  it('refuses an unknown risk and a seam without the "<title>: <folder>" form', () => {
    expect(() => flags('--size', '1', '--risk', 'extreme')).toThrow(/low, medium or high/);
    expect(() => flags('--size', '1', '--seam', 'Server apps/server')).toThrow(/<title>: <folder>/);
  });
});
