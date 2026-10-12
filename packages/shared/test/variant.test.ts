import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  boardColumnsWith,
  codeBugfixWorkflowV1,
  codeWorkflowV1,
  hasErrors,
  investigateInsertion,
  materialiseVariant,
  type RoleDefinition,
  resolveOutcome,
  type StageInsertionInput,
  validateVariant,
  type WorkflowDefinition,
  type WorkflowVariantSpec,
  WorkflowVariantSpecSchema,
} from '../src/index.ts';

const PROJECT = '0191a3b2-0000-7000-8000-000000000001';
const CTX = { builtinWorkflowKeys: ['code', 'code-bugfix', 'research', 'feed'] };

/** A role that may claim `investigate*` steps in any workflow (what the architect does). */
const investigator: RoleDefinition = {
  ...(BUILTIN_ROLES.find((r) => r.key === 'reviewer') as RoleDefinition),
  key: 'architect',
  claimableStages: [{ workflowKey: '*', stageId: 'investigate*' }],
};
const OTHER_BUILTINS = BUILTIN_ROLES.filter((r) => r.key !== 'architect');
const ROLES = [...OTHER_BUILTINS, investigator];

const spec = (insertions: StageInsertionInput[], over: Record<string, unknown> = {}): WorkflowVariantSpec =>
  WorkflowVariantSpecSchema.parse({
    key: 'code-toy',
    name: 'Code (Toy)',
    projectId: PROJECT,
    base: { key: 'code', version: 1 },
    insertions,
    ...over,
  });

const check = (
  s: WorkflowVariantSpec,
  base: WorkflowDefinition = codeWorkflowV1,
  roles: readonly RoleDefinition[] = ROLES,
) => validateVariant(s, base, roles, CTX);
const codes = (issues: Array<{ code: string; severity: string }>) =>
  issues.filter((i) => i.severity === 'error').map((i) => i.code);

const customStage = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  claimRole: 'writer',
  doneCriteria: 'done',
  ...over,
});

describe('materialiseVariant', () => {
  it('inserts a step after build: handoff leads to it, it leads on to review', () => {
    const s = spec([{ after: 'build', stage: customStage('security_check', { claimRole: 'reviewer' }) }]);
    const def = materialiseVariant(codeWorkflowV1, s, 3);
    expect(def.stages.map((x) => x.id)).toEqual([
      'spec',
      'build',
      'security_check',
      'review',
      'test',
      'docs',
      'finalize',
      'done',
    ]);
    expect(def).toMatchObject({
      key: 'code-toy',
      version: 3,
      builtIn: false,
      extends: { key: 'code', version: 1 },
    });
    const build = def.stages.find((x) => x.id === 'build');
    expect(build?.outcomes[0]).toMatchObject({
      id: 'handoff',
      to: 'security_check',
      event: 'ReviewRequested',
    });
    const added = def.stages.find((x) => x.id === 'security_check');
    expect(added).toMatchObject({ kind: 'agent', column: 'security_check', worktree: 'reuse' });
    expect(added?.outcomes).toEqual([
      expect.objectContaining({ id: 'done', to: 'review', kind: 'success', event: 'StageCompleted' }),
    ]);
    // The card is routed through it by the same engine.
    expect(resolveOutcome(def, {}, 'build', 'handoff').toStage).toBe('security_check');
    expect(resolveOutcome(def, {}, 'security_check', 'done').toStage).toBe('review');
  });

  it('after test, the special pass event stays on test and now targets the new step; failure routes are untouched', () => {
    const s = spec([investigateInsertion('test')]);
    const def = materialiseVariant(codeWorkflowV1, s);
    const test = def.stages.find((x) => x.id === 'test');
    expect(test?.outcomes.find((o) => o.id === 'pass')).toMatchObject({
      to: 'investigate_after_test',
      event: 'TestPassed',
      data: 'testEvidence',
    });
    expect(test?.outcomes.find((o) => o.id === 'fail')).toMatchObject({
      to: 'test',
      effect: 'spawn_bug_child',
    });
    const inserted = def.stages.find((x) => x.id === 'investigate_after_test');
    expect(inserted).toMatchObject({
      claimRole: 'architect',
      seniorOnly: true,
      column: 'Investigate & design',
    });
    expect(inserted?.outcomes[0]).toMatchObject({ to: 'docs', data: 'investigation' });
    // `docs` is skipped when not needed: the new step still leads past it.
    expect(resolveOutcome(def, { docsNeeded: false }, 'investigate_after_test', 'done').toStage).toBe(
      'finalize',
    );
  });

  it('inserting after the first (manual) stage goes before the first worktree stage', () => {
    const def = materialiseVariant(
      codeWorkflowV1,
      spec([{ after: 'spec', stage: customStage('triage', { worktree: 'create' }) }]),
    );
    expect(def.stages[0]?.outcomes[0]).toMatchObject({ event: 'CardSpecified', to: 'triage' });
    expect(def.stages[1]?.outcomes[0]?.to).toBe('build');
  });

  it('two insertions after the same stage nest; a later one may follow an earlier insertion', () => {
    const def = materialiseVariant(
      codeWorkflowV1,
      spec([
        { after: 'review', stage: customStage('a') },
        { after: 'a', stage: customStage('b') },
      ]),
    );
    expect(def.stages.map((x) => x.id).slice(2, 6)).toEqual(['review', 'a', 'b', 'test']);
    expect(resolveOutcome(def, {}, 'review', 'approve').toStage).toBe('a');
    expect(resolveOutcome(def, {}, 'a', 'done').toStage).toBe('b');
    expect(resolveOutcome(def, {}, 'b', 'done').toStage).toBe('test');
  });

  it('does not change the base object', () => {
    const before = JSON.stringify(codeWorkflowV1);
    materialiseVariant(codeWorkflowV1, spec([{ after: 'build', stage: customStage('x') }]));
    expect(JSON.stringify(codeWorkflowV1)).toBe(before);
  });

  it('refuses insertions that cannot be placed', () => {
    const fails = (insertions: StageInsertionInput[]) => () =>
      materialiseVariant(codeWorkflowV1, spec(insertions));
    expect(fails([{ after: 'nope', stage: customStage('x') }])).toThrow(/no stage 'nope'/);
    expect(fails([{ after: 'done', stage: customStage('x') }])).toThrow(/final stage/);
    expect(fails([{ after: 'build', stage: customStage('review') }])).toThrow(/already used/);
    expect(fails([{ after: 'build', stage: customStage('x'), redirect: ['nope'] }])).toThrow(
      /no success outcome/,
    );
    // A failure outcome cannot be what a new step follows.
    expect(fails([{ after: 'review', stage: customStage('x'), redirect: ['changes'] }])).toThrow(
      /no success outcome/,
    );
  });

  it('asks for a choice when the stage leads to two different places', () => {
    const base = structuredClone(codeWorkflowV1);
    const build = base.stages.find((x) => x.id === 'build');
    if (build)
      build.outcomes.push({
        ...(build.outcomes[0] as (typeof build.outcomes)[number]),
        id: 'quick',
        to: 'test',
      });
    const ambiguous = spec([{ after: 'build', stage: customStage('x') }]);
    expect(() => materialiseVariant(base, ambiguous)).toThrow(/choose which outcomes/);
    const chosen = spec([{ after: 'build', stage: customStage('x'), redirect: ['quick'] }]);
    const def = materialiseVariant(base, chosen);
    expect(def.stages.find((x) => x.id === 'build')?.outcomes.map((o) => o.to)).toEqual(['review', 'x']);
  });
});

