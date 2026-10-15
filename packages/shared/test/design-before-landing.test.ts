import { describe, expect, it } from 'vitest';
import { InvestigationDataSchema, renderShiftPrompt, type ShiftBrief } from '../src/index.ts';

// Backlog #80: the prompt of a design made before the dependencies landed, of the assumption review, and of the build
// that commits the carried report.

const brief = (stage: string, investigation: ShiftBrief['investigation']): ShiftBrief =>
  ({
    shift: {
      id: 's',
      kind: 'card',
      stage,
      stageLabel: stage,
      doneCriteria: 'd',
      outcomes: [],
      maxShiftMinutes: 30,
    },
    agent: { id: 'a', name: 'A', seniority: 'senior' },
    card: {
      id: 'c',
      ref: 'TOY-2',
      title: 'T',
      cardType: 'feature',
      fields: {},
      riskTier: null,
      reworkRound: 0,
      completionAction: null,
      docsNeeded: false,
      investigationOnly: false,
      dependencies: [
        { ref: 'TOY-1', title: 'Base', status: 'waiting', landed: true },
        { ref: 'TOY-0', title: 'Other', status: 'queued', landed: false },
      ],
    },
    project: {
      id: 'p',
      key: 'TOY',
      name: 'Toy',
      workingBranch: 'main',
      e2eGlobs: [],
      architecturalGlobs: [],
    },
    role: { key: 'x', name: 'X', instructions: '', coreRules: [], skills: [] },
    handoffs: [],
    reviewComments: [],
    thread: [],
    standingOrders: [],
    ledger: [],
    investigation,
  }) as ShiftBrief;

const ASSUMPTIONS = [{ assumption: 'TOY-0 exports greet()', dependency: 'TOY-0', ifWrong: 'call the API' }];

describe('prompts around a design made before its dependencies landed', () => {
  it('lists which dependencies have landed', () => {
    const text = renderShiftPrompt(brief('build', undefined));
    expect(text).toContain('TOY-1 Base (waiting; landed in the working branch)');
    expect(text).toContain('TOY-0 Other (queued; not landed yet)');
  });

  it('the design shift is told there is no branch, gets the dependency specs and must record assumptions', () => {
    const text = renderShiftPrompt(
      brief('investigate', {
        reportPath: 'docs/investigations/TOY-2.md',
        location: 'repo',
        investigationOnly: false,
        mergeMainFirst: true,
        readOnly: true,
        unlandedDependencies: [
          {
            ref: 'TOY-0',
            title: 'Other',
            status: 'queued',
            spec: 'context: greet people\nrequirements: export greet()',
            report: { reportPath: 'vault/TOY-0.md', location: 'vault', summary: 'Greeting module design.' },
          },
        ],
      }),
    );
    expect(text).toContain('DESIGN BEFORE THE DEPENDENCIES HAVE LANDED');
    expect(text).toContain('no branch yet');
    expect(text).toContain('requirements: export greet()');
    expect(text).toContain('Greeting module design.');
    expect(text).toContain('--assumption');
    expect(text).toContain('--no-assumptions');
    expect(text).not.toContain('commit it on the card branch');
    expect(text).not.toContain('The latest main branch is merged first');
  });

  it('the review shift lists the numbered assumptions and the two ways to finish', () => {
    const text = renderShiftPrompt(
      brief('investigate', {
        reportPath: 'docs/investigations/TOY-2.md',
        location: 'repo',
        investigationOnly: false,
        mergeMainFirst: false,
        review: { assumptions: ASSUMPTIONS, dependencies: ['TOY-0'] },
        report: {
          reportPath: 'docs/investigations/TOY-2.md',
          location: 'repo',
          summary: 's',
          body: '# design',
        },
      }),
    );
    expect(text).toContain('ASSUMPTION REVIEW');
    expect(text).toContain('1. TOY-0 exports greet() (TOY-0); if wrong: call the API');
    expect(text).toContain('aom design confirm');
    expect(text).toContain('aom design revise');
    expect(text).toContain('# design');
  });

  it('the builder is told to commit the carried report first', () => {
    const text = renderShiftPrompt(
      brief('build', {
        reportPath: 'docs/investigations/TOY-2.md',
        location: 'repo',
        investigationOnly: false,
        mergeMainFirst: false,
        report: {
          reportPath: 'docs/investigations/TOY-2.md',
          location: 'repo',
          summary: 's',
          body: '# design',
        },
      }),
    );
    expect(text).toContain(
      'Create `docs/investigations/TOY-2.md` on your branch with exactly the text below',
    );
    expect(text).toContain('carried on the card until you commit it');
    expect(text).not.toContain('Read the report before you start');
  });

  it('the report data accepts assumptions and a review, and rejects an unknown decision', () => {
    const base = { reportPath: 'r.md', summary: 's', location: 'repo' as const };
    expect(InvestigationDataSchema.safeParse({ ...base, assumptions: ASSUMPTIONS }).success).toBe(true);
    const ok = InvestigationDataSchema.parse({
      ...base,
      review: { decision: 'revise', revised: [1], note: 'n' },
    });
    expect(ok.review?.revised).toEqual([1]);
    expect(InvestigationDataSchema.safeParse({ ...base, review: { decision: 'maybe' } }).success).toBe(false);
  });
});
