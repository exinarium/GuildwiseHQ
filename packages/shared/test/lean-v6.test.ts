import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  buildEvidenceProblem,
  canonicalWorkflowKey,
  capDiff,
  codeWorkflowV6,
  DIFF_MAX_BYTES,
  DIFF_TRUNCATED_NOTE,
  DomainEventSchema,
  deriveE2eAreas,
  getBuiltinWorkflow,
  getStage,
  HIGH_RISK_GLOBS,
  highRiskPaths,
  highRiskSummary,
  isHighRiskPath,
  isHighRiskPaths,
  isLeanTeamWorkflow,
  LEGACY_CODE_V6_KEY,
  ownerApprovalDecision,
  resolveOutcome,
  selectE2eSpecs,
  validateWorkflow,
} from '../src/index.ts';

describe('high-risk paths (shared with the platform team)', () => {
  it('exports the glob list and a matcher', () => {
    expect(HIGH_RISK_GLOBS.length).toBeGreaterThan(10);
    expect(isHighRiskPath('apps/server/src/auth/login.ts')).toBe(true);
    expect(isHighRiskPaths(['README.md', 'src/a.ts'])).toBe(false);
    expect(isHighRiskPaths(['README.md', 'db/migrations/0001_init.sql'])).toBe(true);
  });

  it.each([
    ['apps/server/src/auth/sessions.ts', 'auth'],
    ['apps/server/src/authz/scope.ts', 'auth'],
    ['src/permissions/roles.ts', 'auth'],
    ['config/secrets.yaml', 'auth'],
    ['.env.production', 'auth'],
    ['certs/server.pem', 'auth'],
    ['apps/server/migrations/2140_code_v6.sql', 'data'],
    ['db/schema.prisma', 'data'],
    ['apps/server/src/data-migrations/ledger.ts', 'data'],
    ['apps/server/src/billing/engine.ts', 'tenancy'],
    ['src/tenants/resolve.ts', 'tenancy'],
    ['lib/invoice-html.ts', 'tenancy'],
  ])('%s is high risk (%s)', (path, category) => {
    expect(isHighRiskPath(path)).toBe(true);
    expect(highRiskSummary([path]).categories).toContain(category);
  });

  it.each([
    'apps/web/src/components/Button.tsx',
    'docs/USER-GUIDE.md',
    'apps/runner/src/sandbox/policy.ts',
    'apps/runner/src/devops/guard.ts',
    'deploy/docker-compose.yml',
    'apps/server/test/billing.test.ts',
    'docs/design/secrets-and-migrations.md',
  ])('%s is not high risk (sandbox, policy and deploy code are not on the list)', (path) => {
    expect(isHighRiskPath(path)).toBe(false);
  });

  it('handles windows separators and a leading ./ and keeps the order', () => {
    expect(isHighRiskPath('.\\apps\\server\\src\\auth\\x.ts')).toBe(true);
    expect(isHighRiskPath('./db/migrations/1.sql')).toBe(true);
    expect(highRiskPaths(['a.ts', 'x/auth/b.ts', 'c.ts', 'migrations/d.sql'])).toEqual([
      'x/auth/b.ts',
      'migrations/d.sql',
    ]);
  });
});

describe('build evidence', () => {
  const cmd = (kind: string, status = 'passed') =>
    ({ kind, command: `run ${kind}`, status, result: 'ok' }) as never;
  it('needs a passing build and a passing unit test run, or a stated waiver', () => {
    expect(buildEvidenceProblem(undefined)).toMatch(/evidence/);
    expect(buildEvidenceProblem({ commands: [] })).toMatch(/no build command/);
    expect(buildEvidenceProblem({ commands: [cmd('build')] })).toMatch(/no unit test/);
    expect(buildEvidenceProblem({ commands: [cmd('build'), cmd('test')] })).toBeNull();
    expect(buildEvidenceProblem({ commands: [cmd('build'), cmd('test', 'failed')] })).toMatch(/failed/);
    expect(buildEvidenceProblem({ commands: [], waived: 'documentation only' })).toBeNull();
  });
});

describe('the diff cap', () => {
  it('leaves a small diff alone and cuts a big one on a line with a note', () => {
    expect(capDiff('small\n')).toEqual({ text: 'small\n', bytes: 6, truncated: false });
    const line = `${'x'.repeat(99)}\n`;
    const big = line.repeat(Math.ceil((DIFF_MAX_BYTES * 1.5) / 100));
    const out = capDiff(big);
    expect(out.truncated).toBe(true);
    expect(out.bytes).toBe(big.length);
    expect(out.text.endsWith(DIFF_TRUNCATED_NOTE)).toBe(true);
    expect(new TextEncoder().encode(out.text).length).toBeLessThanOrEqual(DIFF_MAX_BYTES + 200);
    expect(out.text.slice(0, -DIFF_TRUNCATED_NOTE.length).endsWith('x')).toBe(true);
  });
});

