import { describe, expect, it } from 'vitest';
import { evaluateGate, type Gate, type GateFacts, GateSchema, inWindow, windowDays } from '../src/index.ts';

// 2026-10-21 is a Wednesday
const wed10 = new Date('2026-10-21T10:00:00Z');
const facts = (over: Partial<GateFacts> = {}): GateFacts => ({
  now: wed10,
  timezone: 'UTC',
  commit: 'abc1234def',
  envRuns: {},
  checks: {},
  phaseDoneCommits: [],
  latestMergeCommit: 'abc1234def',
  ...over,
});
const min = (n: number) => new Date(wed10.getTime() - n * 60_000);

describe('evaluateGate (docs/design/ceo-front-door.md 9.3)', () => {
  it('an empty gate holds', () => {
    expect(evaluateGate({ requires: [] }, facts())).toEqual({ satisfied: true, missing: [], evidence: [] });
  });

  it('envHealthy: the earlier environment runs this commit, healthy, for long enough', () => {
    const gate: Gate = { requires: [{ envHealthy: 'uat', sameCommit: true, forMinutes: 30 }] };
    expect(evaluateGate(gate, facts()).satisfied).toBe(false);
    // another commit does not count
    expect(
      evaluateGate(gate, facts({ envRuns: { uat: [{ id: 'r1', commit: 'zzz', healthyAt: min(60) }] } }))
        .satisfied,
    ).toBe(false);
    // the right commit, but only 10 minutes
    const young = evaluateGate(
      gate,
      facts({ envRuns: { uat: [{ id: 'r1', commit: 'abc1234', healthyAt: min(10) }] } }),
    );
    expect(young.satisfied).toBe(false);
    expect(young.missing[0]).toContain('not long enough');
    // long enough: the evidence names the run
    const ok = evaluateGate(
      gate,
      facts({ envRuns: { uat: [{ id: 'r1', commit: 'abc1234def', healthyAt: min(45) }] } }),
    );
    expect(ok.satisfied).toBe(true);
    expect(ok.evidence).toEqual([expect.objectContaining({ ref: 'r1' })]);
  });

  it('checksPassed: the latest check of that kind passed (for this commit when it names one)', () => {
    const gate: Gate = { requires: [{ checksPassed: 'regression', sameCommit: true }] };
    expect(evaluateGate(gate, facts()).satisfied).toBe(false);
    expect(
      evaluateGate(gate, facts({ checks: { regression: { id: 't1', passedAt: min(5), commit: null } } }))
        .satisfied,
    ).toBe(true);
    expect(
      evaluateGate(gate, facts({ checks: { regression: { id: 't1', passedAt: min(5), commit: 'other' } } }))
        .satisfied,
    ).toBe(false);
    expect(
      evaluateGate(gate, facts({ checks: { e2e: { id: 't2', passedAt: min(5), commit: null } } })).satisfied,
    ).toBe(false);
    expect(
      evaluateGate(
        gate,
        facts({ commit: null, checks: { regression: { id: 't1', passedAt: min(5), commit: null } } }),
      ).satisfied,
    ).toBe(false);
  });

  it('checksPassed: a test run that names no commit never vouches for another commit; ci fails closed', () => {
    const gate: Gate = { requires: [{ checksPassed: 'regression', sameCommit: true }] };
    const run = { regression: { id: 't1', passedAt: min(5), commit: null } };
    // the requested commit is not the latest merge: the commit-less run says nothing about it
    expect(evaluateGate(gate, facts({ commit: 'deadbeef00', checks: run })).satisfied).toBe(false);
    // no latest merge known: fails closed
    expect(evaluateGate(gate, facts({ latestMergeCommit: null, checks: run })).satisfied).toBe(false);
    const ci: Gate = { requires: [{ checksPassed: 'ci', sameCommit: true }] };
    const v = evaluateGate(ci, facts());
    expect(v.satisfied).toBe(false);
    expect(v.missing[0]).toContain('CI results are not collected');
  });

  it('phaseDone: the commit is the merge of a done phase', () => {
    const gate: Gate = { requires: [{ phaseDone: true }] };
    expect(evaluateGate(gate, facts()).satisfied).toBe(false);
    expect(
      evaluateGate(gate, facts({ phaseDoneCommits: [{ id: 'ph1', commit: 'abc1234def' }] })).satisfied,
    ).toBe(true);
  });

  it('a freeze stops everything; a window limits the days and hours (org time zone)', () => {
    expect(evaluateGate({ requires: [], freeze: true }, facts()).missing).toEqual(['releases are frozen']);
    const gate: Gate = { requires: [], window: { days: 'mon-fri', hours: '08-16', tz: 'org' } };
    expect(evaluateGate(gate, facts()).satisfied).toBe(true);
    expect(evaluateGate(gate, facts({ now: new Date('2026-10-21T18:00:00Z') })).satisfied).toBe(false);
    expect(evaluateGate(gate, facts({ now: new Date('2026-10-24T10:00:00Z') })).satisfied).toBe(false); // Saturday
    // 10:00 UTC is 20:00 in Sydney (UTC+11): outside the window there
    expect(evaluateGate(gate, facts({ timezone: 'Australia/Sydney' })).satisfied).toBe(false);
  });

  it('collects every missing requirement, so the answer says all that is open', () => {
    const gate: Gate = {
      requires: [
        { envHealthy: 'uat', sameCommit: true },
        { checksPassed: 'regression', sameCommit: true },
        { phaseDone: true },
      ],
      freeze: true,
    };
    expect(evaluateGate(gate, facts()).missing).toHaveLength(4);
  });
});

describe('gate windows and shape', () => {
  it('days: ranges, lists and a range that wraps the week', () => {
    expect([...windowDays('mon-fri')]).toEqual([0, 1, 2, 3, 4]);
    expect([...windowDays('mon,wed,fri')].sort()).toEqual([0, 2, 4]);
    expect([...windowDays('fri-mon')].sort()).toEqual([0, 4, 5, 6]);
  });
  it('hours may wrap midnight', () => {
    expect(
      inWindow({ days: 'mon-sun', hours: '22-06', tz: 'utc' }, new Date('2026-10-21T23:00:00Z'), null),
    ).toBe(true);
    expect(
      inWindow({ days: 'mon-sun', hours: '22-06', tz: 'utc' }, new Date('2026-10-21T12:00:00Z'), null),
    ).toBe(false);
  });
  it('the schema accepts the three kinds of requirement and rejects nonsense', () => {
    expect(
      GateSchema.safeParse({
        requires: [{ envHealthy: 'uat' }, { checksPassed: 'ci' }, { phaseDone: true }],
        window: { days: 'mon-fri', hours: '08-16' },
      }).success,
    ).toBe(true);
    expect(GateSchema.safeParse({ requires: [{ checksPassed: 'manual' }] }).success).toBe(false);
    expect(GateSchema.safeParse({ window: { days: 'weekdays', hours: '8' } }).success).toBe(false);
    // a gate names no releaser: who releases is the recipe's decision
    expect(GateSchema.parse({ requires: [], approvers: ['ceo'] })).toEqual({ requires: [] });
  });
});
