import { delimiter } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolchainPathDirs, toolchainPathValue } from '../src/toolchain/path-env.ts';

describe('toolchainPathValue', () => {
  it('puts the toolchain directories ahead of the parent PATH, joined with the platform delimiter', () => {
    expect(toolchainPathValue(['/tc/node/bin', '/tc/pnpm'], ['/usr/bin', '/bin'].join(delimiter))).toBe(
      ['/tc/node/bin', '/tc/pnpm', '/usr/bin', '/bin'].join(delimiter),
    );
  });

  it('keeps the toolchain directories when there is no parent PATH', () => {
    expect(toolchainPathValue(['/tc/node/bin'], undefined)).toBe(`/tc/node/bin${delimiter}`);
  });
});

describe('toolchainPathDirs', () => {
  it('lists the toolchain directories, then each parent PATH entry split on the platform delimiter', () => {
    expect(toolchainPathDirs(['/tc/node/bin'], ['/usr/bin', '/bin'].join(delimiter))).toEqual([
      '/tc/node/bin',
      '/usr/bin',
      '/bin',
    ]);
  });

  it('handles a missing parent PATH', () => {
    expect(toolchainPathDirs(['/tc/node/bin'], undefined)).toEqual(['/tc/node/bin', '']);
  });
});
