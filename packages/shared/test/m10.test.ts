import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  DEFINITION_FORMAT,
  DomainEventSchema,
  definitionVaultPath,
  ExtendRoleRequestSchema,
  getBuiltinRole,
  parseDefinitionFile,
  type RoleDefinition,
  RoleDraftInputSchema,
  renderChatInstructions,
  renderDefinitionFile,
  validateCustomWorkflow,
  validateRoleDefinition,
  WorkflowDefinitionSchema,
  WorkflowDraftInputSchema,
} from '../src/index.ts';

const U = '018f0000-0000-7000-8000-00000000000a';
const roleCtx = {
  builtinRoleKeys: BUILTIN_ROLES.map((r) => r.key),
  builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key),
  departments: ['delivery', 'support'],
};
const wfCtx = { builtinWorkflowKeys: roleCtx.builtinWorkflowKeys, departments: roleCtx.departments };

const role = (
  key: string,
  stages: Array<[string, string]>,
  over: Partial<RoleDefinition> = {},
): RoleDefinition => ({
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
  claimableStages: stages.map(([workflowKey, stageId]) => ({ workflowKey, stageId })),
  ...over,
});

const stage = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  column: id,
  kind: 'agent',
  claimRole: 'agent',
  doneCriteria: 'done',
  requiredFields: [],
  outcomes: [],
  ...extra,
});
const out = (id: string, to: string, kind = 'success', extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  kind,
  to,
  event: 'StageCompleted',
  ...extra,
});
const workflow = (over: Record<string, unknown> = {}) =>
  WorkflowDefinitionSchema.parse({
    key: 'support',
    version: 1,
    name: 'Support',
    department: 'support',
    builtIn: false,
    fieldSet: 'custom',
    customFields: [{ key: 'customer', label: 'Customer', type: 'text', required: true }],
    cardTypes: ['support'],
    initialStage: 'triage',
    stages: [
      stage('triage', { requiredFields: ['customer'], outcomes: [out('ok', 'resolve')] }),
      stage('resolve', {
        outcomes: [out('done', 'end'), out('back', 'triage', 'failure', { rework: true })],
      }),
      { ...stage('end'), kind: 'terminal', claimRole: null },
    ],
    ...over,
  });
const AGENT = role('agent', [['support', '*']]);
const codes = (issues: Array<{ code: string; severity: string }>) =>
  issues.filter((i) => i.severity === 'error').map((i) => i.code);

