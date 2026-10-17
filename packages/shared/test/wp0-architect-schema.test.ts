import { describe, expect, it } from 'vitest';
import {
  AgentPermissionsSchema,
  allowedOutcomes,
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  CodeFieldsSchema,
  checkPermissions,
  codeWorkflowV1,
  fieldCatalogue,
  hasErrors,
  InvestigationDataSchema,
  isValidReportPath,
  missingForSpecify,
  outcomeApplies,
  outcomeDataSchema,
  type RoleDefinition,
  requiredForSpecify,
  resolveOutcome,
  roleClaimsStage,
  stageIdMatches,
  validateRoleDefinition,
  validateWorkflow,
  type WorkflowDefinition,
  WorkflowDefinitionSchema,
  WorkflowResolveError,
} from '../src/index.ts';

const stageOf = (def: WorkflowDefinition, id: string) => {
  const s = def.stages.find((x) => x.id === id);
  if (!s) throw new Error(`no stage ${id}`);
  return s;
};

const outcomeAt = (def: WorkflowDefinition, stageId: string, index: number) => {
  const o = stageOf(def, stageId).outcomes[index];
  if (!o) throw new Error(`no outcome ${stageId}[${index}]`);
  return o;
};

/** code v1 with an inserted `investigate` stage (skipped unless designNeeded) and guarded outcomes. */
function withInvestigate(): WorkflowDefinition {
  const def = structuredClone(codeWorkflowV1);
  def.version = 2;
  outcomeAt(def, 'spec', 0).to = 'investigate';
  stageOf(def, 'build').syncMainBefore = true;
  def.stages.splice(1, 0, {
    id: 'investigate',
    label: 'Investigate & design',
    column: 'Investigate',
    kind: 'agent',
    claimRole: 'architect',
    seniorOnly: true,
    requiredFields: ['title', 'cardType', 'context', 'requirements', 'repoId'],
    doneCriteria: 'Report written.',
    when: { field: 'designNeeded', equals: true },
    worktree: 'create',
    rebaseBefore: false,
    syncMainBefore: true,
    maxShiftMinutes: 90,
    requiredCapabilities: [],
    environment: 'none',
    outcomes: [
      {
        id: 'handoff',
        label: 'Design ready',
        kind: 'success',
        to: 'build',
        event: 'StageCompleted',
        data: 'investigation',
        rework: false,
        effect: 'none',
        when: { field: 'investigationOnly', equals: false },
      },
      {
        id: 'report',
        label: 'Report ready',
        kind: 'success',
        to: 'finalize',
        event: 'StageCompleted',
        data: 'investigation',
        rework: false,
        effect: 'none',
        when: { field: 'investigationOnly', equals: true },
      },
    ],
  });
  return def;
}

const architect: RoleDefinition = {
  key: 'architect',
  version: 1,
  name: 'Architect',
  purpose: 'x',
  builtIn: false,
  instructions: 'x',
  coreRules: [],
  seniorityLevels: ['senior'],
  defaultModel: { runtime: 'claude-code', model: 'opus' },
  permissions: AgentPermissionsSchema.parse({
    allowedTools: ['read'],
    deniedShellPatterns: [],
    writableGlobs: null,
    mayCommit: true,
    repoIds: null,
  }),
  skills: [],
  claimableStages: [{ workflowKey: '*', stageId: 'investigate*' }],
};
const roles = [...BUILTIN_ROLES, architect];

describe('backward compatibility', () => {
  it('parses every built-in workflow with the new fields defaulted', () => {
    for (const def of BUILTIN_WORKFLOWS) {
      const parsed = WorkflowDefinitionSchema.parse(def);
      expect(parsed.extends).toBeUndefined();
      for (const s of parsed.stages) {
        // Only the code v2+ stages that create a worktree sync main; guards only exist on its investigate stage.
        if (!(def.key.startsWith('code') && def.version >= 2) && def.key !== 'code-v6') {
          expect(s.syncMainBefore).toBe(false);
          for (const o of s.outcomes) expect(o.when).toBeUndefined();
        }
      }
    }
  });
  it('role permissions without readOrgRepos default to false', () => {
    const p = AgentPermissionsSchema.parse({
      allowedTools: [],
      deniedShellPatterns: [],
      writableGlobs: null,
      mayCommit: false,
      repoIds: null,
    });
    expect(p.readOrgRepos).toBe(false);
  });
});