describe('the owner approval decision', () => {
  const base = {
    policy: 'large_or_high_risk',
    highRisk: false,
    reviewerHighRisk: false,
    riskTier: 'small',
    largeWaived: false,
  } as const;
  it('is required for a high-risk or a large card and automatic for a small low-risk one', () => {
    expect(ownerApprovalDecision(base)).toEqual({ required: false, reason: 'auto_small' });
    expect(ownerApprovalDecision({ ...base, riskTier: 'large' })).toEqual({
      required: true,
      reason: 'large',
    });
    expect(ownerApprovalDecision({ ...base, highRisk: true })).toEqual({
      required: true,
      reason: 'high_risk',
    });
    expect(ownerApprovalDecision({ ...base, reviewerHighRisk: true })).toEqual({
      required: true,
      reason: 'reviewer_high_risk',
    });
  });
  it('the project can ask for every card or let a large one through, never a high-risk one', () => {
    expect(ownerApprovalDecision({ ...base, policy: 'always' })).toEqual({
      required: true,
      reason: 'policy_always',
    });
    expect(ownerApprovalDecision({ ...base, riskTier: 'large', largeWaived: true })).toEqual({
      required: false,
      reason: 'waived_large',
    });
    expect(
      ownerApprovalDecision({ ...base, riskTier: 'large', largeWaived: true, highRisk: true }).required,
    ).toBe(true);
  });
});

describe('area E2E mapping', () => {
  const specs = [
    'e2e/tests/desk.spec.ts',
    'e2e/tests/org-chart.spec.ts',
    'e2e/tests/core-loop.spec.ts',
    'e2e/tests/intake/batch.spec.ts',
    'e2e/support/api.ts',
  ];
  it('derives one area per spec file or folder from the E2E structure', () => {
    expect(
      deriveE2eAreas(specs)
        .map((a) => a.name)
        .sort(),
    ).toEqual(['core-loop', 'desk', 'intake', 'org-chart']);
  });
  it('maps the changed paths to the specs of their areas (default: by name)', () => {
    const s = selectE2eSpecs({
      changedPaths: ['apps/web/src/pages/Desk.tsx', 'apps/web/src/lib/x.ts'],
      specFiles: specs,
    });
    expect(s.mode).toBe('areas');
    expect(s.areas).toEqual(['desk']);
    expect(s.specs).toEqual(['e2e/tests/desk.spec.ts']);
    const two = selectE2eSpecs({
      changedPaths: ['apps/web/src/components/org-chart/Node.tsx', 'apps/server/src/commands/intake.ts'],
      specFiles: specs,
    });
    expect(two.areas.sort()).toEqual(['intake', 'org-chart']);
  });
  it('an explicit mapping wins and adds the always-run specs', () => {
    const s = selectE2eSpecs({
      changedPaths: ['packages/shared/src/x.ts'],
      specFiles: specs,
      mapping: {
        areas: [
          { name: 'shared', paths: ['packages/shared/**'], specs: ['e2e/tests/desk.spec.ts', '@shared'] },
        ],
        always: ['e2e/tests/core-loop.spec.ts'],
        fallback: 'core',
      },
    });
    expect(s.mode).toBe('areas');
    expect(s.specs).toEqual(['e2e/tests/desk.spec.ts', '@shared', 'e2e/tests/core-loop.spec.ts']);
  });
  it('the planner affected areas count, and nothing matched falls back to the core specs, else all', () => {
    expect(
      selectE2eSpecs({ changedPaths: ['x.ts'], specFiles: specs, hint: 'touches the org chart page' }).areas,
    ).toEqual(['org-chart']);
    const core = selectE2eSpecs({ changedPaths: ['unrelated/file.ts'], specFiles: specs });
    expect(core).toMatchObject({ mode: 'core', specs: ['e2e/tests/core-loop.spec.ts'] });
    const all = selectE2eSpecs({
      changedPaths: ['unrelated/file.ts'],
      specFiles: ['e2e/tests/desk.spec.ts'],
    });
    expect(all.mode).toBe('all');
    expect(
      selectE2eSpecs({
        changedPaths: ['unrelated.ts'],
        specFiles: specs,
        mapping: { areas: [], always: [], fallback: 'all' },
      }).mode,
    ).toBe('all');
  });
});

