import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  codeWorkflowV2,
  codeWorkflowV3,
  DomainEventSchema,
  explainIssue,
  getStage,
  hasErrors,
  materialiseVariant,
  type RoleDefinition,
  resolveOutcome,
  validateCustomWorkflow,
  validateVariant,
  validateWorkflow,
  WorkflowDefinitionSchema,
} from '../src/index.ts';

/** Approval steps (backlog #16): the validator, custom workflows, variants and the events. */

const U = '018f0000-0000-7000-8000-00000000000a';
const role = (key: string): RoleDefinition => ({
  key,
  version: 1,
  name: key,
  purpose: 'p',
  department: 'support',
  builtIn: false,
  instructions: 'Do the work.',
  coreRules: [],
  seniorityLevels: ['junior', 'senior'],
  defaultModel: { runtime: 'claude-code', model: 'sonnet' },
  permissions: {
    allowedTools: ['read'],
    deniedShellPatterns: [],
    writableGlobs: null,
    mayCommit: false,
    browser: false,
    readOrgRepos: false,
    riskTiers: ['small', 'large'],
    repoIds: null,
  },
  skills: [],
  claimableStages: [{ workflowKey: '*', stageId: '*' }],
});
const ROLES = [...BUILTIN_ROLES, role('worker')];
const ctx = { builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key), departments: [] as string[] };
const out = (id: string, to: string, kind: 'success' | 'failure' = 'success', extra = {}) => ({
  id,
  label: id,
  kind,
  to,
  event: 'StageCompleted',
  ...extra,
});
const flow = (human: object | undefined, outcomes: object[], over: Record<string, unknown> = {}) => ({
  key: 'approve-flow',
  version: 1,
  name: 'Approve flow',
  builtIn: false,
  fieldSet: 'custom',
  cardTypes: ['feature'],
  initialStage: 'work',
  stages: [
    {
      id: 'work',
      label: 'Work',
      column: 'Work',
      kind: 'agent',
      claimRole: 'worker',
      doneCriteria: 'done',
      outcomes: [out('done', 'approval')],
    },
    {
      id: 'approval',
      label: 'Owner approves',
      column: 'Approval',
      kind: 'human',
      ...(human ? { human } : {}),
      claimRole: null,
      doneCriteria: 'approved',
      outcomes,
      ...over,
    },
    { id: 'end', label: 'End', column: 'End', kind: 'terminal', claimRole: null, doneCriteria: '' },
  ],
});
const APPROVE = out('approve', 'end');
const SEND_BACK = out('send_back', 'work', 'failure', { rework: true });
const HUMAN = { purpose: 'approval', approver: { kind: 'org_owner' } };
const codes = (d: unknown) => validateCustomWorkflow(d, ROLES, ctx).map((i) => i.code);

describe('approval steps in a custom workflow', () => {
  it('are valid with an approver, approve and send_back (a send back counts as rework)', () => {
    for (const approver of [
      { kind: 'org_owner' },
      { kind: 'project_owner' },
      { kind: 'starter' },
      { kind: 'member', userId: U },
    ])
      expect(codes(flow({ purpose: 'approval', approver }, [APPROVE, SEND_BACK])), approver.kind).toEqual([]);
  });

  it('need an approver, and only approval steps have one', () => {
    expect(codes(flow({ purpose: 'approval' }, [APPROVE, SEND_BACK]))).toContain('approval_missing_approver');
    expect(
      codes(flow({ purpose: 'qa', approver: { kind: 'org_owner' } }, [out('pass', 'end'), SEND_BACK])),
    ).toContain('approver_misplaced');
    expect(
      codes(
        flow({ purpose: 'approval', approver: { kind: 'member', userId: 'nope' } }, [APPROVE, SEND_BACK]),
      ),
    ).toContain('invalid_schema');
  });

  it('offer exactly approve and send_back', () => {
    expect(codes(flow(HUMAN, [APPROVE]))).toContain('human_outcomes');
    expect(codes(flow(HUMAN, [out('approve', 'end', 'failure'), SEND_BACK]))).toContain('human_outcomes');
    expect(codes(flow(HUMAN, [APPROVE, SEND_BACK, out('maybe', 'end')]))).toContain('human_outcomes');
    expect(codes(flow(HUMAN, [APPROVE, out('send_back', 'work', 'failure', { rework: false })]))).toContain(
      'human_outcomes',
    );
  });

  it('send back to an earlier agent step that leads to the approval', () => {
    const bad = (to: string) => [APPROVE, out('send_back', to, 'failure', { rework: true })];
    expect(codes(flow(HUMAN, bad('approval')))).toContain('approval_send_back_target');
    expect(codes(flow(HUMAN, bad('end')))).toContain('approval_send_back_target');
    // a step that exists but does not lead here
    const detached = flow(HUMAN, bad('side'));
    detached.stages.splice(2, 0, {
      id: 'side',
      label: 'Side',
      column: 'Side',
      kind: 'agent',
      claimRole: 'worker',
      doneCriteria: 'x',
      outcomes: [out('done', 'end')],
    } as never);
    expect(codes(detached)).toContain('approval_send_back_target');
  });

  it('resolve like any other step', () => {
    const def = WorkflowDefinitionSchema.parse(flow(HUMAN, [APPROVE, SEND_BACK]));
    expect(resolveOutcome(def, {}, 'approval', 'approve').toStage).toBe('end');
    expect(resolveOutcome(def, {}, 'approval', 'send_back')).toMatchObject({ toStage: 'work' });
  });

  it('keep QA steps working in custom workflows too (pass and send_back, skip optional)', () => {
    const qa = { purpose: 'qa' };
    expect(codes(flow(qa, [out('pass', 'end'), SEND_BACK]))).toEqual([]);
    expect(codes(flow(qa, [out('pass', 'end'), out('skip', 'end'), SEND_BACK]))).toEqual([]);
    expect(codes(flow(qa, [out('pass', 'end')]))).toContain('human_outcomes');
    expect(codes(flow(undefined, [APPROVE, SEND_BACK]))).toContain('human_missing_config');
  });

  it('still have no roles or fallback roles', () => {
    expect(codes(flow(HUMAN, [APPROVE, SEND_BACK], { claimRole: 'worker' }))).toContain('human_has_role');
    expect(codes(flow(HUMAN, [APPROVE, SEND_BACK], { fallbackRole: 'ba' }))).toContain(
      'fallback_role_misplaced',
    );
  });

  it('read in plain words', () => {
    const def = flow({ purpose: 'approval' }, [APPROVE, SEND_BACK]);
    const issues = validateCustomWorkflow(def, ROLES, ctx);
    const text = issues
      .map((i) => explainIssue(i, WorkflowDefinitionSchema.parse(def) as never).text)
      .join(' ');
    expect(text).toMatch(/who approves/);
  });

  it('leave the built-in v3 workflow valid', () => {
    expect(hasErrors(validateWorkflow(codeWorkflowV3, BUILTIN_ROLES))).toBe(false);
  });
});

