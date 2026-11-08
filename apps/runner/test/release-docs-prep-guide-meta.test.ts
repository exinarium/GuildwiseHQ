import { describe, expect, it } from 'vitest';
import { guidePdfMeta } from '../src/git/release-docs-prep-guide.ts';

describe('guidePdfMeta', () => {
  const now = new Date('2026-11-09T10:00:00Z');
  it('prefers the release date, then the run date, then today', () => {
    expect(guidePdfMeta({ version: '1.6.0', date: '2026-12-01', runDate: '2026-11-08' }, now)).toMatchObject({
      date: '2026-12-01',
      source: 'release',
      edition: '1.6.0',
    });
    expect(guidePdfMeta({ version: null, date: null, runDate: '2026-11-08' }, now)).toMatchObject({
      date: '2026-11-08',
      source: 'run',
      edition: null,
    });
    expect(guidePdfMeta(undefined, now)).toMatchObject({
      date: '2026-11-09',
      source: 'run',
      fromRunner: true,
    });
  });
});
