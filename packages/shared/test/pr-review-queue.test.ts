import { describe, expect, it } from 'vitest';
import {
  autoReviewsLeft,
  compareQueue,
  PrReviewDailyCapSchema,
  type QueueCandidate,
  reviewDayOf,
} from '../src/review/pr-review.ts';

const TZ = 'Africa/Johannesburg'; // UTC+2
const c = (id: string, iso: string, changedLines: number | null): QueueCandidate => ({
  id,
  openedAt: new Date(iso),
  changedLines,
});
const order = (list: QueueCandidate[], tz: string | null = TZ) =>
  [...list].sort(compareQueue(tz)).map((x) => x.id);

describe('compareQueue (AC2)', () => {
  it('oldest day first', () => {
    expect(order([c('b', '2031-03-09T10:00:00+02:00', 1), c('a', '2031-03-08T10:00:00+02:00', 999)])).toEqual(
      ['a', 'b'],
    );
  });
  it('the same local day: fewer changed lines first, unknown size last', () => {
    expect(
      order([
        c('big', '2031-03-08T08:00:00+02:00', 300),
        c('unknown', '2031-03-08T07:00:00+02:00', null),
        c('small', '2031-03-08T15:00:00+02:00', 40),
      ]),
    ).toEqual(['small', 'big', 'unknown']);
  });
  it('equal size: earlier open time, then id', () => {
    expect(
      order([
        c('z', '2031-03-08T08:00:00+02:00', 10),
        c('y', '2031-03-08T09:00:00+02:00', 10),
        c('a', '2031-03-08T09:00:00+02:00', 10),
      ]),
    ).toEqual(['z', 'a', 'y']);
  });
  it('the day is the local one: 23:30 and 00:30 local are different days although the same UTC day', () => {
    const late = c('late', '2031-03-08T23:30:00+02:00', 1); // 21:30Z on the 8th
    const early = c('early', '2031-03-09T00:30:00+02:00', 1); // 22:30Z on the 8th
    expect(order([early, late])).toEqual(['late', 'early']);
    // in UTC they are the same day: the smaller/earlier order decides, here the id after equal size and time order
    expect(order([early, late], 'UTC')).toEqual(['late', 'early']);
    const bigLate = c('bigLate', '2031-03-08T23:30:00+02:00', 500);
    const smallEarly = c('smallEarly', '2031-03-09T00:30:00+02:00', 5);
    expect(order([smallEarly, bigLate])).toEqual(['bigLate', 'smallEarly']);
    expect(order([smallEarly, bigLate], 'UTC')).toEqual(['smallEarly', 'bigLate']);
  });
});

describe('reviewDayOf and the cap', () => {
  it('a local day across the UTC boundary, with its start and next', () => {
    const d = reviewDayOf(new Date('2031-03-10T22:01:00Z'), TZ); // 00:01 on the 11th in Johannesburg
    expect(d.day).toBe('2031-03-11');
    expect(d.start.toISOString()).toBe('2031-03-10T22:00:00.000Z');
    expect(d.next.toISOString()).toBe('2031-03-11T22:00:00.000Z');
  });
  it('falls back to UTC when no zone is set', () => {
    expect(reviewDayOf(new Date('2031-03-10T22:01:00Z'), null).day).toBe('2031-03-10');
  });
  it('autoReviewsLeft is never negative', () => {
    expect(autoReviewsLeft(7, 20)).toBe(13);
    expect(autoReviewsLeft(25, 20)).toBe(0);
  });
  it('the cap is 1 to 100', () => {
    expect(PrReviewDailyCapSchema.safeParse(0).success).toBe(false);
    expect(PrReviewDailyCapSchema.safeParse(1).success).toBe(true);
    expect(PrReviewDailyCapSchema.safeParse(100).success).toBe(true);
    expect(PrReviewDailyCapSchema.safeParse(101).success).toBe(false);
  });
});