describe('code version 6 (the lean team flow)', () => {
  const ids = codeWorkflowV6.stages.map((s) => s.id);
  it('validates and has the lean team stages in order', () => {
    expect(validateWorkflow(codeWorkflowV6, BUILTIN_ROLES)).toEqual([]);
    expect(ids).toEqual([
      'spec',
      'planning',
      'investigate',
      'build',
      'pre_review',
      'review',
      'merge_review',
      'owner_approval',
      'test_deploy',
      'test',
      'docs',
      'finalize',
      'qa_steps',
      'manual_qa',
      'done',
    ]);
  });
  it('plans with a planner outside any worktree, designs every card, and the server runs the test deploy', () => {
    expect(getStage(codeWorkflowV6, 'planning')).toMatchObject({
      claimRole: 'planner',
      worktree: 'none',
      kind: 'agent',
    });
    expect(codeWorkflowV6.defaults?.designNeeded).toBe(true);
    expect(getStage(codeWorkflowV6, 'test_deploy')).toMatchObject({
      kind: 'server',
      claimRole: null,
      server: { action: 'test_deploy' },
    });
    expect(getStage(codeWorkflowV6, 'test')).toMatchObject({ envStrict: true, rebaseBefore: false });
    expect(getStage(codeWorkflowV6, 'pre_review')).toMatchObject({
      claimRole: 'pre_reviewer',
      rebaseBefore: true,
    });
    expect(getStage(codeWorkflowV6, 'build')).toMatchObject({ requireBuildEvidence: true });
  });
  it('routes the review to the owner approval only when the card needs it', () => {
    const to = (view: Record<string, unknown>) =>
      resolveOutcome(codeWorkflowV6, view, 'review', 'approve').toStage;
    expect(to({ ownerApproval: true })).toBe('owner_approval');
    expect(to({ ownerApproval: false })).toBe('test_deploy');
    expect(to({})).toBe('test_deploy');
    expect(resolveOutcome(codeWorkflowV6, { designNeeded: false }, 'planning', 'planned').toStage).toBe(
      'build',
    );
    expect(resolveOutcome(codeWorkflowV6, { designNeeded: true }, 'planning', 'planned').toStage).toBe(
      'investigate',
    );
    expect(resolveOutcome(codeWorkflowV6, {}, 'pre_review', 'changes')).toMatchObject({
      toStage: 'build',
      event: 'ChangesRequested',
    });
  });
  it('the new roles exist with their default models and read-only permissions', () => {
    const planner = BUILTIN_ROLES.find((r) => r.key === 'planner');
    const pre = BUILTIN_ROLES.find((r) => r.key === 'pre_reviewer');
    expect(planner?.defaultModel.model).toBe('haiku');
    expect(pre?.defaultModel.model).toBe('sonnet');
    for (const role of [planner, pre]) expect(role?.permissions.mayCommit).toBe(false);
    const reviewer = BUILTIN_ROLES.find((r) => r.key === 'reviewer');
    expect(reviewer?.version).toBe(9);
    expect(reviewer?.coreRules.join(' ')).toMatch(/never build the project and never run its tests/i);
    expect(reviewer?.instructions).not.toMatch(/rsync|cp -a/);
  });
});

describe('code v6 rolled out like v3 to v5 (no workflow of its own)', () => {
  it('is the newest built-in version of `code`, flagged lean team, and no built-in has the legacy key', () => {
    const codes = BUILTIN_WORKFLOWS.filter((w) => w.key === 'code').map((w) => w.version);
    expect(Math.max(...codes)).toBe(6);
    expect(getBuiltinWorkflow('code')).toBe(codeWorkflowV6);
    expect(codeWorkflowV6).toMatchObject({ key: 'code', version: 6, leanTeam: true });
    expect(BUILTIN_WORKFLOWS.some((w) => w.key === LEGACY_CODE_V6_KEY)).toBe(false);
    // the classic versions are not lean team
    for (const w of BUILTIN_WORKFLOWS.filter((x) => x.key === 'code' && x.version < 6))
      expect(isLeanTeamWorkflow(w)).toBe(false);
  });
  it('the capability is true for code v6 and for the stored definition of the legacy key, false otherwise', () => {
    expect(isLeanTeamWorkflow(codeWorkflowV6)).toBe(true);
    // a definition stored before the flag existed (key code-v6, no leanTeam)
    expect(isLeanTeamWorkflow({ key: LEGACY_CODE_V6_KEY })).toBe(true);
    expect(isLeanTeamWorkflow({ key: 'code' })).toBe(false);
    expect(isLeanTeamWorkflow({ key: 'research', leanTeam: undefined })).toBe(false);
  });
  it('the legacy key is an alias of code only', () => {
    expect(canonicalWorkflowKey(LEGACY_CODE_V6_KEY)).toBe('code');
    expect(canonicalWorkflowKey('code')).toBe('code');
    expect(canonicalWorkflowKey('research')).toBe('research');
  });
  it('the fold events parse', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    for (const e of [
      {
        type: 'ProjectPrimaryWorkflowChanged',
        payload: { projectId: id, from: 'code-v6', to: 'code', by: id },
      },
      {
        type: 'CardWorkflowVersionChanged',
        payload: { cardId: id, fromVersionId: id, toVersionId: id, reason: 'x' },
      },
      {
        type: 'WorkflowVersionRetired',
        payload: { workflowVersionId: id, key: 'code-v6', version: 1, reason: 'x' },
      },
    ])
      expect(DomainEventSchema.safeParse(e).success).toBe(true);
  });
});
