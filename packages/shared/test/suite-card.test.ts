import { describe, expect, it } from 'vitest';
import { isSuiteCard } from '../src/index.ts';

describe('isSuiteCard', () => {
  it('is a regression card with a suite origin', () => {
    expect(isSuiteCard('regression', 'full_suite')).toBe(true);
    expect(isSuiteCard('regression', 'regression')).toBe(true);
  });
  it('a bug card spawned by a suite keeps the origin but is not a suite', () => {
    expect(isSuiteCard('bug', 'regression')).toBe(false);
    expect(isSuiteCard('bug', 'full_suite')).toBe(false);
  });
  it('other origins and missing values are not suites', () => {
    expect(isSuiteCard('regression', 'manual')).toBe(false);
    expect(isSuiteCard('feature', 'test_failure')).toBe(false);
    expect(isSuiteCard(null, 'regression')).toBe(false);
    expect(isSuiteCard('regression', undefined)).toBe(false);
  });
});
