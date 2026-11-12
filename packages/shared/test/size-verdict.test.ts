import { describe, expect, it } from 'vitest';
import { NeedsSplitProposalSchema } from '../src/cards/needs-split.ts';
import { REVIEW_SETTING_MISSING } from '../src/projects/review-settings.ts';
import {
  designSizing,
  folderScopeOf,
  NO_SIZE_BUDGET,
  needsSplitProposalFrom,
  parseSeamFlag,
  pathsInText,
  StoredDesignSizingSchema,
  sizeVerdict,
  sizingLine,
} from '../src/projects/size-verdict.ts';
import { designSizeLine } from '../src/prompt/shift-prompt.ts';

const settings = {
  sizeBudget: 400,
  sizeUnit: 'changed_lines' as const,
  riskMap: [
    { pattern: 'apps/server/src/auth', risk: 'high' as const },
    { pattern: 'docs', risk: 'low' as const },
  ],
};

describe('sizeVerdict', () => {
  it('AC2: an estimate above the budget is over budget', () => {
    expect(sizeVerdict(401, settings)).toEqual({ verdict: 'over_budget', text: 'over budget' });
  });
  it('AC3: an estimate equal to or below the budget is within budget', () => {
    expect(sizeVerdict(400, settings)).toEqual({ verdict: 'within_budget', text: 'within budget' });
    expect(sizeVerdict(0, settings).verdict).toBe('within_budget');
  });
  it('AC4: no budget gives no verdict and the card line "no size budget set"', () => {
    expect(sizeVerdict(900, { sizeBudget: null, sizeUnit: 'changed_lines' })).toEqual({
      verdict: null,
      text: 'no size budget set',
    });
    expect(sizeVerdict(900, null)).toEqual({ verdict: null, text: NO_SIZE_BUDGET });
  });
  it('a budget without a unit, or no estimate, gives no verdict', () => {
    expect(sizeVerdict(900, { sizeBudget: 400, sizeUnit: null }).verdict).toBeNull();
    expect(sizeVerdict(null, settings)).toEqual({ verdict: null, text: 'no size estimate' });
  });
  it('the settings text ends with the card line, so the two cannot drift apart', () => {
    expect(REVIEW_SETTING_MISSING.sizeBudget.endsWith(NO_SIZE_BUDGET)).toBe(true);
  });
});

describe('designSizing', () => {
  it('AC1: holds the estimate in the project unit and the risk class derived from the paths', () => {
    const s = designSizing({
      settings,
      estimate: 120,
      paths: ['apps/server/src/auth/login.ts'],
      affectedAreaPaths: [],
    });
    expect(s).toMatchObject({ estimate: 120, unit: 'changed_lines', budget: 400, verdict: 'within_budget' });
    expect(s.risk).toMatchObject({
      class: 'high',
      derived: 'high',
      raisedByDeclaration: false,
      status: null,
    });
    expect(StoredDesignSizingSchema.safeParse(s).success).toBe(true);
  });
  it('AC3: high risk within budget stays within budget', () => {
    const s = designSizing({
      settings,
      estimate: 10,
      paths: ['apps/server/src/auth'],
      affectedAreaPaths: [],
    });
    expect(s.verdict).toBe('within_budget');
    expect(s.risk.class).toBe('high');
  });
  it('a declared risk raises the class, never lowers it', () => {
    const low = designSizing({
      settings,
      estimate: 1,
      paths: ['apps/server/src/auth/x.ts'],
      affectedAreaPaths: [],
      declaredRisk: 'low',
    });
    expect(low.risk.class).toBe('high');
    const raised = designSizing({
      settings,
      estimate: 1,
      paths: ['docs/a.md'],
      affectedAreaPaths: [],
      declaredRisk: 'medium',
    });
    expect(raised.risk).toMatchObject({ class: 'medium', derived: 'low', raisedByDeclaration: true });
  });
  it('takes the union of the named paths and the Affected areas', () => {
    const s = designSizing({
      settings,
      estimate: 1,
      paths: ['docs'],
      affectedAreaPaths: ['apps/server/src/auth/session.ts'],
    });
    expect(s.risk.class).toBe('high');
    expect(s.paths).toEqual(['docs']);
  });
  it('without a map the risk class is inactive and the declaration does not stand in', () => {
    const s = designSizing({
      settings: { ...settings, riskMap: null },
      estimate: 1,
      paths: ['docs'],
      affectedAreaPaths: [],
      declaredRisk: 'high',
    });
    expect(s.risk).toMatchObject({ class: null, declared: 'high', status: REVIEW_SETTING_MISSING.riskMap });
  });
});

