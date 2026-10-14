import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  boardColumns,
  codeWorkflowV1,
  codeWorkflowV2,
  codeWorkflowV3,
  columnFor,
  DERIVED_BOOLEAN_FIELDS,
  DomainEventSchema,
  fieldCatalogue,
  getStage,
  resolveOutcome,
  roleClaimsStage,
  validateCustomWorkflow,
  validateWorkflow,
  type WorkflowDefinition,
} from '../src/index.ts';

const U = '5b6d3c0e-9b0c-4d6e-8d2e-1f2a3b4c5d6e';

describe('manual QA workflow (code v3)', () => {
  it('validates and keeps v1 and v2 untouched', () => {
    expect(validateWorkflow(codeWorkflowV3, BUILTIN_ROLES)).toEqual([]);
    expect(getStage(codeWorkflowV1, 'manual_qa')).toBeUndefined();
    expect(getStage(codeWorkflowV2, 'manual_qa')).toBeUndefined();
    expect(resolveOutcome(codeWorkflowV2, {}, 'finalize', 'finalized').toStage).toBe('done');
    expect(resolveOutcome(codeWorkflowV1, {}, 'finalize', 'finalized').toStage).toBe('done');
  });

  it('puts qa_steps and manual_qa between finalize and done', () => {
    expect(codeWorkflowV3.stages.map((s) => s.id)).toEqual([
      'spec',
      'investigate',
      'build',
      'review',
      'test',
      'docs',
      'finalize',
      'qa_steps',
      'manual_qa',
      'done',
    ]);
    const qa = getStage(codeWorkflowV3, 'manual_qa');
    expect(qa).toMatchObject({ kind: 'human', claimRole: null, human: { purpose: 'qa' } });
    expect(qa?.outcomes.map((o) => [o.id, o.to, o.event])).toEqual([
      ['pass', 'done', 'QaPassed'],
      ['skip', 'done', 'QaSkipped'],
      ['send_back', 'build', 'QaSentBack'],
    ]);
    expect(qa?.outcomes.find((o) => o.id === 'send_back')?.rework).toBe(true);
    expect(getStage(codeWorkflowV3, 'qa_steps')).toMatchObject({
      kind: 'agent',
      claimRole: 'tester',
      fallbackRole: 'ba',
      worktree: 'none',
    });
  });

  it('routes finalize by the derived flags', () => {
    const to = (view: Record<string, unknown>) =>
      resolveOutcome(codeWorkflowV3, view, 'finalize', 'finalized').toStage;
    expect(to({ manualQa: true, qaAgent: true })).toBe('qa_steps');
    expect(to({ manualQa: true, qaAgent: false })).toBe('manual_qa');
    expect(to({ manualQa: false, qaAgent: false })).toBe('done');
    // A card with no flags (an older caller) goes straight to done: the safe default.
    expect(to({})).toBe('done');
  });

  it('routes the QA outcomes', () => {
    const view = { manualQa: true };
    expect(resolveOutcome(codeWorkflowV3, view, 'qa_steps', 'steps').toStage).toBe('manual_qa');
    expect(resolveOutcome(codeWorkflowV3, view, 'manual_qa', 'pass').toStage).toBe('done');
    expect(resolveOutcome(codeWorkflowV3, view, 'manual_qa', 'skip').toStage).toBe('done');
    expect(resolveOutcome(codeWorkflowV3, view, 'manual_qa', 'send_back').toStage).toBe('build');
  });

  it('the tester claims the steps, and so does the BA (the fallback)', () => {
    const tester = BUILTIN_ROLES.find((r) => r.key === 'tester');
    const ba = BUILTIN_ROLES.find((r) => r.key === 'ba');
    expect(roleClaimsStage(tester as never, 'code', 'qa_steps')).toBe(true);
    expect(roleClaimsStage(ba as never, 'code', 'qa_steps')).toBe(true);
    expect(roleClaimsStage(tester as never, 'code', 'manual_qa')).toBe(false);
  });

  it('shows a QA column before Done and keeps a waiting QA card in it', () => {
    const cols = boardColumns(codeWorkflowV3);
    expect(cols.indexOf('QA')).toBe(cols.indexOf('Finalize') + 1);
    expect(cols[cols.length - 1]).toBe('Done');
    expect(boardColumns(codeWorkflowV2)).not.toContain('QA');
    const qa = getStage(codeWorkflowV3, 'manual_qa') as NonNullable<ReturnType<typeof getStage>>;
    expect(
      columnFor({ status: 'waiting', stage: 'manual_qa', reworkRound: 0, finalizeState: null }, qa),
    ).toBe('QA');
  });

  it('knows the derived flags as boolean fields', () => {
    expect(Object.keys(DERIVED_BOOLEAN_FIELDS).sort()).toEqual(['manualQa', 'qaAgent']);
    expect(fieldCatalogue('code').manualQa?.kind).toBe('boolean');
  });
});

