import { describe, expect, it } from 'vitest';
import {
  branchName,
  CodeFieldsSchema,
  cardRef,
  codeWorkflowV1,
  fieldCatalogue,
  isFilled,
  MockScriptSchema,
  normalizeRemoteUrl,
  parseCardFields,
  parseCardRef,
  requiredMissing,
  slugify,
} from '../src/index.ts';

const build = codeWorkflowV1.stages.find((s) => s.id === 'build')!;

describe('isFilled', () => {
  it('treats blank strings, empty arrays, null and undefined as unfilled', () => {
    expect([' ', '', [], null, undefined].map(isFilled)).toEqual([false, false, false, false, false]);
  });
  it('treats false and 0 as filled', () => {
    expect([false, 0, 'x', ['a'], {}].map(isFilled)).toEqual([true, true, true, true, true]);
  });
});

describe('requiredMissing', () => {
  const full = {
    title: 'Add login',
    cardType: 'feature',
    repoId: '019e3f6a-7b1c-7a2d-8c3e-0123456789ab',
    completionAction: 'pr',
    fields: {
      context: 'c',
      requirements: 'r',
      acceptanceCriteria: ['a'],
      affectedAreas: 'x',
      constraints: 'k',
      testPlan: 't',
    },
  };
  it('lists every missing key for an empty card, in stage order', () => {
    expect(requiredMissing({ title: '', cardType: null, fields: {} }, build)).toEqual([
      ...build.requiredFields,
    ]);
  });
  it('returns nothing for a complete card', () => {
    expect(requiredMissing(full, build)).toEqual([]);
  });
  it('requires at least one acceptance criterion', () => {
    expect(requiredMissing({ ...full, fields: { ...full.fields, acceptanceCriteria: [] } }, build)).toEqual([
      'acceptanceCriteria',
    ]);
  });
  it('reads columns from the card and the rest from fields', () => {
    expect(requiredMissing({ ...full, repoId: null, completionAction: undefined }, build)).toEqual([
      'completionAction',
      'repoId',
    ]);
  });
  it('spec stage needs only title and cardType', () => {
    const spec = codeWorkflowV1.stages[0]!;
    expect(requiredMissing({ title: 'x', cardType: 'bug' }, spec)).toEqual([]);
    expect(requiredMissing({ title: 'x' }, spec)).toEqual(['cardType']);
  });
});

describe('field sets', () => {
  it('code fields are all optional (drafts) and strip unknown keys', () => {
    expect(CodeFieldsSchema.parse({})).toEqual({});
    expect(CodeFieldsSchema.parse({ context: 'c', junk: 1 })).toEqual({ context: 'c' });
    expect(CodeFieldsSchema.safeParse({ acceptanceCriteria: 'not a list' }).success).toBe(false);
  });
  it('parseCardFields: built-in sets validated, custom sets passed through', () => {
    expect(parseCardFields('code', { context: 1 }).success).toBe(false);
    expect(parseCardFields('research', { depth: 'deep', question: 'why' }).success).toBe(true);
    expect(parseCardFields('research', { depth: 'huge' }).success).toBe(false);
    expect(parseCardFields('my-set', { anything: 1 })).toEqual({ success: true, data: { anything: 1 } });
  });
  it('fieldCatalogue merges columns, set fields and custom fields', () => {
    const c = fieldCatalogue('code', [{ key: 'severity', label: 'Severity', type: 'text' }]);
    expect(c.title?.kind).toBe('text');
    expect(c.docsNeeded?.kind).toBe('boolean');
    expect(c.testPlan?.kind).toBe('markdown');
    expect(c.severity?.kind).toBe('text');
    expect(c.question).toBeUndefined();
  });
});

describe('MockScriptSchema', () => {
  it('accepts per-stage action lists', () => {
    expect(MockScriptSchema.parse({ review: ['changes', 'ok'], build: ['question', 'ok'] })).toEqual({
      review: ['changes', 'ok'],
      build: ['question', 'ok'],
    });
  });
  it('rejects unknown actions', () => {
    expect(MockScriptSchema.safeParse({ review: ['explode'] }).success).toBe(false);
  });
});

describe('ids', () => {
  it('card refs', () => {
    expect(cardRef('WEB', 12)).toBe('WEB-12');
    expect(parseCardRef('WEB-12')).toEqual({ projectKey: 'WEB', number: 12 });
    expect(parseCardRef('web-12')).toBeNull();
    expect(parseCardRef('WEB-0')).toBeNull();
  });
  it('slugify and branchName', () => {
    expect(slugify('Add login page!!')).toBe('add-login-page');
    expect(slugify('Ünïcode  & stuff')).toBe('unicode-stuff');
    expect(slugify('a'.repeat(60))).toHaveLength(40);
    expect(branchName('aom/', 'WEB-12', 'Add login page')).toBe('aom/web-12-add-login-page');
    expect(branchName('aom/', 'WEB-12', '!!!')).toBe('aom/web-12');
  });
  it('normalizeRemoteUrl treats ssh and https remotes as equal', () => {
    const expected = 'github.com/acme/web';
    for (const u of [
      'git@github.com:acme/web.git',
      'https://github.com/acme/web',
      'https://github.com/Acme/Web.git',
      'ssh://git@github.com/acme/web.git',
      'https://user:tok@github.com/acme/web/',
      'ssh://git@github.com:22/acme/web.git',
    ])
      expect(normalizeRemoteUrl(u), u).toBe(expected);
  });
});
