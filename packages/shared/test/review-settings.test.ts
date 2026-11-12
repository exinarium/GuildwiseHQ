import { describe, expect, it } from 'vitest';
import { DomainEventSchema } from '../src/events/index.ts';
import {
  diffSize,
  REVIEW_SETTING_MISSING,
  ReviewSettingsSchema,
  type RiskMapEntry,
  RiskMapSchema,
  reviewSettingsStatus,
  riskFromPaths,
  riskFromPathsStatus,
  riskPatternMatches,
  sameRiskMap,
  sizeChecksStatus,
} from '../src/projects/review-settings.ts';

const map: RiskMapEntry[] = [
  { pattern: 'apps/server/src/auth', risk: 'high' },
  { pattern: 'docs/**', risk: 'low' },
  { pattern: '**/migrations/**', risk: 'medium' },
];

describe('riskFromPaths (AC4)', () => {
  it('takes the highest class of the touched paths', () => {
    const r = riskFromPaths({ paths: ['docs/guide.md', 'apps/server/src/auth/login.ts'], riskMap: map });
    expect(r.state).toBe('active');
    if (r.state !== 'active') return;
    expect(r.derived).toBe('high');
    expect(r.final).toBe('high');
    expect(r.matches).toEqual([
      { path: 'docs/guide.md', pattern: 'docs/**', risk: 'low' },
      { path: 'apps/server/src/auth/login.ts', pattern: 'apps/server/src/auth', risk: 'high' },
    ]);
  });

  it('a declared lower class does not lower the derived class', () => {
    const r = riskFromPaths({
      paths: ['docs/a.md', 'apps/server/src/auth/x.ts'],
      riskMap: map,
      declared: 'low',
    });
    expect(r).toMatchObject({
      state: 'active',
      derived: 'high',
      declared: 'low',
      final: 'high',
      raisedByDeclaration: false,
    });
  });

  it('a declared higher class raises it', () => {
    const r = riskFromPaths({
      paths: ['docs/a.md', 'apps/server/migrations/1.sql'],
      riskMap: map,
      declared: 'high',
    });
    expect(r).toMatchObject({ state: 'active', derived: 'medium', final: 'high', raisedByDeclaration: true });
  });

  it('a declared equal class is not a raise', () => {
    const r = riskFromPaths({ paths: ['docs/a.md'], riskMap: map, declared: 'low' });
    expect(r).toMatchObject({ derived: 'low', final: 'low', raisedByDeclaration: false });
  });

  it('unmatched paths give no derived class (no default); the final class is the declared one', () => {
    expect(riskFromPaths({ paths: ['README.md'], riskMap: map })).toMatchObject({
      state: 'active',
      derived: null,
      final: null,
      matches: [],
    });
    expect(riskFromPaths({ paths: ['README.md'], riskMap: map, declared: 'medium' })).toMatchObject({
      derived: null,
      final: 'medium',
      raisedByDeclaration: true,
    });
  });

  it('overlapping entries: the highest wins whatever the order', () => {
    const overlapping: RiskMapEntry[] = [
      { pattern: 'apps/**', risk: 'high' },
      { pattern: 'apps/web', risk: 'low' },
    ];
    expect(riskFromPaths({ paths: ['apps/web/x.ts'], riskMap: overlapping })).toMatchObject({
      derived: 'high',
    });
    expect(riskFromPaths({ paths: ['apps/web/x.ts'], riskMap: [...overlapping].reverse() })).toMatchObject({
      derived: 'high',
    });
  });

  it('without a map it is inactive, and a declaration does not stand in for it', () => {
    for (const riskMap of [null, undefined, []]) {
      expect(riskFromPaths({ paths: ['apps/server/src/auth/x.ts'], riskMap, declared: 'high' })).toEqual({
        state: 'inactive',
        reason: 'inactive: no path-to-risk map set',
      });
    }
  });
});

describe('riskPatternMatches', () => {
  it('a bare folder covers itself and everything under it, not a sibling with the same prefix', () => {
    expect(riskPatternMatches('apps/server/src/auth', 'apps/server/src/auth/deep/x.ts')).toBe(true);
    expect(riskPatternMatches('apps/server/src/auth', 'apps/server/src/auth')).toBe(true);
    expect(riskPatternMatches('apps/server/src/auth', 'apps/server/src/authz/x.ts')).toBe(false);
  });

  it('globs work as in .gitignore', () => {
    expect(riskPatternMatches('**/migrations/**', 'apps/server/migrations/2900_x.sql')).toBe(true);
    expect(riskPatternMatches('*.sql', 'a/b.sql')).toBe(false);
    expect(riskPatternMatches('apps/*/package.json', 'apps/web/package.json')).toBe(true);
  });

  it('normalises paths and patterns', () => {
    expect(riskPatternMatches('./apps/web/', '.\\apps\\web\\x.ts')).toBe(true);
  });
});

