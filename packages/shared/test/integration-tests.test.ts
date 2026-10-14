import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  BUILTIN_WORKFLOWS,
  codeWorkflowV3,
  codeWorkflowV4,
  DomainEventSchema,
  explainIssues,
  fieldCatalogue,
  getBuiltinWorkflow,
  getStage,
  INTEGRATION_TESTS_OFF,
  IntegrationTestsSchema,
  integrationTestsOn,
  materialiseVariant,
  parseCardFields,
  requiredSuites,
  resolveOutcome,
  smokeTestInsertion,
  stageNeedsEnvironment,
  suitesWithoutPass,
  validateIntegrationTests,
  validateVariant,
  validateWorkflow,
  type WorkflowDefinition,
  WorkflowVariantSpecSchema,
} from '../src/index.ts';

const REPO = '5b6d3c0e-9b0c-4d6e-8d2e-1f2a3b4c5d6e';
const U = '0b6d3c0e-9b0c-4d6e-8d2e-1f2a3b4c5d6f';

describe('integration test setting', () => {
  it('is off until the owner switches it on', () => {
    expect(INTEGRATION_TESTS_OFF).toMatchObject({
      mode: 'off',
      suites: [],
      keepOnFailureMin: 60,
      flakyRetry: 1,
    });
    expect(integrationTestsOn(INTEGRATION_TESTS_OFF)).toBe(false);
    expect(integrationTestsOn(IntegrationTestsSchema.parse({ mode: 'local' }))).toBe(true);
    expect(integrationTestsOn(null)).toBe(false);
  });

  it('checks suites against the project: names, repositories and safe paths', () => {
    const s = IntegrationTestsSchema.parse({
      mode: 'local',
      suites: [
        { name: 'api', repoId: REPO, cmd: ['npm', 'run', 'it'] },
        { name: 'API', repoId: REPO, cmd: ['npm', 'test'], cwd: '../x', junit: '/abs/*.xml' },
        { name: 'e2e', repoId: U, cmd: ['npx', 'playwright', 'test'], kind: 'e2e' },
      ],
    });
    const problems = validateIntegrationTests(s, [REPO]);
    expect(problems).toContain('suite "API" appears twice');
    expect(problems.some((p) => p.includes('"API": the folder must stay inside'))).toBe(true);
    expect(problems.some((p) => p.includes('"API": the report path must be relative'))).toBe(true);
    expect(problems.some((p) => p.includes('"e2e": the repository is not part of the project'))).toBe(true);
    expect(validateIntegrationTests(IntegrationTestsSchema.parse({ mode: 'remote' }), [REPO])).toEqual([
      'remote mode needs a deploy target (Project settings > Deploy targets)',
    ]);
    expect(validateIntegrationTests(IntegrationTestsSchema.parse({ mode: 'local' }), [REPO])).toEqual([]);
  });

  it('refuses `aom test pass` while a confirmed suite has no passing result', () => {
    const suites = [
      { name: 'api', confirmed: true, destructive: false },
      { name: 'e2e', confirmed: true, destructive: false },
      { name: 'found', confirmed: false, destructive: false },
    ];
    expect(suitesWithoutPass(suites, [])).toEqual(['api', 'e2e']);
    expect(
      suitesWithoutPass(suites, [
        { suite: 'api', status: 'failed' },
        { suite: 'E2E', status: 'flaky' },
      ]),
    ).toEqual(['api']);
    // the last report of a suite counts: a failure followed by a passing re-run is fine
    expect(
      suitesWithoutPass(suites, [
        { suite: 'api', status: 'failed' },
        { suite: 'api', status: 'passed' },
        { suite: 'e2e', status: 'skipped' },
      ]),
    ).toEqual([]);
    expect(
      requiredSuites(
        IntegrationTestsSchema.parse({ suites: [{ name: 'x', repoId: REPO, cmd: ['t'], confirmed: false }] }),
      ),
    ).toEqual([]);
  });

  it('carries the events', () => {
    const base = { projectId: REPO, by: U };
    expect(
      DomainEventSchema.safeParse({
        type: 'ProjectIntegrationTestsSet',
        payload: { ...base, settings: { mode: 'local' } },
      }).success,
    ).toBe(true);
    expect(
      DomainEventSchema.safeParse({
        type: 'TestSuiteReported',
        payload: {
          cardId: REPO,
          shiftId: U,
          testerAgentId: U,
          suite: 'api',
          kind: 'integration',
          envMode: 'local',
          envId: U,
          deployTargetId: null,
          commit: 'abc123',
          status: 'flaky',
          passed: 10,
          failed: 0,
          skipped: 1,
          durationMs: 1200,
        },
      }).success,
    ).toBe(true);
  });
});

