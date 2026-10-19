import { describe, expect, it } from 'vitest';
import {
  bootstrapRatio,
  GRAPH_EVALUATION_WEEKS,
  type Guards,
  graphArmOf,
  graphClaim,
  graphHoldout,
  median,
  quantile,
  type Sample,
  summarize,
} from '../src/index.ts';

const samples = (vals: number[], stratum = 'feature/small'): Sample[] =>
  vals.map((value) => ({ value, stratum }));

describe('quantiles and arm summaries', () => {
  it('quantile interpolates; median and quartiles of a small arm', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(median([5, 1, 3])).toBe(3);
    expect(summarize(samples([10, 20, 30, 40, 50]))).toEqual({ cards: 5, median: 30, p25: 20, p75: 40 });
    expect(summarize([])).toEqual({ cards: 0, median: null, p25: null, p75: null });
  });
});

describe('the holdout', () => {
  it('is stable per card, about one in five, and ends with the window', () => {
    const ids = Array.from(
      { length: 3000 },
      (_, i) => `0192f3a0-0000-7000-8000-${String(i).padStart(12, '0')}`,
    );
    const off = ids.filter(graphHoldout).length;
    expect(off).toBeGreaterThan(520);
    expect(off).toBeLessThan(680);
    expect(ids.map(graphHoldout)).toEqual(ids.map(graphHoldout));
    const card = ids.find(graphHoldout) as string;
    const start = new Date('2026-10-01T00:00:00Z');
    expect(graphArmOf(card, start, new Date('2026-10-15T00:00:00Z'))).toBe('off');
    expect(
      graphArmOf(card, start, new Date(start.getTime() + GRAPH_EVALUATION_WEEKS * 7 * 86_400_000 + 1)),
    ).toBe('on');
    expect(graphArmOf(card, null, start)).toBe('on'); // no index yet: nothing to hold out
    const keep = ids.find((i) => !graphHoldout(i)) as string;
    expect(graphArmOf(keep, start, new Date('2026-10-15T00:00:00Z'))).toBe('on');
  });
});

describe('bootstrapRatio (stratified, seeded)', () => {
  const noisy = (centre: number, n: number) =>
    Array.from({ length: n }, (_, i) => centre + ((i * 37) % 11) * 400 - 2000);

  it('finds a real saving: the ratio is near 0.7 and the whole interval is below 1', () => {
    const r = bootstrapRatio(samples(noisy(70_000, 20)), samples(noisy(100_000, 20)), 1000, 7);
    expect(r?.ratio).toBeCloseTo(0.7, 1);
    expect(r?.hi).toBeLessThan(1);
    expect(r?.lo).toBeGreaterThan(0.5);
  });

  it('is the same every time for the same seed, and null without data', () => {
    const a = bootstrapRatio(samples(noisy(70_000, 12)), samples(noisy(100_000, 12)), 500, 3);
    expect(bootstrapRatio(samples(noisy(70_000, 12)), samples(noisy(100_000, 12)), 500, 3)).toEqual(a);
    expect(bootstrapRatio([], samples([1]))).toBeNull();
    expect(bootstrapRatio(samples([1]), samples([0, 0]))).toBeNull(); // a zero median holds no ratio
  });

  it('two equal arms: the interval includes one', () => {
    const r = bootstrapRatio(samples(noisy(100_000, 20)), samples(noisy(100_000, 20)), 1000, 5);
    expect(r?.lo).toBeLessThan(1);
    expect(r?.hi).toBeGreaterThan(1);
  });

  it('compares each kind of card with its own kind: a graph arm that holds more cheap cards is no saving', () => {
    // the same cost per type in both arms, but the graph arm happens to hold mostly docs cards
    const on = [
      ...samples(Array(18).fill(10_000), 'docs/small'),
      ...samples([100_000, 100_000], 'feature/large'),
    ];
    const off = [
      ...samples(Array(10).fill(10_000), 'docs/small'),
      ...samples(Array(10).fill(100_000), 'feature/large'),
    ];
    const r = bootstrapRatio(on, off, 1000, 9);
    expect(r?.ratio).toBeCloseTo(1, 5); // pooled medians would say 0.18
    expect(r?.lo).toBeLessThanOrEqual(1);
    expect(r?.hi).toBeGreaterThanOrEqual(1);
  });

  it('a saving inside every stratum shows in the combined ratio', () => {
    const on = [...samples(noisy(7_000, 10), 'docs/small'), ...samples(noisy(70_000, 10), 'feature/large')];
    const off = [
      ...samples(noisy(10_000, 10), 'docs/small'),
      ...samples(noisy(100_000, 10), 'feature/large'),
    ];
    const r = bootstrapRatio(on, off, 1000, 4);
    expect(r?.ratio).toBeCloseTo(0.7, 1);
    expect(r?.hi).toBeLessThan(1);
  });
});

describe('graphClaim (design section 11: allowed only when the interval excludes 1 and no guard is worse)', () => {
  const guards = (over: Partial<Guards> = {}): Guards => ({
    reworkRounds: 0.5,
    changesRequested: 0.4,
    testerFailures: 0.2,
    daysToDone: 2,
    costPerCardUsd: 3,
    ...over,
  });
  const arm = (cards: number) => ({ cards, median: 100, p25: 90, p75: 110 });

  it('not enough cards in an arm', () => {
    expect(graphClaim(arm(9), arm(30), { ratio: 0.6, lo: 0.5, hi: 0.7 }, guards(), guards()).reason).toBe(
      'not_enough_cards',
    );
    expect(graphClaim(arm(30), arm(30), null, guards(), guards()).reason).toBe('not_enough_cards');
  });

  it('no saving, or an interval that touches one', () => {
    expect(graphClaim(arm(30), arm(30), { ratio: 1.1, lo: 1.0, hi: 1.3 }, guards(), guards()).reason).toBe(
      'no_saving',
    );
    expect(graphClaim(arm(30), arm(30), { ratio: 0.9, lo: 0.7, hi: 1.05 }, guards(), guards()).reason).toBe(
      'interval_includes_one',
    );
  });

  it('a guard worse in the graph arm withholds it, and says which', () => {
    const c = graphClaim(
      arm(30),
      arm(30),
      { ratio: 0.6, lo: 0.5, hi: 0.7 },
      guards({ testerFailures: 0.3, daysToDone: 2.5 }),
      guards(),
    );
    expect(c).toMatchObject({ allowed: false, reason: 'guard_worse', savingPercent: null });
    expect(c.worseGuards.sort()).toEqual(['daysToDone', 'testerFailures']);
  });

  it('allowed: the saving is rounded down to a whole percent', () => {
    const c = graphClaim(
      arm(30),
      arm(30),
      { ratio: 0.618, lo: 0.5, hi: 0.72 },
      guards({ costPerCardUsd: 2 }),
      guards(),
    );
    expect(c).toEqual({ allowed: true, reason: 'ok', savingPercent: 38, worseGuards: [] });
  });
});
