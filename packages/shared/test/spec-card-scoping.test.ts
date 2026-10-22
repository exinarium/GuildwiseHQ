import { describe, expect, it } from 'vitest';
import {
  DomainEventSchema,
  MIN_RUNNER_FOR_REPO_SCOPING,
  renderSpecCardInstructions,
  renderSpecCardPrompt,
  runnerAtLeast,
  SpecCardDataSchema,
  type SpecCardTask,
} from '../src/index.ts';

describe('runnerAtLeast', () => {
  it('compares numerically, not as text, and treats a pre-release as older than its release', () => {
    expect(MIN_RUNNER_FOR_REPO_SCOPING).toBe('0.1.40');
    expect(runnerAtLeast('0.1.40', '0.1.40')).toBe(true);
    expect(runnerAtLeast('0.1.100', '0.1.40')).toBe(true);
    expect(runnerAtLeast('0.2.0', '0.1.40')).toBe(true);
    expect(runnerAtLeast('0.1.39', '0.1.40')).toBe(false);
    expect(runnerAtLeast('0.1.9', '0.1.40')).toBe(false);
    expect(runnerAtLeast('0.1.40-rc1', '0.1.40')).toBe(false);
    expect(runnerAtLeast('0.0.0-test', '0.1.40')).toBe(false);
    expect(runnerAtLeast(null, '0.1.40')).toBe(false);
    expect(runnerAtLeast('not a version', '0.1.40')).toBe(false);
  });
});

describe('SpecCardDataSchema', () => {
  const fields = { requirements: 'do it' };
  const child = (repo: string, extra: object = {}) => ({ title: `Card ${repo}`, repo, fields, ...extra });

  it('still accepts plain fields', () => {
    expect(SpecCardDataSchema.safeParse({ fields }).success).toBe(true);
    expect(SpecCardDataSchema.safeParse({ fields: {} }).success).toBe(false);
    expect(SpecCardDataSchema.safeParse({}).success).toBe(false);
  });

  it('takes one repository, with or without fields', () => {
    expect(SpecCardDataSchema.safeParse({ repo: 'web' }).success).toBe(true);
    expect(SpecCardDataSchema.safeParse({ repo: 'web', fields }).success).toBe(true);
  });

  it('takes a split of 2 to 8 cards with dependsOn, and not together with a repository', () => {
    expect(
      SpecCardDataSchema.safeParse({ split: [child('api'), child('web', { dependsOn: [1] })] }).success,
    ).toBe(true);
    expect(SpecCardDataSchema.safeParse({ split: [child('api')] }).success).toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => child(`r${i}`));
    expect(SpecCardDataSchema.safeParse({ split: nine }).success).toBe(false);
    expect(SpecCardDataSchema.safeParse({ split: nine.slice(0, 8) }).success).toBe(true);
    expect(SpecCardDataSchema.safeParse({ repo: 'web', split: [child('api'), child('web')] }).success).toBe(
      false,
    );
    expect(
      SpecCardDataSchema.safeParse({ split: [child('api'), child('web', { dependsOn: [0] })] }).success,
    ).toBe(false);
  });
});

describe('CardCancelled split cause', () => {
  it('is a valid cause with child ids; old events without them still parse', () => {
    expect(CardCancelledCauseCheck({ cardId: id(1), reason: 'x' })).toBe(true);
    expect(
      CardCancelledCauseCheck({ cardId: id(1), reason: 'x', cause: 'split', childCardIds: [id(2)] }),
    ).toBe(true);
    expect(CardCancelledCauseCheck({ cardId: id(1), reason: 'x', cause: 'nonsense' })).toBe(false);
  });
});

const CardCancelledCauseCheck = (payload: object) =>
  DomainEventSchema.safeParse({
    v: 1,
    id: id(99),
    ts: '2026-10-03T12:00:00.000Z',
    type: 'CardCancelled',
    payload,
  }).success;

function id(n: number) {
  return `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
}

describe('the scoping prompt', () => {
  const base: SpecCardTask = {
    cardId: id(1),
    ref: 'TOY-7',
    title: 'Reset link is blank',
    cardType: 'bug',
    projectKey: 'TOY',
    fields: { context: 'The link opens a blank page.' },
    missing: ['requirements'],
    listFields: [],
    chooseRepo: true,
    repos: [
      { repoId: id(2), name: 'api', graphKey: 'aaaaaaaaaaaa', indexed: true },
      { repoId: id(3), name: 'web', graphKey: 'bbbbbbbbbbbb', indexed: false },
    ],
    by: 'ba',
  };
  const brief = { agent: { name: 'Ben' }, role: { instructions: 'Be a BA.', coreRules: [] } };
  const outcomes = [{ id: 'spec_card_done', label: 'done' }];

  it('tells the BA to use the graph, not source, and lists the repositories', () => {
    const text = renderSpecCardInstructions(brief, base, outcomes, (o) => `cmd ${o.id}`);
    expect(text).toContain('business analyst');
    expect(text).toContain('api (graph key aaaaaaaaaaaa, indexed)');
    expect(text).toContain('web (graph key bbbbbbbbbbbb, NOT indexed)');
    expect(text).toContain('aom graph query');
    expect(text).toContain('cannot read source code');
    expect(text).toContain('"split"');
    expect(text).not.toContain('you have no repository in this shift');
    expect(renderSpecCardPrompt(base)).toContain('- the repository');
  });

  it('tells an architect to read the repositories instead', () => {
    const text = renderSpecCardInstructions(brief, { ...base, by: 'architect' }, outcomes, (o) => o.id);
    expect(text).toContain('the architect');
    expect(text).toContain('Read the repositories you are given');
    expect(text).not.toContain('aom graph query');
  });

  it('is the plain prompt without scoping', () => {
    const plain = { ...base, chooseRepo: undefined, repos: undefined, by: undefined };
    const text = renderSpecCardInstructions(brief, plain, outcomes, (o) => o.id);
    expect(text).toContain('you have no repository in this shift');
    expect(renderSpecCardPrompt(plain)).not.toContain('the repository');
  });
});