describe('code v4', () => {
  it('equals v3 except for the test stage, and leaves v1 to v3 registered', () => {
    expect(validateWorkflow(codeWorkflowV4, BUILTIN_ROLES)).toEqual([]);
    expect(codeWorkflowV4.version).toBe(4);
    expect(getBuiltinWorkflow('code')?.version).toBe(4);
    expect(BUILTIN_WORKFLOWS.filter((w) => w.key === 'code').map((w) => w.version)).toEqual([1, 2, 3, 4]);
    const strip = (d: WorkflowDefinition) =>
      JSON.stringify(d.stages.filter((s) => s.id !== 'test').map((s) => s));
    expect(strip(codeWorkflowV4)).toBe(strip(codeWorkflowV3));
    expect(getStage(codeWorkflowV4, 'test')).toMatchObject({
      when: { field: 'integrationTests', equals: true },
      environment: 'project',
      maxShiftMinutes: 120,
      rebaseBefore: true,
    });
    expect(stageNeedsEnvironment(getStage(codeWorkflowV4, 'test')!)).toBe(true);
    expect(getStage(codeWorkflowV3, 'test')).toMatchObject({ environment: 'none', maxShiftMinutes: 60 });
    expect(getStage(codeWorkflowV3, 'test')?.when).toBeUndefined();
  });

  it('skips the test stage unless the card has integration tests on', () => {
    const to = (card: Record<string, unknown>) =>
      resolveOutcome(codeWorkflowV4, card, 'review', 'approve').toStage;
    expect(to({ docsNeeded: false, integrationTests: true })).toBe('test');
    expect(to({ docsNeeded: false, integrationTests: false })).toBe('finalize');
    expect(to({ docsNeeded: true, fields: { integrationTests: false } })).toBe('docs');
    expect(to({ docsNeeded: false, fields: { integrationTests: true } })).toBe('test');
    // an old card with no field at all: the stage is skipped, like a project with the setting off
    expect(to({ docsNeeded: false })).toBe('finalize');
    // v3 always tests
    expect(resolveOutcome(codeWorkflowV3, { docsNeeded: false }, 'review', 'approve').toStage).toBe('test');
  });

  it('has the integrationTests card field', () => {
    expect(fieldCatalogue('code').integrationTests).toEqual({ label: 'Integration tests', kind: 'boolean' });
    expect(parseCardFields('code', { integrationTests: false })).toMatchObject({
      success: true,
      data: { integrationTests: false },
    });
  });
});

describe('environment stages', () => {
  const clone = (): WorkflowDefinition => structuredClone(codeWorkflowV4);
  const codes = (def: unknown) => validateWorkflow(def, BUILTIN_ROLES).map((i) => i.code);

  it('need an agent stage worked by a role with a shell', () => {
    const wrongKind = clone();
    (getStage(wrongKind, 'done') as { environment: string }).environment = 'project';
    expect(codes(wrongKind)).toContain('environment_misplaced');

    const noShell = clone();
    const docs = getStage(noShell, 'docs') as { claimRole: string | null; environment: string };
    docs.claimRole = 'curator'; // reads and browses the web, has no shell
    docs.environment = 'project';
    expect(codes(noShell)).toContain('environment_role_no_shell');
    expect(codes(clone())).toEqual([]);
  });

  it('are explained in plain words', () => {
    const def = clone();
    const docs = getStage(def, 'docs') as { claimRole: string | null; environment: string };
    docs.claimRole = 'curator';
    docs.environment = 'project';
    const issues = explainIssues(validateWorkflow(def, BUILTIN_ROLES), def);
    expect(issues.find((i) => i.code === 'environment_role_no_shell')?.text).toMatch(/running environment/);
  });

  it('can be inserted into a project variant as a smoke test step the tester claims', () => {
    const spec = WorkflowVariantSpecSchema.parse({
      key: 'code-smoke',
      name: 'Code with a smoke test',
      projectId: U,
      base: { key: 'code', version: 4 },
      insertions: [smokeTestInsertion('review')],
    });
    const def = materialiseVariant(codeWorkflowV4, spec);
    expect(getStage(def, 'smoke_after_review')).toMatchObject({
      environment: 'project',
      kind: 'agent',
      claimRole: 'tester',
    });
    const v = validateVariant(spec, codeWorkflowV4, BUILTIN_ROLES, { builtinWorkflowKeys: ['code'] });
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
