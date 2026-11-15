import { describe, expect, it } from 'vitest';
import {
  applyFindingsCap,
  changedLinesFromNumstat,
  findingsCap,
  normaliseSeverity,
} from '../src/review/findings.ts';

type Sev = 'high' | 'medium' | 'low';
const f = (title: string, severity: Sev) => ({ title, severity });

describe('findingsCap (AC1)', () => {
  it.each([
    [0, 1],
    [1, 1],
    [30, 1],
    [100, 1],
    [101, 2],
    [250, 3],
    [500, 5],
    [501, 5],
    [900, 5],
  ])('%i changed lines allow %i', (lines, cap) => {
    expect(findingsCap(lines)).toBe(cap);
  });
  it('an unknown line count gives the maximum', () => {
    expect(findingsCap(null)).toBe(5);
    expect(findingsCap(undefined)).toBe(5);
    expect(findingsCap(Number.NaN)).toBe(5);
  });
});

describe('applyFindingsCap (AC1, AC2)', () => {
  const seven = [
    f('a-low', 'low'),
    f('b-high', 'high'),
    f('c-med', 'medium'),
    f('d-high', 'high'),
    f('e-low', 'low'),
    f('f-med', 'medium'),
    f('g-high', 'high'),
  ];
  it('250 lines and 7 findings: the 3 most important are posted, the other 4 held back', () => {
    const r = applyFindingsCap(seven, 250);
    expect(r.cap).toBe(3);
    expect(r.heldBackCount).toBe(4);
    expect(r.ordered.map((x) => x.title)).toEqual([
      'b-high',
      'd-high',
      'g-high',
      'c-med',
      'f-med',
      'a-low',
      'e-low',
    ]);
    expect(r.ordered.map((x) => x.rank)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.ordered.filter((x) => x.disposition === 'posted').map((x) => x.title)).toEqual([
      'b-high',
      'd-high',
      'g-high',
    ]);
  });
  it('30 lines posts 1 and 900 lines posts 5', () => {
    expect(applyFindingsCap(seven, 30).ordered.filter((x) => x.disposition === 'posted')).toHaveLength(1);
    expect(applyFindingsCap(seven, 900).ordered.filter((x) => x.disposition === 'posted')).toHaveLength(5);
  });
  it('fewer findings than the cap are all posted; none gives nothing held back', () => {
    const r = applyFindingsCap(seven.slice(0, 2), 900);
    expect(r.heldBackCount).toBe(0);
    expect(r.ordered.every((x) => x.disposition === 'posted')).toBe(true);
    expect(applyFindingsCap([], 10)).toEqual({ cap: 1, heldBackCount: 0, ordered: [] });
  });
  it('does not change its input', () => {
    const copy = JSON.parse(JSON.stringify(seven));
    applyFindingsCap(seven, 250);
    expect(seven).toEqual(copy);
  });
});

describe('changedLinesFromNumstat', () => {
  it('adds added and removed lines; binary files count 0', () => {
    const out = '10\t5\tsrc/a.ts\n-\t-\timg.png\n3\t0\tsrc/b.ts\n';
    expect(changedLinesFromNumstat(out)).toBe(18);
    expect(changedLinesFromNumstat('')).toBe(0);
  });
});

describe('normaliseSeverity', () => {
  it('keeps the three levels and maps the rest', () => {
    expect(normaliseSeverity('high')).toBe('high');
    expect(normaliseSeverity('Medium')).toBe('medium');
    expect(normaliseSeverity('critical')).toBe('high');
    expect(normaliseSeverity('blocker')).toBe('high');
    expect(normaliseSeverity('nit')).toBe('low');
    expect(normaliseSeverity(undefined)).toBe('low');
  });
});
