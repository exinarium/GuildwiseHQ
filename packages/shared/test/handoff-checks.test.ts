import { describe, expect, it } from 'vitest';
import {
  agentEvidenceRows,
  CHECKS_POLICY,
  CheckEvidenceSchema,
  checkEvidenceProblem,
  checkEvidenceRows,
  checkStatusPasses,
  checkSuites,
  INTEGRATION_TESTS_OFF,
  IntegrationSuiteSchema,
  IntegrationTestsSchema,
  PROTOCOL_VERSION,
  renderShiftPrompt,
  requiredSuites,
  ShiftBriefSchema,
  ShiftReportMsgSchema,
  StoredBuildEvidenceSchema,
  TestSuiteReportSchema,
  testerSuites,
  unitSuites,
  validateIntegrationTests,
} from '../src/index.ts';
import { buildBrief, U as UU } from './fixtures.ts';

const U = UU.a;

const suite = (o: Record<string, unknown>) =>
  IntegrationSuiteSchema.parse({ name: 'x', repoId: U, cmd: ['true'], ...o });
const ev = (o: Record<string, unknown>) =>
  CheckEvidenceSchema.parse({ name: 'lint', command: 'pnpm lint', ...o });

describe('check suites', () => {
  it('parses kind check with a fix command; old settings get an empty checkDetection', () => {
    const s = suite({ kind: 'check', fix: ['pnpm', 'format'] });
    expect(s.kind).toBe('check');
    expect(s.fix).toEqual(['pnpm', 'format']);
    expect(IntegrationTestsSchema.parse({ mode: 'local' }).checkDetection).toEqual([]);
    expect(INTEGRATION_TESTS_OFF.checkDetection).toEqual([]);
  });

  it('testerSuites and requiredSuites leave the checks out; checkSuites keeps confirmed checks of one repo', () => {
    const other = UU.b;
    const settings = IntegrationTestsSchema.parse({
      suites: [
        suite({ name: 'api', kind: 'integration' }),
        suite({ name: 'lint', kind: 'check' }),
        suite({ name: 'proposed', kind: 'check', confirmed: false }),
        suite({ name: 'elsewhere', kind: 'check', repoId: other }),
      ],
    });
    expect(testerSuites(settings).map((x) => x.name)).toEqual(['api']);
    expect(requiredSuites(settings).map((x) => x.name)).toEqual(['api']);
    expect(checkSuites(settings, U).map((x) => x.name)).toEqual(['lint']);
  });

  it('validates the longest run of a check and that only a check has a fix', () => {
    const s = IntegrationTestsSchema.parse({
      suites: [
        suite({ name: 'slow', kind: 'check', timeoutMin: 11 }),
        suite({ name: 'api', kind: 'integration', fix: ['x'] }),
      ],
    });
    const p = validateIntegrationTests(s, [U]);
    expect(p).toContain('check "slow": a check runs at most 10 minutes');
    expect(p).toContain('suite "api": only a check has a fix command');
  });
});

describe('check evidence', () => {
  it('only a failed check refuses and names the fix', () => {
    expect(checkEvidenceProblem(undefined)).toBeNull();
    expect(
      checkEvidenceProblem([
        ev({ status: 'passed' }),
        ev({ status: 'preexisting' }),
        ev({ status: 'error' }),
      ]),
    ).toBeNull();
    const p = checkEvidenceProblem([ev({ status: 'failed', summary: '2 problems', fix: 'pnpm format' })]);
    expect(p).toContain('"lint"');
    expect(p).toContain('pnpm format');
  });

  it('shows rows with readable labels', () => {
    const rows = checkEvidenceRows([
      ev({ status: 'passed' }),
      ev({ status: 'preexisting' }),
      ev({ status: 'error', summary: 'missing tool' }),
      ev({ status: 'timeout' }),
    ]);
    expect(rows.map((r) => r.status)).toEqual([
      'passed',
      'passed (failures only in files the card did not change)',
      'could not run',
      'timed out',
    ]);
    expect(rows[2]).toMatchObject({ kind: 'check', command: 'pnpm lint', result: 'missing tool' });
    expect(checkEvidenceRows(undefined)).toEqual([]);
  });

  it('stored evidence parses with and without checks', () => {
    const base = { commands: [], sha: 'abcdef1', at: '2026-11-04T10:00:00.000Z' };
    expect(StoredBuildEvidenceSchema.parse(base).checks).toBeUndefined();
    expect(
      StoredBuildEvidenceSchema.parse({ ...base, checks: [{ name: 'a', command: 'b', status: 'passed' }] })
        .checks?.[0],
    ).toMatchObject({
      cwd: '.',
      elsewhereCount: 0,
      introduced: [],
    });
  });

  it('the report message carries checks only optionally', () => {
    const m = { type: 'shift.report', shiftId: U, reportId: U, report: { outcome: 'handoff', note: 'x' } };
    expect(
      ShiftReportMsgSchema.safeParse({
        ...m,
        v: 1,
        id: U,
        checks: [{ name: 'a', command: 'b', status: 'bogus' }],
      }).success,
    ).toBe(false);
    expect(ShiftBriefSchema.shape.checks.safeParse(undefined).success).toBe(true);
  });
});

