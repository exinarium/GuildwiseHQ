import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  buildPreviewBrief,
  explainRoleIssue,
  explainRoleIssues,
  renderRolePreview,
  ShiftBriefSchema,
  validateRoleDefinition,
} from '../src/index.ts';

const role = {
  key: 'triager',
  name: 'Triager',
  purpose: 'Sorts tickets.',
  instructions: 'Sort the ticket.',
  coreRules: ['Never promise refunds.'],
  seniorityLevels: ['junior' as const, 'senior' as const],
  skills: ['git'],
};

describe('role preview', () => {
  it('builds a brief the runner protocol accepts', () => {
    expect(() => ShiftBriefSchema.parse(buildPreviewBrief(role))).not.toThrow();
  });

  it('renders the real instructions with the role text, rules and skills', () => {
    const text = renderRolePreview(role, undefined, 'senior');
    expect(text).toContain('a senior Triager');
    expect(text).toContain('Sort the ticket.');
    expect(text).toContain('- Never promise refunds.');
    expect(text).toContain('Skills available to you: git.');
    expect(text).toContain('# Boundaries');
  });
});

describe('role issue wording', () => {
  const ctx = {
    builtinRoleKeys: BUILTIN_ROLES.map((r) => r.key),
    builtinWorkflowKeys: BUILTIN_WORKFLOWS.map((w) => w.key),
    departments: ['support'],
  };
  const base = {
    ...role,
    version: 1,
    builtIn: false,
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
    claimableStages: [{ workflowKey: 'support', stageId: 'triage' }],
  };

  it('has a plain sentence and a section for every validator issue', () => {
    const issues = [
      ...validateRoleDefinition({ ...base, key: 'builder', claimableStages: [], instructions: ' ' }, ctx),
      ...validateRoleDefinition(
        {
          ...base,
          department: 'nowhere',
          claimableStages: [
            { workflowKey: 'code', stageId: '*' },
            { workflowKey: '*', stageId: '*' },
          ],
          permissions: { ...base.permissions, allowedTools: ['x'], readOrgRepos: true },
        },
        ctx,
      ),
      ...validateRoleDefinition({ ...base, seniorityLevels: [] }, ctx),
      ...validateRoleDefinition({ ...base, name: '' }, ctx),
    ];
    const codes = new Set(issues.map((i) => i.code));
    for (const c of [
      'builtin_key',
      'no_instructions',
      'no_claimable_stages',
      'claims_builtin_workflow',
      'wildcard_workflow',
      'unknown_tool',
      'unknown_department',
      'reads_org_repos',
      'invalid_schema',
    ])
      expect(codes.has(c as never), c).toBe(true);
    for (const e of explainRoleIssues(issues)) {
      expect(e.text.length).toBeGreaterThan(10);
      // Plain language: no validator jargon such as schema paths or code names.
      expect(e.text).not.toMatch(/claimableStages|seniorityLevels|permissions\./);
    }
    const by = (code: string) => explainRoleIssues(issues).find((e) => e.code === code);
    expect(by('no_claimable_stages')?.section).toBe('steps');
    expect(by('builtin_key')?.section).toBe('basics');
    expect(by('unknown_tool')?.section).toBe('permissions');
    expect(by('no_instructions')?.section).toBe('instructions');
    expect(by('claims_builtin_workflow')?.text).toContain('"code"');
  });

  it('explains schema errors by field', () => {
    const issue = (field: string) => ({
      severity: 'error' as const,
      code: 'invalid_schema',
      message: `${field}: bad`,
      field,
    });
    expect(explainRoleIssue(issue('name')).text).toBe('Give the role a name.');
    expect(explainRoleIssue(issue('seniorityLevels')).section).toBe('seniority');
    expect(explainRoleIssue(issue('key')).text).toMatch(/lowercase letters/);
  });
});
