import { describe, expect, it } from 'vitest';
import { clipEventName, EVENT_NAME_MAX } from '../src/commands/common.ts';

/** The one rule for putting a user's display name into a length-limited event field. */
describe('clipEventName', () => {
  it('limits names to 100 characters', () => {
    expect(EVENT_NAME_MAX).toBe(100);
  });

  it('trims and keeps short names and names at the limit unchanged', () => {
    expect(clipEventName('')).toBe('');
    expect(clipEventName('  Ada  ')).toBe('Ada');
    expect(clipEventName('Ada Lovelace')).toBe('Ada Lovelace');
    expect(clipEventName('L'.repeat(100))).toBe('L'.repeat(100));
    expect(clipEventName(`  ${'L'.repeat(100)}  `)).toBe('L'.repeat(100));
  });

  it('clips a longer name to 99 characters and an ellipsis', () => {
    for (const n of [101, 120, 500]) {
      const out = clipEventName('N'.repeat(n));
      expect(out).toBe(`${'N'.repeat(99)}…`);
      expect(out.length).toBe(EVENT_NAME_MAX);
    }
  });
});