describe('workflow schema additions', () => {
  it('accepts extends, syncMainBefore, outcome.when and the investigation data kind', () => {
    const def = { ...withInvestigate(), extends: { key: 'code', version: 1 } };
    const parsed = WorkflowDefinitionSchema.parse(def);
    expect(parsed.extends).toEqual({ key: 'code', version: 1 });
    expect(stageOf(parsed, 'build').syncMainBefore).toBe(true);
    expect(outcomeAt(parsed, 'investigate', 0).data).toBe('investigation');
  });
  it('rejects a malformed extends', () => {
    expect(() =>
      WorkflowDefinitionSchema.parse({ ...withInvestigate(), extends: { key: 'code' } }),
    ).toThrow();
  });
});

describe('outcome guards: resolve', () => {
  const def = withInvestigate();
  it('outcomeApplies: absent guard always applies; missing boolean field counts as false', () => {
    expect(outcomeApplies({}, {})).toBe(true);
    expect(outcomeApplies({ when: { field: 'investigationOnly', equals: false } }, {})).toBe(true);
    expect(outcomeApplies({ when: { field: 'investigationOnly', equals: true } }, {})).toBe(false);
    expect(outcomeApplies({ when: { field: 'x', equals: true } }, { fields: { x: true } })).toBe(true);
  });
  it('allowedOutcomes lists only the outcomes whose guard holds', () => {
    expect(allowedOutcomes(def, { investigationOnly: false }, 'investigate').map((o) => o.id)).toEqual([
      'handoff',
    ]);
    expect(allowedOutcomes(def, { investigationOnly: true }, 'investigate').map((o) => o.id)).toEqual([
      'report',
    ]);
    expect(allowedOutcomes(def, {}, 'nope')).toEqual([]);
    expect(allowedOutcomes(codeWorkflowV1, {}, 'build').length).toBe(
      stageOf(codeWorkflowV1, 'build').outcomes.length,
    );
  });
  it('resolveOutcome refuses a guarded outcome that does not apply', () => {
    expect(resolveOutcome(def, { investigationOnly: false }, 'investigate', 'handoff')).toEqual({
      event: 'StageCompleted',
      toStage: 'build',
    });
    expect(resolveOutcome(def, { investigationOnly: true }, 'investigate', 'report').toStage).toBe(
      'finalize',
    );
    for (const [card, id] of [
      [{ investigationOnly: true }, 'handoff'],
      [{ investigationOnly: false }, 'report'],
    ] as const) {
      try {
        resolveOutcome(def, card, 'investigate', id);
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(WorkflowResolveError);
        expect((e as WorkflowResolveError).code).toBe('outcome_not_allowed');
      }
    }
  });
  it('skip + guard: spec skips a when-inactive investigate stage', () => {
    expect(resolveOutcome(def, { designNeeded: false }, 'spec', 'specified').toStage).toBe('build');
    expect(resolveOutcome(def, { designNeeded: true }, 'spec', 'specified').toStage).toBe('investigate');
  });
  it('a skipped stage with guarded success outcomes continues through the allowed one', () => {
    expect(
      resolveOutcome(def, { designNeeded: false, investigationOnly: true }, 'spec', 'specified').toStage,
    ).toBe('finalize');
  });
});

