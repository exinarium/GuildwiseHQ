import { describe, expect, it } from 'vitest';
import {
  budgetStatus,
  costUsdMicros,
  DEFAULT_MODEL_PRICES,
  formatMoney,
  modelFamily,
  monthKeyOf,
  monthStartOf,
  nextMonthStartOf,
  priceFor,
} from '../src/index.ts';

describe('price table', () => {
  it('matches a model family by substring and prices unknown models like Sonnet', () => {
    expect(priceFor('claude-opus-4-5').label).toBe('Opus');
    expect(priceFor('SONNET').label).toBe('Sonnet');
    expect(priceFor('claude-fable-5-1').label).toBe('Fable');
    expect(priceFor('claude-fable-5-1')).toMatchObject({
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
    });
    expect(priceFor('claude-haiku-4-5-20251001').label).toBe('Haiku');
    expect(priceFor('mock-model').input).toBe(priceFor('sonnet').input);
    expect(modelFamily('gpt-x')).toBe('Other (priced as Sonnet)');
    expect(DEFAULT_MODEL_PRICES.at(-1)?.match).toBe('');
  });

  it('prices tokens exactly in micro-USD (list price per million tokens x tokens)', () => {
    // Sonnet: 2 + 10 per million, cache read 0.20, cache write 2.50.
    expect(costUsdMicros('sonnet', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(12_000_000);
    expect(costUsdMicros('fable', { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(60_000_000);
    expect(
      costUsdMicros('sonnet', {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(2_700_000);
    expect(costUsdMicros('opus', { inputTokens: 1000, outputTokens: 200 })).toBe(5000 + 5000);
    // 5 tokens of cache read at 0.1 = 0.5 micro: rounds half up, exactly.
    expect(costUsdMicros('haiku', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 5 })).toBe(1);
    expect(costUsdMicros('haiku', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

describe('budget status', () => {
  it('is none without a budget, ok below 80, warning from 80, paused from 100 unless overridden', () => {
    expect(budgetStatus(null, 5).state).toBe('none');
    expect(budgetStatus(100, 79.9).state).toBe('ok');
    expect(budgetStatus(100, 80).state).toBe('warning');
    expect(budgetStatus(100, 99.99).state).toBe('warning');
    expect(budgetStatus(100, 100).state).toBe('paused');
    expect(budgetStatus(100, 150, true).state).toBe('overridden');
    expect(budgetStatus(100, 50, true).state).toBe('ok');
    expect(budgetStatus(100, 150).percent).toBe(150);
  });
});

describe('the month in the organization time zone', () => {
  it('cuts the month where the local clock does, not at UTC midnight', () => {
    // 2026-10-31 23:30 in New York is 2026-11-01 03:30 UTC: still October for the organization.
    const at = new Date('2026-11-01T03:30:00Z');
    expect(monthKeyOf(at, 'America/New_York')).toBe('2026-10');
    expect(monthKeyOf(at, 'UTC')).toBe('2026-11');
    // EDT (UTC-4) until Nov 1 2026 06:00 UTC, when the clocks fall back; November starts at 05:00 UTC (EDT still).
    expect(monthStartOf(at, 'America/New_York').toISOString()).toBe('2026-10-01T04:00:00.000Z');
    expect(nextMonthStartOf(at, 'America/New_York').toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(monthStartOf(new Date('2026-11-15T12:00:00Z'), 'America/New_York').toISOString()).toBe(
      '2026-11-01T04:00:00.000Z',
    );
    expect(nextMonthStartOf(new Date('2026-11-15T12:00:00Z'), 'America/New_York').toISOString()).toBe(
      '2026-12-01T05:00:00.000Z',
    );
  });

  it('handles zones ahead of UTC, December rollover and an unknown zone', () => {
    const at = new Date('2026-12-31T20:00:00Z'); // already January 1st in Auckland (UTC+13)
    expect(monthKeyOf(at, 'Pacific/Auckland')).toBe('2027-01');
    expect(monthStartOf(at, 'Pacific/Auckland').toISOString()).toBe('2026-12-31T11:00:00.000Z');
    expect(nextMonthStartOf(new Date('2026-12-15T00:00:00Z'), 'UTC').toISOString()).toBe(
      '2027-01-01T00:00:00.000Z',
    );
    expect(monthKeyOf(at, 'Not/AZone')).toBe('2026-12');
    expect(monthStartOf(at, null).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });
});

describe('money formatting', () => {
  it('shows cents for small amounts and whole units for large ones', () => {
    expect(formatMoney(12_340_000, 'USD')).toBe('$12.34');
    expect(formatMoney(1_234_000_000, 'USD')).toBe('$1,234');
    expect(formatMoney(5_000_000, 'EUR')).toBe('€5.00');
    expect(formatMoney(5_000_000, 'XXQ')).toContain('5.00');
  });
});
