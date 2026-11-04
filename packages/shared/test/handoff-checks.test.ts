import { describe, expect, it } from 'vitest';
import {
  CheckEvidenceSchema,
  checkEvidenceProblem,
  checkEvidenceRows,
  checkSuites,
  INTEGRATION_TESTS_OFF,
  IntegrationSuiteSchema,
  IntegrationTestsSchema,
  renderShiftPrompt,
  requiredSuites,
  ShiftBriefSchema,
  ShiftReportMsgSchema,
  StoredBuildEvidenceSchema,
  testerSuites,
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
    expect(p).toContain('Bash timeout of 10 minutes');
    expect(renderShiftPrompt(b)).not.toContain('Checks on handoff');
  });

  it('shows each status to the reviewers', () => {
    const b = buildBrief();
    const p = renderShiftPrompt({
      ...b,
      buildEvidence: {
        sha: 'abcdef1',
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
    expect(p).toContain('did not change (3, information)');
    expect(p).toContain('a.ts:1 x');
    expect(p).toContain('could not run: timed out; treat it as unverified');
  });
});
