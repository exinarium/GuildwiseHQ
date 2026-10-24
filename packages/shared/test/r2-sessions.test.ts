import { describe, expect, it } from 'vitest';
import {
  assembleMinutes,
  BOARD_FIXED_SEATS,
  type BoardOptionScore,
  castProblem,
  extendedLimitMinutes,
  formatCountdown,
  isFixedSeat,
  renderScoreTable,
  SESSION_TIME_TICK_MAX_MS,
  tallyScores,
  tickClock,
  timeStatus,
  warnMinutesFor,
} from '../src/index.ts';

const seat = (refId: string) => ({ kind: 'persona', refId });
const FIXED = [seat('optimist'), seat('devils-advocate')];

describe('the cast rule', () => {
  it('needs both fixed seats and 3 to 4 others', () => {
    expect(castProblem([...FIXED, seat('a'), seat('b'), seat('c')])).toBeNull();
    expect(castProblem([...FIXED, seat('a'), seat('b'), seat('c'), seat('d')])).toBeNull();
    expect(castProblem([...FIXED, seat('a'), seat('b')])).toMatch(/3 to 4/);
    expect(castProblem([...FIXED, seat('a'), seat('b'), seat('c'), seat('d'), seat('e')])).toMatch(/3 to 4/);
    expect(castProblem([seat('optimist'), seat('a'), seat('b'), seat('c')])).toMatch(/Devil's Advocate/);
    expect(castProblem([seat('devils-advocate'), seat('a'), seat('b'), seat('c')])).toMatch(/Optimist/);
    // an agent with the same id is not the persona
    expect(
      castProblem([
        { kind: 'agent', refId: 'optimist' },
        seat('devils-advocate'),
        seat('a'),
        seat('b'),
        seat('c'),
      ]),
    ).toMatch(/Optimist/);
  });
  it('knows the fixed seats', () => {
    expect(BOARD_FIXED_SEATS.map((f) => f.seat)).toEqual(['Optimist', "Devil's Advocate"]);
    expect(isFixedSeat(seat('optimist'))).toBe(true);
    expect(isFixedSeat(seat('security'))).toBe(false);
    expect(isFixedSeat({ kind: 'agent', refId: 'optimist' })).toBe(false);
  });
});

describe('the time limit clock', () => {
  it('counts running time only, and at most a minute per tick (a restart does not eat the meeting)', () => {
    const t0 = new Date('2026-10-24T10:00:00Z');
    let c = tickClock({ elapsedMs: 0, tickAt: null }, t0, true);
    expect(c).toEqual({ elapsedMs: 0, tickAt: t0.toISOString() });
    c = tickClock(c, new Date(t0.getTime() + 15_000), true);
    expect(c.elapsedMs).toBe(15_000);
    // paused: nothing is added, the tick moves on
    c = tickClock(c, new Date(t0.getTime() + 15_000 + 600_000), false);
    expect(c.elapsedMs).toBe(15_000);
    // a long gap (server down) counts at most one tick
    c = tickClock(c, new Date(new Date(c.tickAt as string).getTime() + 3_600_000), true);
    expect(c.elapsedMs).toBe(15_000 + SESSION_TIME_TICK_MAX_MS);
  });
  it('warns in the last minutes and is over at the limit', () => {
    expect(warnMinutesFor(60)).toBe(5);
    expect(warnMinutesFor(15)).toBe(5);
    expect(warnMinutesFor(10)).toBe(3);
    expect(warnMinutesFor(5)).toBe(1);
    expect(timeStatus(null, 0)).toBeNull();
    expect(timeStatus(30, 24 * 60_000)).toMatchObject({ warn: false, over: false });
    expect(timeStatus(30, 26 * 60_000)).toMatchObject({ warn: true, over: false, remainingMs: 4 * 60_000 });
    expect(timeStatus(30, 30 * 60_000)).toMatchObject({ warn: false, over: true, remainingMs: 0 });
    expect(timeStatus(30, 31 * 60_000)).toMatchObject({ over: true, remainingMs: 0 });
  });
  it('extends from now, so an overshoot is not eaten, and formats a countdown', () => {
    expect(extendedLimitMinutes(31 * 60_000 + 10, 10)).toBe(42);
    expect(extendedLimitMinutes(0, 15)).toBe(15);
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(3_725_000)).toBe('1:02:05');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});

describe('the option tally', () => {
  const rows = [
    { option: 'Alpha', participantId: 'p1', name: 'Optimist', score: 5, why: 'big' },
    { option: 'Alpha', participantId: 'p2', name: 'Skeptic', score: 2, why: 'risky' },
    { option: 'Beta', participantId: 'p1', name: 'Optimist', score: 4, why: '' },
    { option: 'Beta', participantId: 'p2', name: 'Skeptic', score: 4, why: '' },
    { option: 'Gamma', participantId: 'p1', name: 'Optimist', score: 1, why: '' },
  ];
  it('totals and averages per option, best first, ties by average then name', () => {
    const t = tallyScores(rows);
    expect(t.map((o) => [o.option, o.total, o.average])).toEqual([
      ['Beta', 8, 4],
      ['Alpha', 7, 3.5],
      ['Gamma', 1, 1],
    ]);
    expect(t[0]?.scores.map((s) => s.name)).toEqual(['Optimist', 'Skeptic']);
    expect(tallyScores([])).toEqual([]);
  });
  it('renders a table with a column per seat, and puts it in the minutes', () => {
    const t = tallyScores(rows) as BoardOptionScore[];
    const table = renderScoreTable(t);
    expect(table.split('\n')[0]).toBe('| Option | Optimist | Skeptic | Total | Average |');
    expect(table).toContain('| Gamma | 1 | - | 1 | 1 |');
    const md = assembleMinutes({
      topic: 'T',
      format: 'option_scoring',
      brief: '',
      startedAt: '2026-10-24T10:00:00Z',
      rounds: 2,
      endReason: 'at the time limit',
      people: [{ name: 'Optimist', seat: 'Optimist', kind: 'persona' }],
      synthesis: '',
      disagreements: [],
      decisions: [],
      notes: [],
      costUsd: 0,
      scores: t,
    });
    expect(md).toContain('## Option scores');
    expect(md.indexOf('## Option scores')).toBeLessThan(md.indexOf('## Whiteboard'));
    expect(
      assembleMinutes({
        ...{
          topic: 'T',
          format: 'open',
          brief: '',
          startedAt: '2026-10-24T10:00:00Z',
          rounds: 1,
          endReason: 'x',
          people: [],
          synthesis: '',
          disagreements: [],
          decisions: [],
          notes: [],
          costUsd: 0,
        },
      }),
    ).not.toContain('Option scores');
  });
});
