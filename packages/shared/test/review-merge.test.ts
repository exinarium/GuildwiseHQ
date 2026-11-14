import { describe, expect, it } from 'vitest';
import {
  applyFindingsCap,
  isDuplicate,
  type MergeInput,
  mergeFindings,
  titleSimilarity,
} from '../src/index.ts';

let n = 0;
const f = (over: Partial<MergeInput> & Pick<MergeInput, 'reviewer'>): MergeInput => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  idx: 0,
  path: 'src/a.ts',
  line: 10,
  severity: 'medium',
  anchored: true,
  title: 'Something is wrong',
  body: 'text',
  ...over,
});

describe('titleSimilarity', () => {
  it('is the share of words in common', () => {
    expect(titleSimilarity('Null check missing on user', 'Missing null check for user')).toBeGreaterThanOrEqual(0.3);
    expect(titleSimilarity('Null check missing', 'Rename the variable')).toBe(0);
    expect(titleSimilarity('', '')).toBe(0);
  });
});

describe('isDuplicate (AC3)', () => {
  it('same file and same line', () => {
    expect(isDuplicate(f({ reviewer: 'first' }), f({ reviewer: 'second', title: 'Other words' }))).toBe(true);
  });
  it('lines 3 apart with similar titles', () => {
    expect(
      isDuplicate(
        f({ reviewer: 'first', line: 10, title: 'Null check missing on user' }),
        f({ reviewer: 'second', line: 13, title: 'Missing null check for user' }),
      ),
    ).toBe(true);
  });
  it('lines 3 apart with unrelated titles are not', () => {
    expect(
      isDuplicate(
        f({ reviewer: 'first', line: 10, title: 'Null check missing on user' }),
        f({ reviewer: 'second', line: 13, title: 'Rename helper function' }),
      ),
    ).toBe(false);
  });
  it('8 lines apart is not, whatever the title', () => {
    expect(isDuplicate(f({ reviewer: 'first', line: 10 }), f({ reviewer: 'second', line: 18 }))).toBe(false);
  });
  it('a line against a file-level finding is not', () => {
    expect(isDuplicate(f({ reviewer: 'first', line: 10 }), f({ reviewer: 'second', line: null }))).toBe(false);
  });
  it('two file-level findings need a closer title', () => {
    expect(
      isDuplicate(
        f({ reviewer: 'first', line: null, title: 'Missing tests for parser' }),
        f({ reviewer: 'second', line: null, title: 'Missing tests for parser module' }),
      ),
    ).toBe(true);
    expect(
      isDuplicate(
        f({ reviewer: 'first', line: null, title: 'Missing tests' }),
        f({ reviewer: 'second', line: null, title: 'Rename module' }),
      ),
    ).toBe(false);
  });
  it('another file is not, the same reviewer never is, a leading ./ is ignored', () => {
    expect(isDuplicate(f({ reviewer: 'first' }), f({ reviewer: 'second', path: 'src/b.ts' }))).toBe(false);
    expect(isDuplicate(f({ reviewer: 'first' }), f({ reviewer: 'first' }))).toBe(false);
    expect(isDuplicate(f({ reviewer: 'first' }), f({ reviewer: 'second', path: './src/a.ts' }))).toBe(true);
  });
});

describe('mergeFindings', () => {
  it('returns one run unchanged, in idx order', () => {
    const a = [f({ reviewer: 'first', idx: 0, line: 1 }), f({ reviewer: 'first', idx: 1, line: 2 })];
    const m = mergeFindings([a]);
    expect(m.map((x) => x.canonical)).toEqual(a);
    expect(m.every((x) => x.duplicates.length === 0 && x.reviewers.join() === 'first')).toBe(true);
  });

  it('combines a duplicate, credits both reviewers and takes the highest severity', () => {
    const a = f({ reviewer: 'first', line: 10, severity: 'low' });
    const b = f({ reviewer: 'second', line: 10, severity: 'high' });
    const [m, ...rest] = mergeFindings([[a], [b]]);
    expect(rest).toEqual([]);
    expect(m?.canonical).toBe(b);
    expect(m?.duplicates).toEqual([a]);
    expect(m?.reviewers).toEqual(['first', 'second']);
    expect(m?.severity).toBe('high');
  });

  it('is one-to-one: a finding is matched once', () => {
    const a = f({ reviewer: 'first', line: 10, idx: 0 });
    const b1 = f({ reviewer: 'second', line: 10, idx: 0 });
    const b2 = f({ reviewer: 'second', line: 10, idx: 1 });
    const m = mergeFindings([[a], [b1, b2]]);
    expect(m).toHaveLength(2);
    expect(m.filter((x) => x.duplicates.length === 1)).toHaveLength(1);
  });

  it('never merges inside one run', () => {
    const m = mergeFindings([[f({ reviewer: 'first', idx: 0 }), f({ reviewer: 'first', idx: 1 })], []]);
    expect(m).toHaveLength(2);
  });

  it('puts findings found by both first, and does not mutate the input', () => {
    const only = f({ reviewer: 'first', idx: 0, line: 1, path: 'x.ts' });
    const a = f({ reviewer: 'first', idx: 1, line: 20 });
    const b = f({ reviewer: 'second', idx: 0, line: 20 });
    const runs = [[only, a], [b]] as const;
    const snapshot = JSON.stringify(runs);
    const m = mergeFindings(runs);
    expect(m[0]?.duplicates).toHaveLength(1);
    expect(JSON.stringify(runs)).toBe(snapshot);
  });

  it('the cap over the merged list never posts more than 5 (AC2)', () => {
    const a = Array.from({ length: 4 }, (_, i) => f({ reviewer: 'first', idx: i, line: 10 + i * 20 }));
    const b = Array.from({ length: 4 }, (_, i) => f({ reviewer: 'second', idx: i, line: 10 + i * 20 + 1000 }));
    const merged = mergeFindings([a, b]);
    expect(merged).toHaveLength(8);
    const { ordered } = applyFindingsCap(
      merged.map((m) => ({ ...m.canonical, severity: m.severity })),
      10_000,
    );
    expect(ordered.filter((o) => o.disposition === 'posted')).toHaveLength(5);
  });
});