describe('validateVariant', () => {
  it('a variant of code with the investigate template is valid', () => {
    const v = check(spec([investigateInsertion('test')]));
    expect(codes(v.issues)).toEqual([]);
    expect(v.definition?.extends).toEqual({ key: 'code', version: 1 });
  });

  it('inherited stages accept the roles that claim the base stage (the variant key differs)', () => {
    const v = check(
      spec([{ after: 'build', stage: customStage('investigate_x', { claimRole: 'architect' }) }]),
    );
    expect(codes(v.issues)).toEqual([]);
    // The same definition WITHOUT the lineage would fail rule 3 on every base stage.
    const { extends: _drop, ...plain } = v.definition as WorkflowDefinition;
    expect(codes(validateVariantIssues(plain))).toContain('role_cannot_claim_stage');
  });

  it('an inserted step needs a role that may claim it', () => {
    // The writer claims code.docs only: the new step has another id and the writer has no pattern for it.
    const v = check(spec([{ after: 'build', stage: customStage('x', { claimRole: 'writer' }) }]));
    expect(codes(v.issues)).toContain('role_cannot_claim_stage');
    // A role with a pattern claim is fine.
    expect(
      codes(
        check(spec([{ after: 'build', stage: customStage('investigate_x', { claimRole: 'architect' }) }]))
          .issues,
      ),
    ).toEqual([]);
    expect(
      codes(check(spec([{ after: 'build', stage: customStage('x', { claimRole: 'ghost' }) }])).issues),
    ).toContain('unknown_role');
  });

  it('a senior-only step needs a role with a senior level', () => {
    const junior: RoleDefinition = { ...investigator, seniorityLevels: ['junior'] };
    const v = check(spec([investigateInsertion('test')]), codeWorkflowV1, [...OTHER_BUILTINS, junior]);
    expect(codes(v.issues)).toContain('role_not_senior');
  });

  it('report data is only for investigate steps of a role that claims them', () => {
    const bad = spec([
      { after: 'build', stage: customStage('x', { claimRole: 'reviewer', data: 'investigation' }) },
    ]);
    expect(codes(check(bad).issues)).toContain('variant_invalid_insertion');
  });

  it('worktree: create only before the first worktree stage, reuse only after it', () => {
    expect(
      codes(
        check(
          spec([{ after: 'spec', stage: customStage('x', { claimRole: 'reviewer', worktree: 'reuse' }) }]),
        ).issues,
      ),
    ).toContain('variant_invalid_insertion');
    expect(
      codes(
        check(
          spec([{ after: 'build', stage: customStage('y', { claimRole: 'reviewer', worktree: 'create' }) }]),
        ).issues,
      ),
    ).toContain('variant_invalid_insertion');
    expect(
      codes(
        check(
          spec([
            {
              after: 'spec',
              stage: customStage('investigate_z', { claimRole: 'architect', worktree: 'create' }),
            },
          ]),
        ).issues,
      ),
    ).toEqual([]);
  });

  it('the worktree of a step is derived from where it sits when not given', () => {
    const at = (after: string) =>
      materialiseVariant(codeWorkflowV1, spec([{ after, stage: customStage('s') }])).stages.find(
        (x) => x.id === 's',
      )?.worktree;
    expect(at('spec')).toBe('create');
    expect(at('build')).toBe('reuse');
    expect(at('test')).toBe('reuse');
    // A workflow that never uses a worktree gets steps without one.
    const plain = structuredClone(codeWorkflowV1);
    for (const st of plain.stages) st.worktree = 'none';
    expect(
      materialiseVariant(plain, spec([{ after: 'build', stage: customStage('s') }])).stages.find(
        (x) => x.id === 's',
      )?.worktree,
    ).toBe('none');
  });

  it('card types may be narrowed, never widened', () => {
    const narrow = check(spec([investigateInsertion('test')], { cardTypes: ['feature'] }));
    expect(codes(narrow.issues)).toEqual([]);
    expect(narrow.definition?.cardTypes).toEqual(['feature']);
    const wide = check(spec([investigateInsertion('test')], { cardTypes: ['feature', 'support2'] }));
    expect(codes(wide.issues)).toContain('invalid_card_type');
  });

  it('only code and approved custom workflows can be bases', () => {
    const v = check(
      spec([investigateInsertion('test')], { base: { key: 'code-bugfix', version: 1 } }),
      codeBugfixWorkflowV1,
    );
    expect(codes(v.issues)).toContain('variant_base_not_allowed');
    const variant = materialiseVariant(codeWorkflowV1, spec([investigateInsertion('test')]));
    expect(codes(check(spec([{ after: 'build', stage: customStage('q') }]), variant).issues)).toEqual(
      expect.arrayContaining(['variant_base_not_allowed', 'variant_base_mismatch']),
    );
  });

  it('keys follow the custom workflow rules and cannot be built-in', () => {
    expect(codes(check(spec([investigateInsertion('test')], { key: 'code' })).issues)).toContain(
      'builtin_key',
    );
    expect(codes(check(spec([investigateInsertion('test')], { key: 'Code Toy' })).issues)).toContain(
      'invalid_key',
    );
  });

  it('a stored definition that differs from its insertions on the base is flagged', () => {
    const s = spec([investigateInsertion('test')]);
    const def = materialiseVariant(codeWorkflowV1, s);
    expect(codes(validateVariant(s, codeWorkflowV1, ROLES, CTX, { stored: def }).issues)).toEqual([]);
    const tampered = structuredClone(def);
    (tampered.stages.find((x) => x.id === 'build') as { requiredFields: string[] }).requiredFields = [
      'title',
    ];
    expect(codes(validateVariant(s, codeWorkflowV1, ROLES, CTX, { stored: tampered }).issues)).toContain(
      'variant_definition_mismatch',
    );
  });

  it('insertions that name a missing stage come back as issues, not exceptions (rebase on a changed base)', () => {
    const base = structuredClone(codeWorkflowV1);
    base.version = 2;
    base.stages = base.stages.filter((x) => x.id !== 'docs');
    for (const s of base.stages) for (const o of s.outcomes) if (o.to === 'docs') o.to = 'finalize';
    const s = spec([{ after: 'docs', stage: customStage('x', { claimRole: 'reviewer' }) }], {
      base: { key: 'code', version: 2 },
    });
    const v = validateVariant(s, base, ROLES, CTX);
    expect(codes(v.issues)).toEqual(['variant_invalid_insertion']);
    expect(v.definition).toBeUndefined();
  });

  it('the base workflow itself stays valid with the builtin roles', () => {
    expect(
      hasErrors(validateVariant(spec([investigateInsertion('review')]), codeWorkflowV1, ROLES, CTX).issues),
    ).toBe(false);
  });
});

describe('board columns of a variant', () => {
  it('an inserted step column sits where it was inserted, not at the end', () => {
    const def = materialiseVariant(codeWorkflowV1, spec([investigateInsertion('test')]));
    const cols = boardColumnsWith(codeWorkflowV1, [def]);
    expect(cols.indexOf('Investigate & design')).toBeGreaterThan(cols.indexOf('Test'));
    expect(cols.indexOf('Investigate & design')).toBeLessThan(cols.indexOf('Docs'));
    expect(cols[cols.length - 1]).toBe('Done');
  });
});

import { validateWorkflow } from '../src/index.ts';

const validateVariantIssues = (def: unknown) => validateWorkflow(def, ROLES);