describe('custom workflow validation', () => {
  it('accepts a well formed pipeline', () => {
    expect(codes(validateCustomWorkflow(workflow(), [...BUILTIN_ROLES, AGENT], wfCtx))).toEqual([]);
  });

  it('rejects an unreachable stage, a failure path that never ends and an unclaimable stage', () => {
    const unreachable = workflow({
      stages: [...workflow().stages, stage('orphan', { outcomes: [out('x', 'end')] })],
    });
    expect(codes(validateCustomWorkflow(unreachable, [AGENT], wfCtx))).toContain('unreachable_stage');
    const trap = workflow({
      stages: [
        stage('triage', { outcomes: [out('ok', 'resolve')] }),
        stage('resolve', { outcomes: [out('done', 'end'), out('back', 'limbo', 'failure')] }),
        stage('limbo', { outcomes: [out('again', 'limbo')] }),
        { ...stage('end'), kind: 'terminal', claimRole: null },
      ],
    });
    expect(codes(validateCustomWorkflow(trap, [AGENT], wfCtx))).toEqual(
      expect.arrayContaining(['failure_no_path_to_terminal', 'no_path_to_terminal']),
    );
    expect(codes(validateCustomWorkflow(workflow(), [role('agent', [['other', '*']])], wfCtx))).toContain(
      'role_cannot_claim_stage',
    );
    expect(codes(validateCustomWorkflow(workflow(), [], wfCtx))).toContain('unknown_role');
  });

  it('keeps custom workflows off the built-in keys, field sets, events and effects', () => {
    expect(codes(validateCustomWorkflow(workflow({ key: 'code' }), [AGENT], wfCtx))).toContain('builtin_key');
    expect(codes(validateCustomWorkflow(workflow({ fieldSet: 'code' }), [AGENT], wfCtx))).toContain(
      'invalid_field_set',
    );
    expect(codes(validateCustomWorkflow(workflow({ builtIn: true }), [AGENT], wfCtx))).toContain(
      'not_custom',
    );
    expect(codes(validateCustomWorkflow(workflow({ department: 'nowhere' }), [AGENT], wfCtx))).toContain(
      'unknown_department',
    );
    expect(codes(validateCustomWorkflow(workflow({ cardTypes: ['research'] }), [AGENT], wfCtx))).toContain(
      'invalid_card_type',
    );
    const bad = workflow({
      stages: [
        stage('triage', { outcomes: [out('ok', 'resolve', 'success', { event: 'ReviewApproved' })] }),
        stage('resolve', { outcomes: [out('done', 'end', 'success', { effect: 'finalize' })] }),
        { ...stage('end'), kind: 'terminal', claimRole: null },
      ],
    });
    expect(codes(validateCustomWorkflow(bad, [AGENT], wfCtx))).toEqual(
      expect.arrayContaining(['unsupported_custom_event', 'invalid_effect']),
    );
    const manual = workflow({
      stages: [
        stage('triage', { outcomes: [out('ok', 'review')] }),
        stage('review', { kind: 'manual', claimRole: null, outcomes: [out('ok', 'end')] }),
        { ...stage('end'), kind: 'terminal', claimRole: null },
      ],
    });
    expect(codes(validateCustomWorkflow(manual, [AGENT], wfCtx))).toContain('manual_stage_not_initial');
  });

  it('requires a seniority the stage needs, and fields the workflow defines', () => {
    const senior = workflow({
      stages: [
        stage('triage', { seniorOnly: true, outcomes: [out('ok', 'end')] }),
        { ...stage('end'), kind: 'terminal', claimRole: null },
      ],
    });
    const juniorOnly = role('agent', [['support', '*']], { seniorityLevels: ['junior'] });
    expect(codes(validateCustomWorkflow(senior, [juniorOnly], wfCtx))).toContain('role_not_senior');
    const fields = workflow({
      stages: [
        stage('triage', { requiredFields: ['nope'], outcomes: [out('ok', 'end')] }),
        { ...stage('end'), kind: 'terminal', claimRole: null },
      ],
    });
    expect(codes(validateCustomWorkflow(fields, [AGENT], wfCtx))).toContain('unknown_required_field');
  });
});

describe('custom role validation', () => {
  it('accepts a role that claims stages of a custom workflow', () => {
    expect(validateRoleDefinition(role('triager', [['support', 'triage']]), roleCtx)).toEqual([]);
  });

  it('refuses built-in keys, built-in workflows, wildcards, tools and departments that do not exist', () => {
    const c = (r: RoleDefinition) => validateRoleDefinition(r, roleCtx).map((i) => i.code);
    expect(c(role('builder', [['support', '*']]))).toContain('builtin_key');
    expect(c(role('x', [['code', 'review']]))).toContain('claims_builtin_workflow');
    expect(c(role('x', [['*', '*']]))).toContain('wildcard_workflow');
    expect(c(role('x', []))).toContain('no_claimable_stages');
    expect(c(role('x', [['support', '*']], { instructions: '  ' }))).toContain('no_instructions');
    expect(c(role('x', [['support', '*']], { department: 'nowhere' }))).toContain('unknown_department');
    expect(
      c(
        role('x', [['support', '*']], {
          permissions: { ...role('x', []).permissions, allowedTools: ['rm'] },
        }),
      ),
    ).toContain('unknown_tool');
    expect(c(role('x', [['support', '*']], { builtIn: true }))).toContain('not_custom');
  });
});

describe('definition files', () => {
  it('render deterministic, provider neutral YAML that parses back to the same definition', () => {
    const r = role('triager', [['support', 'triage']], {
      instructions: 'Line one.\nLine two: with a colon.',
    });
    const text = renderDefinitionFile({
      kind: 'role',
      definition: r,
      approvedAt: '2026-10-04T10:00:00.000Z',
    });
    expect(text).toContain(`format: ${DEFINITION_FORMAT}`);
    expect(text).toBe(
      renderDefinitionFile({ kind: 'role', definition: r, approvedAt: '2026-10-04T10:00:00.000Z' }),
    );
    const back = parseDefinitionFile(text);
    expect(back).toMatchObject({ kind: 'role', approvedAt: '2026-10-04T10:00:00.000Z' });
    expect(back.definition).toEqual(r);
    const w = workflow();
    const wback = parseDefinitionFile(renderDefinitionFile({ kind: 'workflow', definition: w }));
    expect(wback.definition).toEqual(w);
    expect(definitionVaultPath('workflow', 'support', 2)).toBe('organization/workflows/support/v2.yaml');
    expect(() => parseDefinitionFile('format: other\nkind: role\n')).toThrow();
  });
});