describe('approval steps inserted into a project workflow', () => {
  const spec = (stage: Record<string, unknown>, after = 'test') => ({
    key: 'code-approve',
    name: 'Code with approval',
    projectId: U,
    base: { key: 'code', version: 2 },
    insertions: [
      {
        after,
        stage: {
          id: 'owner_ok',
          label: 'Owner approves',
          doneCriteria: 'The Owner approved.',
          kind: 'approval',
          ...stage,
        },
      },
    ],
  });

  it('become a human step after the chosen step, sending back to it by default', () => {
    const def = materialiseVariant(codeWorkflowV2, spec({}) as never);
    const ids = def.stages.map((s) => s.id);
    expect(ids.indexOf('owner_ok')).toBe(ids.indexOf('test') + 1);
    const step = getStage(def, 'owner_ok');
    expect(step).toMatchObject({
      kind: 'human',
      human: { purpose: 'approval', approver: { kind: 'org_owner' } },
    });
    expect(step?.outcomes.map((o) => [o.id, o.rework])).toEqual([
      ['approve', false],
      ['send_back', true],
    ]);
    expect(step?.outcomes.find((o) => o.id === 'send_back')?.to).toBe('test');
    expect(getStage(def, 'test')?.outcomes.find((o) => o.to === 'owner_ok')).toBeTruthy();
  });

  it('validate, with a named approver and a chosen send-back step', () => {
    const v = validateVariant(
      spec({ approver: { kind: 'member', userId: U }, sendBackTo: 'build' }),
      codeWorkflowV2,
      BUILTIN_ROLES,
      ctx,
    );
    expect(hasErrors(v.issues), JSON.stringify(v.issues)).toBe(false);
    expect(getStage(v.definition as never, 'owner_ok')?.outcomes.find((o) => o.id === 'send_back')?.to).toBe(
      'build',
    );
  });

  it('refuse a send back to a step that does not lead to the approval, and an agent step without a role', () => {
    const bad = validateVariant(spec({ sendBackTo: 'finalize' }), codeWorkflowV2, BUILTIN_ROLES, ctx);
    expect(bad.issues.map((i) => i.code)).toContain('approval_send_back_target');
    const noRole = validateVariant(spec({ kind: 'agent' }), codeWorkflowV2, BUILTIN_ROLES, ctx);
    expect(noRole.issues.map((i) => i.code)).toContain('variant_invalid_insertion');
  });
});

describe('approval events', () => {
  it('parse', () => {
    for (const e of [
      {
        type: 'ApprovalRequested',
        payload: {
          cardId: U,
          stageId: 'approval',
          approverUserId: U,
          approverKind: 'org_owner',
          deskItemId: U,
          entrySeq: '12',
        },
      },
      {
        type: 'ApprovalDecided',
        payload: {
          cardId: U,
          stageId: 'approval',
          decision: 'sent_back',
          by: U,
          note: 'no',
          toStage: 'work',
        },
      },
      { type: 'QaPassed', payload: { cardId: U, by: U, toStage: 'end' } },
    ])
      expect(DomainEventSchema.safeParse(e).success, e.type).toBe(true);
    expect(
      DomainEventSchema.safeParse({
        type: 'ApprovalDecided',
        payload: { cardId: U, stageId: 'a', decision: 'maybe', by: U, toStage: 'x' },
      }).success,
    ).toBe(false);
  });
});
