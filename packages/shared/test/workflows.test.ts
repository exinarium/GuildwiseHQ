import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  codeBugfixWorkflowV1,
  codeWorkflowV1,
  DomainEventSchema,
  feedWorkflowV1,
  getBuiltinWorkflow,
  getOutcome,
  hasErrors,
  type IssueCode,
  researchWorkflowV1,
  resolveOutcome,
  validateWorkflow,
  type WorkflowDefinition,
  WorkflowResolveError,
  workflowHasTestStage,
  workflowUsesRepos,
} from '../src/index.ts';

const clone = (): WorkflowDefinition => structuredClone(codeWorkflowV1);
const stage = (def: WorkflowDefinition, id: string) => {
  const s = def.stages.find((x) => x.id === id);
  if (!s) throw new Error(`no stage ${id}`);
  return s;
};
const codesOf = (def: unknown, roles = BUILTIN_ROLES) => validateWorkflow(def, roles).map((i) => i.code);
const expectCode = (def: unknown, code: IssueCode, roles = BUILTIN_ROLES) => {
  const issues = validateWorkflow(def, roles);
  expect(
    issues.map((i) => i.code),
    JSON.stringify(issues),
  ).toContain(code);
  expect(issues.find((i) => i.code === code)?.severity).toBe('error');
};

describe('built-in workflows', () => {
  it.each(BUILTIN_WORKFLOWS.map((w) => [`${w.key} v${w.version}`, w] as const))(
    '%s validates with no issues',
    (_n, w) => {
      expect(validateWorkflow(w, BUILTIN_ROLES)).toEqual([]);
    },
  );

  it('exposes all four v1 definitions', () => {
    expect(BUILTIN_WORKFLOWS.map((w) => w.key).sort()).toEqual(['code', 'code-bugfix', 'feed', 'research']);
    expect(getBuiltinWorkflow('code')).toBe(codeWorkflowV1);
    expect(getBuiltinWorkflow('code', 2)).toBeUndefined();
    expect(getBuiltinWorkflow('nope')).toBeUndefined();
  });

  it('registers as a WorkflowVersionRegistered event', () => {
    for (const w of [codeWorkflowV1, codeBugfixWorkflowV1, researchWorkflowV1, feedWorkflowV1]) {
      const r = DomainEventSchema.safeParse({
        type: 'WorkflowVersionRegistered',
        payload: {
          workflowVersionId: '019e3f6a-7b1c-7a2d-8c3e-0123456789ab',
          orgId: null,
          key: w.key,
          version: w.version,
          name: w.name,
          definition: w,
          status: 'active',
        },
      });
      expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
    }
  });

  it('matches the code v1 table', () => {
    expect(codeWorkflowV1.stages.map((s) => [s.id, s.kind, s.claimRole])).toEqual([
      ['spec', 'manual', null],
      ['build', 'agent', 'builder'],
      ['review', 'agent', 'reviewer'],
      ['test', 'agent', 'tester'],
      ['docs', 'agent', 'writer'],
      ['finalize', 'agent', 'ba'],
      ['done', 'terminal', null],
    ]);
    expect(stage(codeWorkflowV1, 'review').approvals).toEqual({ small: 1, large: 2 });
    expect(stage(codeWorkflowV1, 'review').seniorOnly).toBe(true);
    expect(getOutcome(codeWorkflowV1, 'review', 'changes')).toMatchObject({
      rework: true,
      kind: 'failure',
      to: 'build',
    });
    expect(getOutcome(codeWorkflowV1, 'test', 'fail')).toMatchObject({
      effect: 'spawn_bug_child',
      to: 'test',
    });
  });
});