describe('designer contract', () => {
  it('drafts omit the version and built-in flag; extensions are strict so core rules cannot be sent', () => {
    const { version: _v, builtIn: _b, ...input } = role('triager', [['support', 'triage']]);
    expect(RoleDraftInputSchema.safeParse(input).success).toBe(true);
    const wf = workflow();
    const { version: _v2, builtIn: _b2, ...wfInput } = wf;
    expect(WorkflowDraftInputSchema.parse({ ...wfInput, fieldSet: undefined }).fieldSet).toBe('custom');
    expect(ExtendRoleRequestSchema.safeParse({ instructions: 'x', skills: ['a'] }).success).toBe(true);
    expect(ExtendRoleRequestSchema.safeParse({ instructions: 'x', coreRules: [] }).success).toBe(false);
    expect(ExtendRoleRequestSchema.safeParse({ permissions: {} }).success).toBe(false);
  });

  it('the new catalogue events parse', () => {
    const wf = workflow();
    for (const e of [
      { type: 'WorkflowDraftUpdated', payload: { workflowVersionId: U, name: 'x', definition: wf } },
      { type: 'WorkflowVersionSubmitted', payload: { workflowVersionId: U, deskItemId: U } },
      { type: 'RoleDraftUpdated', payload: { roleVersionId: U, definition: role('a', [['support', '*']]) } },
      { type: 'RoleVersionSubmitted', payload: { roleVersionId: U, deskItemId: U } },
      { type: 'DefinitionDraftDiscarded', payload: { kind: 'role', versionId: U } },
      { type: 'DepartmentCreated', payload: { departmentId: U, orgId: U, name: 'support' } },
    ])
      expect(DomainEventSchema.safeParse(e).success, e.type).toBe(true);
  });
});

describe('BA design instructions', () => {
  it('the BA role carries the designer method and the chat prompt lists the verbs', () => {
    const ba = getBuiltinRole('ba');
    for (const w of [
      'aom org catalogue',
      'aom org role draft',
      'aom org workflow draft',
      'aom org submit',
      'aom org department',
    ])
      expect(ba?.instructions, w).toContain(w);
    const text = renderChatInstructions({ name: 'Ben', roleKey: 'ba', seniority: 'senior' }, {});
    expect(text).toContain('# Designing the organization');
    expect(text).toContain('aom org workflow draft');
    expect(
      renderChatInstructions({ name: 'Bea', roleKey: 'builder', seniority: 'junior' }, {}),
    ).not.toContain('Designing the organization');
  });
});

describe('BA chat card creation', () => {
  const ba = { name: 'Ben', roleKey: 'ba', seniority: 'senior' } as const;
  it('tells a desk-chat BA it can create cards with inline JSON, mapping the project first', () => {
    const t = renderChatInstructions(ba, {});
    expect(t).toContain('# Creating cards from this chat');
    expect(t).toContain("aom card create --json '<draft json>'");
    expect(t).toContain('aom intake map --project <KEY>');
    expect(t).toContain('# Designing the organization');
    expect(renderChatInstructions(ba, { projectKey: 'TOY' })).toContain('Project TOY is in context');
  });
  it('only the BA gets it, and an intake chat keeps its own section', () => {
    expect(
      renderChatInstructions({ name: 'Bea', roleKey: 'builder', seniority: 'junior' }, {}),
    ).not.toContain('Creating cards from this chat');
    const intake = { intakeId: U, projects: [], cards: [] };
    const t = renderChatInstructions(ba, { intake });
    expect(t).toContain('# Intake');
    expect(t).not.toContain('# Creating cards from this chat');
    const lazy = renderChatInstructions(ba, {
      intake: { ...intake, fromChat: true, mappedProjectKey: 'TOY' },
    });
    expect(lazy).toContain('mapped to project TOY');
    expect(lazy).not.toContain('# Intake\n');
  });
});
