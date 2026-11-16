import { describe, expect, it } from 'vitest';
import {
  cleanWorkerVersion,
  VideoStatusSchema,
  WORKER_OUTDATED_LIKE,
  workerOutdated,
  workerOutdatedMessage,
} from '../src/index.ts';

describe('workerOutdated', () => {
  it('flags an older worker', () => {
    expect(workerOutdated('1.5.0', '1.9.0')).toBe(true);
    expect(workerOutdated('1.9.0-rc.1', '1.9.0')).toBe(true);
  });

  it('flags a worker without a version or with a non-semver one', () => {
    expect(workerOutdated(null, '1.9.0')).toBe(true);
    expect(workerOutdated(undefined, '1.9.0')).toBe(true);
    expect(workerOutdated('', '1.9.0')).toBe(true);
    expect(workerOutdated('latest', '1.9.0')).toBe(true);
  });

  it('does not flag an equal or newer worker', () => {
    expect(workerOutdated('1.9.0', '1.9.0')).toBe(false);
    expect(workerOutdated('2.1.0', '1.9.0')).toBe(false);
    expect(workerOutdated('1.10.0', '1.9.0')).toBe(false);
  });

  it('accepts a v prefix and ignores build metadata', () => {
    expect(workerOutdated('v1.9.0', '1.9.0')).toBe(false);
    expect(workerOutdated('1.9.0+abc', '1.9.0')).toBe(false);
    expect(workerOutdated('v1.8.0', '1.9.0')).toBe(true);
  });

  it('flags nobody while the server version is unknown', () => {
    expect(workerOutdated('1.5.0', null)).toBe(false);
    expect(workerOutdated(null, undefined)).toBe(false);
    expect(workerOutdated(null, 'unknown')).toBe(false);
  });
});

describe('cleanWorkerVersion', () => {
  it('keeps a plain version, trimmed', () => {
    expect(cleanWorkerVersion(' 1.9.0 ')).toBe('1.9.0');
    expect(cleanWorkerVersion('1.9.0-rc.1+build.5')).toBe('1.9.0-rc.1+build.5');
  });

  it('turns anything else into no version', () => {
    expect(cleanWorkerVersion(undefined)).toBeNull();
    expect(cleanWorkerVersion(null)).toBeNull();
    expect(cleanWorkerVersion(190)).toBeNull();
    expect(cleanWorkerVersion(['1.9.0'])).toBeNull();
    expect(cleanWorkerVersion('')).toBeNull();
    expect(cleanWorkerVersion('1.9.0; rm -rf')).toBeNull();
    expect(cleanWorkerVersion('9'.repeat(61))).toBeNull();
  });
});

describe('workerOutdatedMessage', () => {
  it('names both versions and what to do', () => {
    expect(workerOutdatedMessage('1.5.0', '1.9.0')).toBe(
      'video worker 1.5.0 is older than server 1.9.0; update the worker',
    );
    expect(workerOutdatedMessage(null, '1.9.0')).toContain('video worker (no version) is older than server 1.9.0');
  });

  it('matches the LIKE pattern used to find refused renders', () => {
    const re = new RegExp(`^${WORKER_OUTDATED_LIKE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')}`);
    expect(re.test(workerOutdatedMessage('1.5.0', '1.9.0'))).toBe(true);
    expect(re.test(workerOutdatedMessage(null, '1.9.0'))).toBe(true);
  });
});

describe('VideoStatusSchema worker versions', () => {
  it('parses per-role version, outdated and serverVersion, and stays optional', () => {
    const shape = VideoStatusSchema.shape;
    expect(
      shape.render.parse({ running: true, lastSeen: null, version: '1.5.0', outdated: true }),
    ).toMatchObject({ version: '1.5.0', outdated: true });
    expect(shape.render.parse({ running: true, lastSeen: null })).toEqual({ running: true, lastSeen: null });
    expect(shape.serverVersion.parse(undefined)).toBeUndefined();
    expect(shape.serverVersion.parse('1.9.0')).toBe('1.9.0');
  });
});
