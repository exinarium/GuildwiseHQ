import { describe, expect, it } from 'vitest';
import { compareVersions, isNewer, parseVersion } from '../src/update/semver.ts';

describe('version comparison', () => {
  it('compares numerically, not as text', () => {
    expect(isNewer('0.1.10', '0.1.9')).toBe(true);
    expect(isNewer('0.1.9', '0.1.10')).toBe(false);
    expect(isNewer('1.0.0', '0.99.99')).toBe(true);
    expect(isNewer('0.2.0', '0.1.99')).toBe(true);
  });

  it('is not newer when equal or older', () => {
    expect(isNewer('0.1.1', '0.1.1')).toBe(false);
    expect(isNewer('0.1.0', '0.1.1')).toBe(false);
    expect(compareVersions('0.1.1', '0.1.1')).toBe(0);
  });

  it('puts a pre-release below its release and orders pre-releases', () => {
    expect(isNewer('1.0.0', '1.0.0-rc.1')).toBe(true);
    expect(isNewer('1.0.0-rc.1', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0-rc.2', '1.0.0-rc.1')).toBe(true);
    expect(isNewer('1.0.0-rc.10', '1.0.0-rc.9')).toBe(true);
    expect(isNewer('1.0.0-beta', '1.0.0-alpha')).toBe(true);
    expect(isNewer('1.0.0-rc.1', '1.0.0-rc')).toBe(true);
  });

  it('ignores build metadata and a leading v', () => {
    expect(compareVersions('v0.1.1+abc', '0.1.1')).toBe(0);
    expect(parseVersion('0.1.1')?.core).toEqual([0, 1, 1]);
  });

  it('never calls garbage newer', () => {
    expect(isNewer('latest', '0.1.0')).toBe(false);
    expect(isNewer('0.1', '0.1.0')).toBe(false);
    expect(isNewer('', '0.1.0')).toBe(false);
    expect(() => compareVersions('x', '0.1.0')).toThrow();
  });
});