describe('check prompts', () => {
  it('lists the checks for the builder', () => {
    const b = buildBrief();
    const p = renderShiftPrompt({
      ...b,
      checks: {
        detect: false,
        suites: [suite({ name: 'lint', kind: 'check', cmd: ['pnpm', 'lint'], fix: ['pnpm', 'format'] })],
      },
    });
    expect(p).toContain('Checks on handoff');
    expect(p).toContain('lint: `pnpm lint` in .');
    expect(p).toContain('(fix: `pnpm format`)');
    expect(p).toContain('Bash timeout of 15 minutes');
    expect(p).toContain('in any file (also in files you did not change)');
    expect(renderShiftPrompt(b)).not.toContain('Checks on handoff');
  });

  it('shows each status to the reviewers', () => {
    const b = buildBrief();
    const p = renderShiftPrompt({
      ...b,
      buildEvidence: {
        sha: 'abcdef1',
        at: '2026-11-04T10:00:00.000Z',
        commands: [],
        checks: [
          ev({ name: 'fmt', command: 'pnpm fmt', status: 'passed' }),
          ev({
            name: 'lint',
            status: 'preexisting',
            summary: '3 problems elsewhere',
            elsewhere: ['a.ts:1 x'],
            elsewhereCount: 3,
          }),
          ev({ name: 'types', command: 'tsc', status: 'timeout', summary: 'timed out' }),
        ],
      },
    });
    expect(p).toContain('- check fmt: `pnpm fmt` passed');
    expect(p).toContain('In files this card did not change (3):');
    expect(p).toContain('a.ts:1 x');
    expect(p).toContain('could not run: timed out; treat it as unverified');
  });
});

describe('handoff checks policy 2 and unit suites', () => {
  it('policy 2: everything except passed, deferred and regression_only refuses; older runners only on failed', () => {
    const timeout = ev({ status: 'timeout', summary: 'timed out after 5 minutes' });
    expect(checkEvidenceProblem([timeout])).toBeNull();
    expect(checkEvidenceProblem([timeout], CHECKS_POLICY)).toContain('did not produce a verdict (timed out');
    expect(checkEvidenceProblem([timeout], CHECKS_POLICY)).toContain('aom question --topic environment');
    expect(checkEvidenceProblem([ev({ status: 'error' })], CHECKS_POLICY)).toContain('could not run');
    expect(checkEvidenceProblem([ev({ status: 'failed', elsewhereCount: 3 })], CHECKS_POLICY)).toContain(
      'fails',
    );
    expect(
      checkEvidenceProblem(
        [
          ev({ status: 'passed' }),
          ev({ status: 'deferred', owedBy: 'tester' }),
          ev({ status: 'regression_only', kind: 'unit' }),
        ],
        CHECKS_POLICY,
      ),
    ).toBeNull();
    expect(checkStatusPasses('preexisting')).toBe(false);
  });

  it('labels the new statuses and marks unit rows; the agent lint and test lines are its note', () => {
    expect(checkEvidenceRows([ev({ status: 'deferred' })])[0]?.status).toContain('owed by another role');
    expect(checkEvidenceRows([ev({ status: 'regression_only', kind: 'unit' })])[0]).toMatchObject({
      status: 'not run at handoff: runs at regression',
      command: 'unit tests: pnpm lint',
    });
    const rows = agentEvidenceRows([
      { kind: 'build', command: 'b', status: 'passed', result: 'ok' },
      { kind: 'lint', command: 'l', status: 'passed', result: '0 errors' },
    ]);
    expect(rows[0]?.result).toBe('ok');
    expect(rows[1]?.result).toBe("the agent's note (not measured by the runner): 0 errors");
  });

  it("unit suites: never the tester's, a handoff command needs {files} and is for unit suites only", () => {
    const settings = IntegrationTestsSchema.parse({
      suites: [
        suite({ name: 'api', kind: 'integration' }),
        suite({ name: 'unit a', kind: 'unit', handoffCmd: ['npx', 'vitest', 'related', '{files}'] }),
        suite({ name: 'unit b', kind: 'unit', confirmed: false }),
      ],
    });
    expect(testerSuites(settings).map((x) => x.name)).toEqual(['api']);
    expect(requiredSuites(settings).map((x) => x.name)).toEqual(['api']);
    expect(unitSuites(settings, U).map((x) => x.name)).toEqual(['unit a']);
    expect(unitSuites(settings, null).map((x) => x.name)).toEqual(['unit a']);
    expect(settings.unitDetection).toEqual([]);
    const bad = IntegrationTestsSchema.parse({
      suites: [
        suite({ name: 'unit c', kind: 'unit', handoffCmd: ['npx', 'vitest'] }),
        suite({ name: 'api', kind: 'integration', handoffCmd: ['x', '{files}'] }),
      ],
    });
    const p = validateIntegrationTests(bad, [U]);
    expect(p).toContain('unit suite "unit c": the handoff command must contain {files}');
    expect(p).toContain('suite "api": only a unit suite has a handoff command');
  });

  it('the protocol carries units, regression units, checksPolicy and up to 20 results', () => {
    const many = Array.from({ length: 20 }, (_, i) => ev({ name: `c${i}`, status: 'passed' }));
    const msg = ShiftReportMsgSchema.safeParse({
      type: 'shift.report',
      v: PROTOCOL_VERSION,
      id: 'm1',
      ts: '2026-11-15T10:00:00.000Z',
      shiftId: U,
      reportId: UU.b,
      report: { kind: 'comment', note: 'refused' },
      checks: many,
      checksPolicy: CHECKS_POLICY,
    });
    expect(msg.success).toBe(true);
    const brief = ShiftBriefSchema.parse({
      ...buildBrief(),
      checks: { suites: [], units: [suite({ name: 'unit a', kind: 'unit' })], detectUnits: true },
      regressionUnits: [suite({ name: 'unit a', kind: 'unit' })],
    });
    expect(brief.checks?.units?.[0]?.name).toBe('unit a');
    expect(brief.regressionUnits).toHaveLength(1);
    expect(ev({ status: 'deferred' }).kind).toBe('check');
    expect(
      TestSuiteReportSchema.parse({ name: 'u', status: 'passed', kind: 'unit', measured: true }),
    ).toMatchObject({
      kind: 'unit',
      measured: true,
    });
  });
});