describe('outcome guards: validation', () => {
  const issues = (def: unknown) => validateWorkflow(def, roles);
  it('the guarded code v2 shape is valid', () => {
    expect(hasErrors(issues(withInvestigate())), JSON.stringify(issues(withInvestigate()))).toBe(false);
  });
  it('rule 2: guards that leave a combination uncovered are an error', () => {
    const def = withInvestigate();
    const inv = stageOf(def, 'investigate');
    inv.outcomes = [outcomeAt(def, 'investigate', 0)]; // only investigationOnly=false is covered
    const found = issues(def).find((i) => i.code === 'outcome_guard_gap');
    expect(found?.severity).toBe('error');
    expect(found?.rule).toBe(2);
    expect(found?.message).toContain('investigationOnly=true');
  });
  it('rule 2: an unguarded success outcome covers every value', () => {
    const def = withInvestigate();
    const inv = stageOf(def, 'investigate');
    inv.outcomes = [
      outcomeAt(def, 'investigate', 0),
      { ...outcomeAt(def, 'investigate', 1), id: 'fallback', when: undefined },
    ];
    expect(issues(def).map((i) => i.code)).not.toContain('outcome_guard_gap');
  });
  it('rule 9: an outcome guard on a non-boolean field is an error', () => {
    const def = withInvestigate();
    outcomeAt(def, 'investigate', 0).when = { field: 'title', equals: true };
    const found = issues(def).find((i) => i.code === 'when_field_not_boolean' && i.outcomeId === 'handoff');
    expect(found?.rule).toBe(9);
  });
  it('rule 9: a non-boolean comparison value is an error', () => {
    const def = withInvestigate();
    outcomeAt(def, 'investigate', 0).when = { field: 'designNeeded', equals: 'yes' };
    expect(issues(def).some((i) => i.code === 'when_field_not_boolean' && i.outcomeId === 'handoff')).toBe(
      true,
    );
  });
  it('rule 3: the architect claims investigate stages by prefix; other stage ids are refused', () => {
    expect(issues(withInvestigate()).map((i) => i.code)).not.toContain('role_cannot_claim_stage');
    const other = withInvestigate();
    stageOf(other, 'investigate').id = 'design';
    outcomeAt(other, 'spec', 0).to = 'design';
    expect(issues(other).map((i) => i.code)).toContain('role_cannot_claim_stage');
  });
});

describe('roleClaimsStage prefix matching', () => {
  it('stageIdMatches', () => {
    expect(stageIdMatches('investigate*', 'investigate')).toBe(true);
    expect(stageIdMatches('investigate*', 'investigate_after_test')).toBe(true);
    expect(stageIdMatches('investigate*', 'build')).toBe(false);
    expect(stageIdMatches('*', 'anything')).toBe(true);
    expect(stageIdMatches('build', 'build')).toBe(true);
    expect(stageIdMatches('build', 'build2')).toBe(false);
    expect(stageIdMatches('inv*', 'in')).toBe(false);
  });
  it('roleClaimsStage with a wildcard workflow and a stage prefix', () => {
    expect(roleClaimsStage(architect, 'code', 'investigate')).toBe(true);
    expect(roleClaimsStage(architect, 'my-flow', 'investigate_after_test')).toBe(true);
    expect(roleClaimsStage(architect, 'code', 'build')).toBe(false);
  });
  it('exact claims of existing roles are unchanged', () => {
    const builder = BUILTIN_ROLES.find((r) => r.key === 'builder');
    if (!builder) throw new Error('no builder');
    expect(roleClaimsStage(builder, 'code', 'build')).toBe(true);
    expect(roleClaimsStage(builder, 'code', 'review')).toBe(false);
  });
});

describe('readOrgRepos permission', () => {
  const base = AgentPermissionsSchema.parse({
    allowedTools: ['read'],
    deniedShellPatterns: [],
    writableGlobs: null,
    mayCommit: false,
    repoIds: null,
  });
  it('widening to readOrgRepos needs the owner', () => {
    const r = checkPermissions(base, { ...base, readOrgRepos: true });
    expect(r.forbidden).toEqual([]);
    expect(r.widened.join()).toContain('organization');
    expect(
      checkPermissions({ ...base, readOrgRepos: true }, { ...base, readOrgRepos: true }).widened,
    ).toEqual([]);
  });
  it('custom role validation warns when it is set', () => {
    const ctx = { builtinRoleKeys: [], builtinWorkflowKeys: ['code'], departments: [] };
    const custom = {
      ...architect,
      key: 'surveyor',
      claimableStages: [{ workflowKey: 'mine', stageId: 'survey*' }],
      permissions: { ...architect.permissions, readOrgRepos: true },
    };
    const found = validateRoleDefinition(custom, ctx).filter((i) => i.code === 'reads_org_repos');
    expect(found.map((i) => i.severity)).toEqual(['warning']);
    const off = { ...custom, permissions: { ...custom.permissions, readOrgRepos: false } };
    expect(validateRoleDefinition(off, ctx).some((i) => i.code === 'reads_org_repos')).toBe(false);
  });
});

