import { describe, expect, it } from 'vitest';
import {
  BUILTIN_ROLES,
  bugDescription,
  CardTestingSchema,
  CommandPayloadSchemas,
  DomainEventSchema,
  FinalizeExecutePayloadSchema,
  FinalizeResultSchema,
  isSuiteOrigin,
  outcomeDataSchema,
  parseCardFields,
  RegressionRequestSchema,
  RunnerToServerSchema,
  TestFailDataSchema,
} from '../src/index.ts';
import { env, U } from './fixtures.ts';

describe('M4 events', () => {
  const evidence = { commands: ['pnpm e2e'], summary: 'ok', outputExcerpt: '' };
  const cases: Array<[string, Record<string, unknown>]> = [
    ['FullSuiteStarted', { cardId: U.a, branch: 'main', suiteCardId: U.b }],
    ['FullSuitePassed', { suiteCardId: U.a, evidence }],
    [
      'FullSuiteFailed',
      { suiteCardId: U.a, evidence, testSideFixed: true, kind: 'regression', platform: 'web' },
    ],
    [
      'BugReported',
      {
        suiteCardId: U.a,
        title: 'Login broken',
        description: 'd',
        evidence,
        bugCardId: U.b,
        deskItemId: U.c,
      },
    ],
    [
      'RegressionRequested',
      {
        projectId: U.a,
        platform: 'both',
        requestedBy: U.b,
        regressionCardId: U.c,
        regressionCardIds: [U.c, U.d],
      },
    ],
    [
      'TesterBottleneck',
      {
        projectId: U.a,
        deskItemId: U.b,
        waitingCardIds: [U.c],
        busyTesterIds: [U.d],
        recommendation: { hire: 'tester', count: 1 },
      },
    ],
    ['TestEnvironmentParked', { cardId: U.a, requestId: U.b, problem: 'docker_missing' }],
    ['TestEnvironmentReady', { cardId: U.a, requestId: U.b }],
    ['FinalizeApprovalRequested', { cardId: U.a, action: 'merge', deskItemId: U.b, requestedBy: U.c }],
    ['FinalizeFailed', { cardId: U.a, action: 'pr', error: 'gh failed' }],
  ];
  it.each(cases)('parses %s', (type, payload) => {
    const r = DomainEventSchema.safeParse({ type, payload });
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
  it('defaults the suite kind to full_suite and rejects an unknown platform or problem', () => {
    const r = DomainEventSchema.parse({ type: 'FullSuitePassed', payload: { suiteCardId: U.a, evidence } });
    expect(r.type === 'FullSuitePassed' && r.payload.kind).toBe('full_suite');
    expect(
      DomainEventSchema.safeParse({
        type: 'RegressionRequested',
        payload: { projectId: U.a, platform: 'desktop', requestedBy: U.b, regressionCardId: U.c },
      }).success,
    ).toBe(false);
    expect(
      DomainEventSchema.safeParse({
        type: 'TestEnvironmentParked',
        payload: { cardId: U.a, requestId: U.b, problem: 'bad_weather' },
      }).success,
    ).toBe(false);
  });
  it('still accepts the M1 payloads of TestPassed, TestFailed, ChildCardResolved and RebaseConflict', () => {
    for (const [type, payload] of [
      ['TestPassed', { cardId: U.a, testerAgentId: U.b, evidence, toStage: 'finalize' }],
      ['TestFailed', { cardId: U.a, testerAgentId: U.b, bugCardId: U.c, evidence, summary: 's' }],
      ['ChildCardResolved', { cardId: U.a, childCardId: U.b, toStage: 'test' }],
      ['RebaseConflict', { cardId: U.a, stage: 'test', baseBranch: 'main', conflictedFiles: ['a.ts'] }],
      ['FinalizeRequested', { cardId: U.a, action: 'merge', requestedBy: U.b }],
      ['CardFinalized', { cardId: U.a, action: 'merge', resultRef: { mergeCommit: 'abc' }, toStage: 'done' }],
    ] as const) {
      expect(DomainEventSchema.safeParse({ type, payload }).success, type).toBe(true);
    }
  });
});

describe('M4 protocol and commands', () => {
  it('finalize.execute has a typed payload and result', () => {
    const payload = {
      cardId: U.a,
      ref: 'WEB-1',
      title: 'T',
      projectKey: 'WEB',
      action: 'merge',
      repoId: U.b,
      remoteUrlNormalized: 'github.com/acme/toy',
      baseBranch: 'main',
      branchName: 'aom/web-1-t',
      worktreePath: null,
    };
    expect(CommandPayloadSchemas['finalize.execute'].parse(payload)).toEqual(
      FinalizeExecutePayloadSchema.parse(payload),
    );
    expect(FinalizeResultSchema.parse({ ok: true, action: 'merge', mergeCommit: 'abc123' }).ok).toBe(true);
    expect(FinalizeResultSchema.safeParse({ ok: true, action: 'rebase' }).success).toBe(false);
  });
  it('shift.rejected may carry an environment problem', () => {
    const m = {
      ...env('shift.rejected'),
      shiftId: U.a,
      reason: 'environment_not_ready',
      environment: { problem: 'docker_missing', detail: 'docker: command not found' },
    };
    expect(RunnerToServerSchema.parse(m)).toEqual(m);
    expect(RunnerToServerSchema.safeParse({ ...m, environment: { problem: 'rain' } }).success).toBe(false);
  });
  it('the tester fail outcome carries a bug title; pass does not need one', () => {
    const schema = outcomeDataSchema('testEvidence');
    expect(schema.parse({ summary: 'ok' })).toEqual({ commands: [], summary: 'ok', outputExcerpt: '' });
    expect(schema.parse({ summary: 'x', title: 'Bug' })).toMatchObject({ title: 'Bug' });
    expect(TestFailDataSchema.safeParse({ summary: 'x' }).success).toBe(false);
  });
  it('regression requests name a platform', () => {
    expect(RegressionRequestSchema.parse({ platform: 'both' })).toEqual({ platform: 'both' });
    expect(RegressionRequestSchema.safeParse({ platform: 'tv' }).success).toBe(false);
  });
  it('card detail testing facts parse', () => {
    expect(
      CardTestingSchema.parse({
        testRuns: [],
        parent: null,
        children: [],
        waitingOn: null,
        parkedOn: null,
        finalize: {
          available: true,
          action: 'merge',
          requiresApproval: true,
          state: 'idle',
          deskItemId: null,
          lastError: null,
        },
        suiteKind: null,
      }).finalize.requiresApproval,
    ).toBe(true);
  });
});

describe('M4 card fields and roles', () => {
  it('suite cards carry a platform, a branch and a mock environment problem', () => {
    const r = parseCardFields('code', { platform: 'web', suiteBranch: 'main', mockEnv: 'docker_missing' });
    expect(r.success && r.data).toEqual({ platform: 'web', suiteBranch: 'main', mockEnv: 'docker_missing' });
    expect(parseCardFields('code', { platform: 'tv' }).success).toBe(false);
  });
  it('suite origins', () => {
    expect(isSuiteOrigin('full_suite')).toBe(true);
    expect(isSuiteOrigin('regression')).toBe(true);
    expect(isSuiteOrigin('test_failure')).toBe(false);
  });
  it('tester and writer have real instructions that state the test ownership rules (v2)', () => {
    const tester = BUILTIN_ROLES.find((r) => r.key === 'tester');
    const writer = BUILTIN_ROLES.find((r) => r.key === 'writer');
    expect(tester?.version).toBe(4);
    expect(writer?.version).toBe(2);
    expect(tester?.instructions).not.toContain('TODO');
    expect(writer?.instructions).not.toContain('TODO');
    expect(tester?.instructions).toContain('aom test fail');
    expect(tester?.coreRules.join(' ')).toMatch(/end-to-end tests only/);
    expect(BUILTIN_ROLES.find((r) => r.key === 'builder')?.coreRules.join(' ')).toMatch(/unit tests outside/);
    expect(writer?.instructions).toContain('aom outcome done');
  });
  it('bug descriptions keep the note, evidence and commands', () => {
    const d = bugDescription({
      note: 'Login 500s',
      evidence: { commands: ['pnpm e2e'], summary: '1 failed', outputExcerpt: 'Error: boom' },
      parentRef: 'WEB-3',
    });
    expect(d).toContain('Found while testing WEB-3.');
    expect(d).toContain('Login 500s');
    expect(d).toContain('- pnpm e2e');
    expect(d).toContain('Error: boom');
  });
});