describe('folderScopeOf and pathsInText', () => {
  it('turns files into their folders, keeps folders, drops what is not a folder', () => {
    expect(folderScopeOf(['apps/web/src/a.tsx', 'apps/web/src', './docs/', 'README.md', '../x'])).toEqual([
      'apps/web/src',
      'docs',
    ]);
  });
  it('finds path-like tokens and skips URLs and versions', () => {
    expect(
      pathsInText(
        'GuildwiseHQ: packages/shared (design report), apps/server/src/x.ts; see https://example.com/a/b and 1.2/3',
      ),
    ).toEqual(['packages/shared', 'apps/server/src/x.ts']);
  });
});

describe('needsSplitProposalFrom', () => {
  it('AC2: an over-budget sizing with 2 seams passes the needs-split proposal schema', () => {
    const s = designSizing({
      settings,
      estimate: 640,
      paths: ['apps/server/src/commands/a.ts', 'apps/web/src/components'],
      affectedAreaPaths: [],
      seams: [
        { title: 'Server', folders: ['apps/server/src/commands'] },
        { title: 'Web', folders: ['apps/web/src/components'], repo: 'web' },
      ],
    });
    const p = needsSplitProposalFrom(s, 'Design summary.');
    expect(NeedsSplitProposalSchema.safeParse(p).success).toBe(true);
    expect(p.reason).toContain(
      "Estimated 640 changed lines at design, over the project's size budget of 400.",
    );
    expect(p.estimate).toEqual({ size: 640, budget: 400, unit: 'changed lines' });
    expect(p.folderScope).toEqual(['apps/server/src/commands', 'apps/web/src/components']);
  });
  it('fewer than 2 seams fails the schema (the handoff is refused)', () => {
    const s = designSizing({
      settings,
      estimate: 640,
      paths: ['apps/web'],
      affectedAreaPaths: [],
      seams: [],
    });
    expect(NeedsSplitProposalSchema.safeParse(needsSplitProposalFrom(s, '')).success).toBe(false);
  });
});

describe('parseSeamFlag', () => {
  it('splits at the first ": " and reads an optional [repo] prefix', () => {
    expect(parseSeamFlag('[web] Card panel: apps/web/src/components, apps/web/src/lib')).toEqual({
      title: 'Card panel',
      folders: ['apps/web/src/components', 'apps/web/src/lib'],
      repo: 'web',
    });
    expect(parseSeamFlag('Server: a: b')).toEqual({ title: 'Server', folders: ['a: b'] });
  });
  it('refuses a seam without ": " or without a folder', () => {
    expect(() => parseSeamFlag('no folders')).toThrow(/<title>: <folder>/);
    expect(() => parseSeamFlag('Title: ')).toThrow();
  });
});

describe('sizingLine and the brief line', () => {
  it('reads the verdict and the risk class in one line', () => {
    const s = designSizing({
      settings,
      estimate: 640,
      paths: ['apps/server/src/auth'],
      affectedAreaPaths: [],
    });
    expect(sizingLine(s)).toBe(
      'Size: 640 changed lines, over budget (budget 400). Risk class: high (derived from the path-to-risk map).',
    );
    const none = designSizing({ settings: null, estimate: 5, paths: [], affectedAreaPaths: [] });
    expect(sizingLine(none)).toContain('no verdict: no size budget set');
  });
  it('asks for --size and --path when the project has a unit, and says none is needed otherwise', () => {
    const line = designSizeLine({
      unit: 'changed_files',
      budget: 30,
      riskMapSet: false,
      sizeStatus: null,
      riskStatus: REVIEW_SETTING_MISSING.riskMap,
    });
    expect(line).toContain('estimate this change in changed files');
    expect(line).toContain('--seam "<title>: <folder>, <folder>"');
    expect(line).toContain('The budget is 30.');
    expect(line).toContain('inactive: no path-to-risk map set');
    expect(
      designSizeLine({ unit: null, budget: null, riskMapSet: false, sizeStatus: 'x', riskStatus: null }),
    ).toContain('no size budget set');
  });
});