describe('card fields', () => {
  it('designNeeded and investigationOnly are boolean card columns', () => {
    const cat = fieldCatalogue('code');
    expect(cat.designNeeded?.kind).toBe('boolean');
    expect(cat.investigationOnly?.kind).toBe('boolean');
    expect(cat.reportPath?.kind).toBe('text');
  });
  it('reportPath: relative or vault:, no .., no absolute', () => {
    for (const ok of ['docs/x.md', 'docs/investigations', 'vault:notes/x.md'])
      expect(isValidReportPath(ok), ok).toBe(true);
    for (const bad of ['', '/etc/x', '../x', 'a/../../x', 'vault:../x', 'vault:', 'C:\\x', 'a\\..\\b'])
      expect(isValidReportPath(bad), bad).toBe(false);
    expect(CodeFieldsSchema.safeParse({ reportPath: 'docs/a.md' }).success).toBe(true);
    expect(CodeFieldsSchema.safeParse({ reportPath: '../a.md' }).success).toBe(false);
    expect(CodeFieldsSchema.safeParse({}).success).toBe(true);
  });
});

describe('requiredForSpecify', () => {
  const def = withInvestigate();
  const buildFields = stageOf(codeWorkflowV1, 'build').requiredFields;
  it('code v1: the build field set (unchanged BA behaviour)', () => {
    expect(requiredForSpecify(codeWorkflowV1, {})).toEqual(expect.arrayContaining(buildFields));
  });
  it('a build card (investigate skipped) needs the full build set', () => {
    const keys = requiredForSpecify(def, { designNeeded: false });
    for (const k of buildFields) expect(keys).toContain(k);
  });
  it('a design card needs investigate fields plus the build set, without duplicates', () => {
    const keys = requiredForSpecify(def, { designNeeded: true, investigationOnly: false });
    for (const k of [...buildFields, 'context', 'requirements', 'repoId']) expect(keys).toContain(k);
    expect(new Set(keys).size).toBe(keys.length);
  });
  it('an investigation-only card does not need the build-only fields', () => {
    const keys = requiredForSpecify(def, { designNeeded: true, investigationOnly: true });
    expect(keys).toEqual(expect.arrayContaining(['title', 'cardType', 'context', 'requirements', 'repoId']));
    expect(buildFields.filter((k) => !keys.includes(k)).length).toBeGreaterThan(0);
  });
  it('missingForSpecify reports unfilled keys', () => {
    const missing = missingForSpecify(def, {
      designNeeded: true,
      investigationOnly: true,
      title: 'T',
      cardType: 'feature',
      repoId: null,
      fields: { context: 'c', requirements: 'r' },
    });
    expect(missing).toContain('repoId');
    expect(missing).not.toContain('title');
    expect(missing).not.toContain('context');
  });
  it('a workflow without a CardSpecified outcome yields nothing', () => {
    const feed = BUILTIN_WORKFLOWS.find((w) => w.key === 'feed');
    if (!feed) throw new Error('no feed');
    expect(requiredForSpecify(feed, {})).toEqual([]);
  });
});

describe('InvestigationData', () => {
  it('validates the report data and is selected by the outcome data kind', () => {
    const ok = { reportPath: 'docs/investigations/AOM-1-x.md', summary: 'short', location: 'repo' };
    expect(InvestigationDataSchema.parse(ok)).toEqual(ok);
    const schema = outcomeDataSchema('investigation');
    expect(schema.safeParse({ ...ok, commit: 'abc123' }).success).toBe(true);
    expect(schema.safeParse({ ...ok, location: 'cloud' }).success).toBe(false);
    expect(schema.safeParse({ ...ok, summary: 'x'.repeat(2001) }).success).toBe(false);
    expect(schema.safeParse({ summary: 's', location: 'repo' }).success).toBe(false);
  });
});