describe('validateWorkflow: one failing fixture per rule', () => {
  it('rule 1: schema must parse', () => {
    expectCode({ key: 'x' }, 'invalid_schema');
  });
  it('rule 1: duplicate stage ids', () => {
    const d = clone();
    d.stages.push({ ...stage(d, 'docs') });
    expectCode(d, 'duplicate_stage_id');
  });
  it('rule 1: duplicate outcome ids', () => {
    const d = clone();
    stage(d, 'review').outcomes.push({ ...stage(d, 'review').outcomes[0]! });
    expectCode(d, 'duplicate_outcome_id');
  });
  it('rule 1: initialStage must exist', () => {
    const d = clone();
    d.initialStage = 'nowhere';
    expectCode(d, 'missing_initial_stage');
  });

  it('rule 2: needs a terminal stage', () => {
    const d = clone();
    stage(d, 'done').kind = 'manual';
    expectCode(d, 'no_terminal_stage');
  });
  it('rule 2: terminal stages have no outcomes', () => {
    const d = clone();
    stage(d, 'done').outcomes.push({ ...stage(d, 'spec').outcomes[0]! });
    expectCode(d, 'terminal_has_outcomes');
  });
  it('rule 2: non-terminal stages need outcomes', () => {
    const d = clone();
    stage(d, 'docs').outcomes = [];
    expectCode(d, 'no_outcomes');
  });
  it('rule 2: needs a success outcome', () => {
    const d = clone();
    stage(d, 'build').outcomes[0]!.kind = 'failure';
    expectCode(d, 'no_success_outcome');
  });

  it('rule 3: agent stage needs claimRole', () => {
    const d = clone();
    stage(d, 'build').claimRole = null;
    expectCode(d, 'agent_stage_without_role');
  });
  it('rule 3: claimRole must exist in the catalogue', () => {
    const d = clone();
    stage(d, 'build').claimRole = 'wizard';
    expectCode(d, 'unknown_role');
  });
  it('rule 3: role must be able to claim the stage', () => {
    const d = clone();
    stage(d, 'build').claimRole = 'reviewer';
    expectCode(d, 'role_cannot_claim_stage');
  });
  it('rule 3: wildcard claimableStages are honoured', () => {
    const d = clone();
    stage(d, 'build').claimRole = 'wild';
    const wild = { ...BUILTIN_ROLES[1]!, key: 'wild', claimableStages: [{ workflowKey: '*', stageId: '*' }] };
    expect(codesOf(d, [...BUILTIN_ROLES, wild])).not.toContain('role_cannot_claim_stage');
  });
  it('rule 3: senior-only stages need a role with a senior level', () => {
    const d = clone();
    const juniorReviewer = {
      ...BUILTIN_ROLES.find((r) => r.key === 'reviewer')!,
      seniorityLevels: ['junior' as const],
    };
    expectCode(d, 'role_not_senior', [...BUILTIN_ROLES.filter((r) => r.key !== 'reviewer'), juniorReviewer]);
  });

  it('rule 4: outcome targets must exist', () => {
    const d = clone();
    stage(d, 'build').outcomes[0]!.to = 'ghost';
    expectCode(d, 'unknown_outcome_target');
  });

  it('rule 5: every stage reachable from initialStage', () => {
    const d = clone();
    d.stages.splice(d.stages.length - 1, 0, {
      ...stage(d, 'spec'),
      id: 'orphan',
      outcomes: [{ ...stage(d, 'spec').outcomes[0]!, to: 'done' }],
    });
    expectCode(d, 'unreachable_stage');
  });
  it('rule 5: a when-skip edge keeps the stage after a skipped stage reachable', () => {
    // docs is skipped when docsNeeded is false, so finalize must stay reachable via docs' success outcome.
    const d = clone();
    stage(d, 'test').outcomes[0]!.to = 'docs';
    expect(codesOf(d)).not.toContain('unreachable_stage');
  });

  it('rule 6: every stage must reach a terminal', () => {
    const d = clone();
    stage(d, 'build').outcomes = [{ ...stage(d, 'build').outcomes[0]!, to: 'build' }];
    expectCode(d, 'no_path_to_terminal');
  });
  it('rule 6: failure outcomes must lead somewhere that ends', () => {
    const d = clone();
    d.stages.splice(1, 0, {
      ...stage(d, 'docs'),
      id: 'trap',
      when: undefined,
      outcomes: [{ ...stage(d, 'docs').outcomes[0]!, to: 'trap' }],
    });
    stage(d, 'review').outcomes[1]!.to = 'trap';
    expectCode(d, 'failure_no_path_to_terminal');
  });

  it('rule 7: requiredFields must exist in the field set or customFields', () => {
    const d = clone();
    stage(d, 'build').requiredFields.push('nope');
    expectCode(d, 'unknown_required_field');
    d.customFields.push({ key: 'nope', label: 'Nope', type: 'text', required: false });
    expect(codesOf(d)).not.toContain('unknown_required_field');
  });

  it('rule 8: spawn_bug_child only on same-stage outcomes', () => {
    const d = clone();
    stage(d, 'test').outcomes[1]!.to = 'build';
    expectCode(d, 'invalid_effect');
  });
  it('rule 8: finalize only to a terminal stage', () => {
    const d = clone();
    stage(d, 'build').outcomes[0]!.effect = 'finalize';
    expectCode(d, 'invalid_effect');
  });
  it('rule 8: resume_parent only when cardTypes contains bug', () => {
    const d = structuredClone(researchWorkflowV1);
    stage(d, 'factcheck').outcomes[0]!.effect = 'resume_parent';
    expectCode(d, 'invalid_effect');
  });

  it('rule 9: when.field must be a boolean field', () => {
    const d = clone();
    stage(d, 'docs').when = { field: 'title', equals: true };
    expectCode(d, 'when_field_not_boolean');
    stage(d, 'docs').when = { field: 'ghost', equals: true };
    expectCode(d, 'when_field_not_boolean');
  });

  it('warnings do not block', () => {
    const d = clone();
    stage(d, 'build').doneCriteria = '';
    const issues = validateWorkflow(d, BUILTIN_ROLES);
    expect(issues).toEqual([expect.objectContaining({ code: 'missing_done_criteria', severity: 'warning' })]);
    expect(hasErrors(issues)).toBe(false);
  });
  it('warns above 12 stages', () => {
    const d = clone();
    for (let i = 0; i < 6; i++)
      d.stages.splice(1, 0, {
        ...stage(d, 'docs'),
        id: `extra${i}`,
        when: undefined,
        outcomes: [{ ...stage(d, 'docs').outcomes[0]!, to: 'done' }],
      });
    expect(codesOf(d)).toContain('too_many_stages');
  });
});

