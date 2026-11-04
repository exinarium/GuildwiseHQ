import { describe, expect, it } from 'vitest';
import { shiftCapMessage } from '../src/commands/shifts.ts';
import type { Ctx } from '../src/context.ts';
import type { RunnerConn } from '../src/runner-gateway/registry.ts';
import {
  recordEnforcedLimit,
  SLOT_KINDS_SQL,
  shiftLimitSourceFor,
  shiftLimitSync,
} from '../src/runner-gateway/shift-limit.ts';

// GWP-95: where the limit comes from, whether the runner enforces it, and the card message when it is full.

const ctxWithCap = (cap: number) => ({ config: { maxShiftsPerWorkstation: cap } }) as unknown as Ctx;
const conn = (o: Partial<RunnerConn> = {}): RunnerConn => ({ maxShifts: 5, ...o }) as RunnerConn;

describe('shiftLimitSourceFor', () => {
  it('names the workstation setting, the platform cap or the runner config', () => {
    expect(shiftLimitSourceFor(ctxWithCap(16), null)).toBe('runner_config');
    expect(shiftLimitSourceFor(ctxWithCap(16), 6)).toBe('workstation_setting');
    expect(shiftLimitSourceFor(ctxWithCap(16), 16)).toBe('workstation_setting');
    expect(shiftLimitSourceFor(ctxWithCap(16), 50)).toBe('platform_cap');
    expect(shiftLimitSourceFor(ctxWithCap(16), 'unlimited')).toBe('platform_cap');
    expect(shiftLimitSourceFor(ctxWithCap(0), 'unlimited')).toBe('workstation_setting');
    expect(shiftLimitSourceFor(ctxWithCap(0), 50)).toBe('workstation_setting');
  });
});

describe('shiftLimitSync', () => {
  const t0 = new Date('2026-11-04T10:00:00Z');
  const t1 = new Date('2026-11-04T10:00:10Z');
  it('unknown offline and for a runner without shift-limit:2', () => {
    expect(shiftLimitSync(undefined)).toBe('unknown');
    expect(shiftLimitSync(conn({ enforcedMaxShifts: 5, enforcedAt: t1 }))).toBe('unknown');
  });
  it('applying before the first report and while a report predates the change', () => {
    expect(shiftLimitSync(conn({ reportsShiftLimit: true }))).toBe('applying');
    expect(
      shiftLimitSync(conn({ reportsShiftLimit: true, enforcedMaxShifts: 4, enforcedAt: t0, limitChangedAt: t1 })),
    ).toBe('applying');
  });
  it('in sync, mismatch, and a pairing budget is a mismatch even at the same value', () => {
    const base = { reportsShiftLimit: true, enforcedAt: t1, limitChangedAt: t0 };
    expect(shiftLimitSync(conn({ ...base, enforcedMaxShifts: 5 }))).toBe('in_sync');
    expect(shiftLimitSync(conn({ ...base, enforcedMaxShifts: 4 }))).toBe('mismatch');
    expect(shiftLimitSync(conn({ ...base, enforcedMaxShifts: 5, enforcedSource: 'pairing_budget' }))).toBe(
      'mismatch',
    );
    expect(shiftLimitSync(conn({ ...base, maxShifts: 100_000, enforcedMaxShifts: 200_000 }))).toBe('in_sync');
  });
});

describe('recordEnforcedLimit', () => {
  it('keeps what a new runner reports, narrows the source and ignores an old heartbeat', () => {
    const c = conn();
    const now = new Date('2026-11-04T10:00:00Z');
    recordEnforcedLimit(c, { runningShifts: 1 } as never, now);
    expect(c.enforcedAt).toBeUndefined();
    recordEnforcedLimit(c, { maxShifts: 4, limitSource: 'pairing_budget' }, now);
    expect(c).toMatchObject({ enforcedMaxShifts: 4, enforcedSource: 'pairing_budget', enforcedAt: now });
    recordEnforcedLimit(c, { maxShifts: 6, limitSource: 'from_the_future' }, now);
    expect(c.enforcedMaxShifts).toBe(6);
    expect(c.enforcedSource).toBeUndefined();
  });
});

describe('the slot rule in SQL', () => {
  it('leaves out chat and CEO shifts', () => {
    expect(SLOT_KINDS_SQL()).toBe("kind NOT IN ('chat','ceo')");
    expect(SLOT_KINDS_SQL('s')).toBe("s.kind NOT IN ('chat','ceo')");
  });
});

describe('shiftCapMessage', () => {
  const tx = { query: async () => ({ rows: [{ name: 'Studio' }] }) } as never;
  it('names the limit, its source and the shifts holding the slots', async () => {
    const text = await shiftCapMessage(tx, 'ws-1', {
      limit: 4,
      source: 'workstation_setting',
      running: 4,
      holders: [
        { shiftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a1', kind: 'card', cardRef: 'GWP-94', agentName: 'Ada' },
        { shiftId: '019e3f6a-7b1c-7a2d-8c3e-0123456789a2', kind: 'devops', agentName: 'Anvil' },
      ],
    });
    expect(text).toBe(
      'Waiting: workstation Studio is at its shift limit (4, workstation setting; 4 running). Slots held by GWP-94 (Ada), devops (Anvil). The card is back in the queue.',
    );
  });
  it('an unknown source is shown as sent; no limit reads as such', async () => {
    const text = await shiftCapMessage(tx, 'ws-1', { limit: 100_000, source: 'later', running: 0, holders: [] });
    expect(text).toBe('Waiting: workstation Studio is at its shift limit (no limit, later; 0 running). The card is back in the queue.');
  });
});