describe('human stages in validation', () => {
  const clone = (): WorkflowDefinition => structuredClone(codeWorkflowV3);
  const codes = (def: unknown) => validateWorkflow(def, BUILTIN_ROLES).map((i) => i.code);

  it('needs the human block, and no role', () => {
    const noBlock = clone();
    delete (noBlock.stages.find((s) => s.id === 'manual_qa') as { human?: unknown }).human;
    expect(codes(noBlock)).toContain('human_missing_config');
    const withRole = clone();
    (withRole.stages.find((s) => s.id === 'manual_qa') as { claimRole: string | null }).claimRole = 'ba';
    expect(codes(withRole)).toContain('human_has_role');
  });

  it('refuses a human block on another kind and a fallback role on a non-agent stage', () => {
    const misplaced = clone();
    (misplaced.stages.find((s) => s.id === 'build') as { human?: unknown }).human = { purpose: 'qa' };
    expect(codes(misplaced)).toContain('human_config_misplaced');
    const fallback = clone();
    (fallback.stages.find((s) => s.id === 'manual_qa') as { fallbackRole?: string }).fallbackRole = 'ba';
    expect(codes(fallback)).toContain('fallback_role_misplaced');
    const unknown = clone();
    (unknown.stages.find((s) => s.id === 'qa_steps') as { fallbackRole?: string }).fallbackRole = 'nobody';
    expect(codes(unknown)).toContain('unknown_fallback_role');
  });

  it('custom workflows cannot use human steps or fallback roles', () => {
    const custom = {
      key: 'review-flow',
      version: 1,
      name: 'Review flow',
      builtIn: false,
      fieldSet: 'custom',
      cardTypes: ['feature'],
      initialStage: 'check',
      stages: [
        {
          id: 'check',
          label: 'Check',
          column: 'Check',
          kind: 'human',
          human: { purpose: 'qa' },
          claimRole: null,
          doneCriteria: 'checked',
          outcomes: [{ id: 'done', label: 'Done', kind: 'success', to: 'end', event: 'StageCompleted' }],
        },
        { id: 'end', label: 'End', column: 'End', kind: 'terminal', claimRole: null, doneCriteria: '' },
      ],
    };
    const issues = validateCustomWorkflow(custom, BUILTIN_ROLES, {
      builtinWorkflowKeys: ['code'],
      departments: [],
    });
    expect(issues.map((i) => i.code)).toContain('human_stage_not_custom');
  });
});

describe('manual QA events', () => {
  it('parses the QA, project setting and held-comment events', () => {
    for (const e of [
      {
        type: 'QaOpened',
        payload: { cardId: U, assigneeUserId: U, source: 'starter', toStage: 'qa_steps', deskItemId: U },
      },
      { type: 'QaStepsPosted', payload: { cardId: U, steps: '- [ ] do it', agentId: U } },
      { type: 'QaAssigned', payload: { cardId: U, assigneeUserId: U, by: U, deskItemId: U } },
      { type: 'QaPassed', payload: { cardId: U, by: U } },
      { type: 'QaSkipped', payload: { cardId: U, by: U, reason: 'no time' } },
      { type: 'QaSentBack', payload: { cardId: U, by: U, comment: 'broken', toStage: 'build' } },
      { type: 'ProjectManualQaSet', payload: { projectId: U, enabled: false, by: U } },
      { type: 'OutboundReleased', payload: { draftId: U, deskItemId: U } },
      {
        type: 'OutboundHeld',
        payload: {
          draftId: U,
          cardId: U,
          externalSystem: 'jira',
          externalKey: 'ABC-1',
          kind: 'resolution',
          body: 'Done.',
        },
      },
      {
        type: 'CardFinalized',
        payload: { cardId: U, action: 'merge', resultRef: {}, toStage: 'manual_qa', workflowVersionId: U },
      },
    ])
      expect(DomainEventSchema.safeParse(e).success, e.type).toBe(true);
  });

  it('a send back needs a comment', () => {
    expect(
      DomainEventSchema.safeParse({
        type: 'QaSentBack',
        payload: { cardId: U, by: U, comment: '', toStage: 'build' },
      }).success,
    ).toBe(false);
  });
});