describe('sizeChecksStatus (AC3)', () => {
  it('reports the missing budget instead of a value', () => {
    expect(sizeChecksStatus({ sizeBudget: null, sizeUnit: 'changed_lines', riskMap: null })).toEqual({
      active: false,
      missing: ['sizeBudget'],
      reason: 'inactive: no size budget set',
      reasons: ['inactive: no size budget set'],
    });
  });

  it('reports a missing unit', () => {
    expect(sizeChecksStatus({ sizeBudget: 400, sizeUnit: null })).toMatchObject({
      active: false,
      reason: REVIEW_SETTING_MISSING.sizeUnit,
    });
  });

  it('lists both when neither is set (and for no settings at all)', () => {
    for (const s of [null, undefined, {}]) {
      expect(sizeChecksStatus(s)).toMatchObject({
        active: false,
        missing: ['sizeBudget', 'sizeUnit'],
        reason: 'inactive: no size budget set',
        reasons: ['inactive: no size budget set', 'inactive: no size unit set'],
      });
    }
  });

  it('is active with a budget and a unit', () => {
    expect(sizeChecksStatus({ sizeBudget: 400, sizeUnit: 'changed_files' })).toEqual({ active: true });
  });

  it('risk from paths needs a non-empty map', () => {
    expect(riskFromPathsStatus({ riskMap: [] })).toMatchObject({
      active: false,
      reason: REVIEW_SETTING_MISSING.riskMap,
    });
    expect(riskFromPathsStatus({ riskMap: map })).toEqual({ active: true });
    expect(reviewSettingsStatus(null)).toMatchObject({ size: { active: false }, risk: { active: false } });
  });
});

describe('ReviewSettingsSchema', () => {
  it('accepts all-null (nothing set) and a full value', () => {
    expect(ReviewSettingsSchema.parse({ sizeBudget: null, sizeUnit: null, riskMap: null })).toEqual({
      sizeBudget: null,
      sizeUnit: null,
      riskMap: null,
    });
    expect(
      ReviewSettingsSchema.safeParse({ sizeBudget: 400, sizeUnit: 'changed_lines', riskMap: map }).success,
    ).toBe(true);
  });

  it('has no defaults: a missing field is refused rather than filled in', () => {
    expect(ReviewSettingsSchema.safeParse({}).success).toBe(false);
    expect(ReviewSettingsSchema.safeParse({ sizeBudget: 400, riskMap: null }).success).toBe(false);
  });

  it('refuses a budget of 0, a fraction and an unknown unit', () => {
    expect(ReviewSettingsSchema.safeParse({ sizeBudget: 0, sizeUnit: null, riskMap: null }).success).toBe(
      false,
    );
    expect(ReviewSettingsSchema.safeParse({ sizeBudget: 1.5, sizeUnit: null, riskMap: null }).success).toBe(
      false,
    );
    expect(
      ReviewSettingsSchema.safeParse({ sizeBudget: null, sizeUnit: 'tokens', riskMap: null }).success,
    ).toBe(false);
  });

  it('refuses an empty pattern, a leading /, .. and duplicates; normalises a trailing /', () => {
    const bad = (pattern: string) => RiskMapSchema.safeParse([{ pattern, risk: 'low' }]).success;
    expect(bad('')).toBe(false);
    expect(bad('   ')).toBe(false);
    expect(bad('/etc')).toBe(false);
    expect(bad('apps/../secret')).toBe(false);
    expect(bad('x'.repeat(301))).toBe(false);
    expect(
      RiskMapSchema.safeParse([
        { pattern: 'apps/web', risk: 'low' },
        { pattern: './apps/web/', risk: 'high' },
      ]).success,
    ).toBe(false);
    expect(RiskMapSchema.parse([{ pattern: ' apps/web/ ', risk: 'low' }])).toEqual([
      { pattern: 'apps/web', risk: 'low' },
    ]);
  });

  it('refuses a row without a risk class', () => {
    expect(RiskMapSchema.safeParse([{ pattern: 'apps/web' }]).success).toBe(false);
  });
});

describe('ProjectReviewSettingsSet event', () => {
  it('parses an all-null value and an old pattern that today’s rules would refuse', () => {
    const schema = {
      safeParse: (payload: object) =>
        DomainEventSchema.safeParse({ type: 'ProjectReviewSettingsSet', payload }),
    };
    const id = '00000000-0000-4000-8000-000000000001';
    expect(
      schema.safeParse({ projectId: id, sizeBudget: null, sizeUnit: null, riskMap: null, by: id }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        projectId: id,
        sizeBudget: 10,
        sizeUnit: 'changed_files',
        riskMap: [{ pattern: 'a/../b', risk: 'high' }],
        by: id,
      }).success,
    ).toBe(true);
  });
});

describe('diffSize', () => {
  const files = [
    { added: 10, deleted: 5 },
    { added: 0, deleted: 0 },
  ];
  it('counts added + removed lines, or files', () => {
    expect(diffSize(files, 'changed_lines')).toBe(15);
    expect(diffSize(files, 'changed_files')).toBe(2);
  });
});

describe('sameRiskMap (AC1: an identical save records nothing)', () => {
  it('ignores the key order jsonb returns', () => {
    const stored = JSON.parse(
      '[{"risk":"high","pattern":"apps/server/src/auth"},{"risk":"low","pattern":"docs/**"}]',
    );
    expect(sameRiskMap(stored, map.slice(0, 2))).toBe(true);
  });
  it('sees a changed class, pattern, order or length', () => {
    expect(sameRiskMap(map, [{ ...map[0]!, risk: 'low' }, map[1]!, map[2]!])).toBe(false);
    expect(sameRiskMap(map, [{ ...map[0]!, pattern: 'apps/web' }, map[1]!, map[2]!])).toBe(false);
    expect(sameRiskMap(map, [map[1]!, map[0]!, map[2]!])).toBe(false);
    expect(sameRiskMap(map, map.slice(0, 2))).toBe(false);
  });
  it('treats null, empty and unreadable stored values as not set', () => {
    expect(sameRiskMap(null, null)).toBe(true);
    expect(sameRiskMap([], null)).toBe(true);
    expect(sameRiskMap(null, [])).toBe(true);
    expect(sameRiskMap({ bad: true }, null)).toBe(true);
    expect(sameRiskMap(null, map)).toBe(false);
    expect(sameRiskMap(map, null)).toBe(false);
  });
});