describe('resolveOutcome', () => {
  it('test pass skips docs when docsNeeded is false', () => {
    expect(resolveOutcome(codeWorkflowV1, { docsNeeded: false }, 'test', 'pass')).toEqual({
      event: 'TestPassed',
      toStage: 'finalize',
    });
  });
  it('test pass goes to docs when docsNeeded is true', () => {
    expect(resolveOutcome(codeWorkflowV1, { docsNeeded: true }, 'test', 'pass')).toEqual({
      event: 'TestPassed',
      toStage: 'docs',
    });
  });
  it('reads when.field from card.fields too', () => {
    expect(resolveOutcome(codeWorkflowV1, { fields: { docsNeeded: true } }, 'test', 'pass').toStage).toBe(
      'docs',
    );
  });
  it('plain transitions', () => {
    expect(resolveOutcome(codeWorkflowV1, {}, 'build', 'handoff')).toEqual({
      event: 'ReviewRequested',
      toStage: 'review',
    });
    expect(resolveOutcome(codeWorkflowV1, {}, 'review', 'changes')).toEqual({
      event: 'ChangesRequested',
      toStage: 'build',
    });
    expect(resolveOutcome(codeWorkflowV1, {}, 'test', 'fail')).toEqual({
      event: 'TestFailed',
      toStage: 'test',
    });
    expect(resolveOutcome(codeWorkflowV1, {}, 'finalize', 'finalized')).toEqual({
      event: 'CardFinalized',
      toStage: 'done',
    });
    expect(resolveOutcome(codeBugfixWorkflowV1, {}, 'review', 'approve')).toEqual({
      event: 'StageCompleted',
      toStage: 'done',
    });
    expect(resolveOutcome(researchWorkflowV1, {}, 'factcheck', 'unsupported').toStage).toBe('research');
    expect(resolveOutcome(feedWorkflowV1, {}, 'curate', 'digest').event).toBe('DigestPosted');
  });
  it('throws typed errors for unknown stage/outcome', () => {
    expect(() => resolveOutcome(codeWorkflowV1, {}, 'nope', 'x')).toThrow(WorkflowResolveError);
    expect(() => resolveOutcome(codeWorkflowV1, {}, 'build', 'x')).toThrow(/no outcome/);
  });
});

describe('workflow capability predicates', () => {
  it('code uses repos and has a test stage; research and feed have neither', () => {
    expect(workflowUsesRepos(codeWorkflowV1)).toBe(true);
    expect(workflowHasTestStage(codeWorkflowV1)).toBe(true);
    for (const wf of [researchWorkflowV1, feedWorkflowV1]) {
      expect(workflowUsesRepos(wf)).toBe(false);
      expect(workflowHasTestStage(wf)).toBe(false);
    }
  });
});
