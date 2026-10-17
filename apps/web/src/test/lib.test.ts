import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { hueFor, initials } from '../lib/avatar.ts';
import { ageLabel } from '../lib/time.ts';
import { INVALIDATE_WINDOW_MS, keysForEvent } from '../ws/invalidate.ts';
import { LiveSocket } from '../ws/socket.ts';

describe('avatar', () => {
  it('is deterministic', () => {
    expect(initials('Marlowe')).toBe('MA');
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(hueFor('Quinn')).toBe(hueFor('Quinn'));
    expect(hueFor('Quinn')).not.toBe(hueFor('Marlowe'));
  });
});

describe('age', () => {
  it('formats compactly', () => {
    const now = Date.parse('2026-01-01T12:00:00Z');
    expect(ageLabel('2026-01-01T11:59:50Z', now)).toBe('now');
    expect(ageLabel('2026-01-01T11:30:00Z', now)).toBe('30m');
    expect(ageLabel('2025-12-31T12:00:00Z', now)).toBe('24h');
    expect(ageLabel('2025-12-25T12:00:00Z', now)).toBe('7d');
  });
});

describe('query invalidation', () => {
  it('maps card events to the board of their project and the card', () => {
    const keys = keysForEvent({ type: 'ReviewApproved', streamId: 'card-abc', projectId: 'p1' });
    expect(keys).toContainEqual(['board', 'p1']);
    expect(keys).toContainEqual(['card']);
  });
  it('maps agent and workstation events', () => {
    expect(keysForEvent({ type: 'AgentHired', streamId: 'agent-1', projectId: null })).toContainEqual([
      'agents',
    ]);
    expect(
      keysForEvent({ type: 'WorkstationConnected', streamId: 'workstation-1', projectId: null }),
    ).toContainEqual(['workstations']);
  });
});

describe('LiveSocket', () => {
  it('invalidates board queries when an event message arrives and ignores junk', () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const s = new LiveSocket(qc);
    s.handle({ nonsense: true });
    expect(spy).not.toHaveBeenCalled();
    s.handle({
      type: 'event',
      event: {
        seq: 5,
        type: 'CardClaimed',
        streamId: 'card-1',
        payload: {},
        actor: { kind: 'system', id: null },
        projectId: 'p1',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    });
    // events are gathered for a short window, then each stale query is invalidated once
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS + 1);
    expect(spy).toHaveBeenCalledWith({ queryKey: ['board', 'p1'] });
    vi.useRealTimers();
  });
  it('forwards shift progress to watchers', () => {
    const s = new LiveSocket(new QueryClient());
    const got: string[] = [];
    const off = s.watchShift('0192f3a0-0000-7000-8000-000000000009', (items) =>
      got.push(...items.map((i) => i.text)),
    );
    s.handle({
      type: 'shift.progress',
      shiftId: '0192f3a0-0000-7000-8000-000000000009',
      cardId: null,
      items: [{ at: '2026-01-01T00:00:00.000Z', kind: 'text', text: 'hello' }],
    });
    off();
    expect(got).toEqual(['hello']);
  });
});
