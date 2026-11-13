import { describe, expect, it } from 'vitest';
import {
  FindingMarkSchema,
  type PostedFindingRow,
  findingView,
  reviewerPrecision,
  reviewersRevealed,
} from '../src/index.ts';

const row = (over: Partial<PostedFindingRow> = {}): PostedFindingRow => ({
  id: '019e3f6a-7b1c-7a2d-8c3e-0123456789f1',
  prReviewId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1',
  runId: '019e3f6a-7b1c-7a2d-8c3e-0123456789b1',
  rank: 1,
  severity: 'high',
  path: 'a.ts',
  line: 3,
  title: 'Null deref',
  body: 'x may be null',
  postedAt: '2026-11-14T10:00:00.000Z',
  reviewUrl: 'https://github.com/acme/toy/pull/7#review-5',
  mark: null,
  markedAt: null,
  reviewers: [{ key: 'first', label: 'Sonnet reviewer', model: 'sonnet' }],
  ...over,
});

describe('AC1: the mark is useful or noise', () => {
  it('accepts useful and noise, never valid or invalid', () => {
    expect(FindingMarkSchema.safeParse('useful').success).toBe(true);
    expect(FindingMarkSchema.safeParse('noise').success).toBe(true);
    expect(FindingMarkSchema.safeParse('valid').success).toBe(false);
    expect(FindingMarkSchema.safeParse('invalid').success).toBe(false);
  });
});

describe('AC2: blind marking', () => {
  it('an unmarked finding carries no reviewer, label or model anywhere in its JSON', () => {
    const dto = findingView(row(), { canMark: true });
    expect(dto.reviewers).toBeNull();
    expect(JSON.stringify(dto).toLowerCase()).not.toMatch(/first|sonnet/);
  });
  it('a marked finding shows the reviewer', () => {
    const dto = findingView(row({ mark: 'useful', markedAt: '2026-11-14T11:00:00.000Z' }), { canMark: true });
    expect(dto.reviewers).toEqual([{ key: 'first', label: 'Sonnet reviewer', model: 'sonnet' }]);
  });
  it('reviewers are revealed only when every posted finding is marked', () => {
    expect(reviewersRevealed([{ mark: 'useful' }, { mark: null }])).toBe(false);
    expect(reviewersRevealed([{ mark: 'useful' }, { mark: 'noise' }])).toBe(true);
    expect(reviewersRevealed([])).toBe(true);
  });
});

describe('AC4: reviewer precision = useful / posted', () => {
  const posted = (mark: 'useful' | 'noise' | null) => ({
    reviewer: 'first' as const,
    model: 'sonnet',
    disposition: 'posted' as const,
    posted: true,
    mark,
  });
  it('4 posted with 3 useful gives 0.75; held-back findings are not counted', () => {
    const out = reviewerPrecision([
      posted('useful'),
      posted('useful'),
      posted('useful'),
      posted('noise'),
      { reviewer: 'first', disposition: 'held_back', mark: 'useful' },
      { reviewer: 'first', disposition: 'held_back', mark: 'useful' },
    ]);
    expect(out).toEqual([
      {
        reviewer: 'first',
        label: 'Sonnet reviewer',
        models: ['sonnet'],
        posted: 4,
        useful: 3,
        noise: 1,
        unmarked: 0,
        precision: 0.75,
      },
    ]);
  });
  it('unmarked findings count as posted', () => {
    const [p] = reviewerPrecision([posted('useful'), posted('useful'), posted('useful'), posted(null)]);
    expect(p).toMatchObject({ posted: 4, unmarked: 1, precision: 0.75 });
  });
  it('findings whose post failed (posted false) are not counted', () => {
    const out = reviewerPrecision([posted('useful'), { ...posted('useful'), posted: false }]);
    expect(out[0]).toMatchObject({ posted: 1, precision: 1 });
  });
  it('nothing posted gives no row and null precision from counts', () => {
    expect(reviewerPrecision([{ reviewer: 'first', disposition: 'held_back', mark: null }])).toEqual([]);
  });
});
