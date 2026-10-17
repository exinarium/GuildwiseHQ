import { RESYNC_THRESHOLD } from '@aom/shared';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INVALIDATE_WINDOW_MS } from '../ws/invalidate.ts';
import { LiveSocket } from '../ws/socket.ts';

// Lean Team v3 (S1b), section 9 "Double fetch on first connect", and coalesced invalidations.

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const event = (seq: number, streamId = 'card-1') => ({
  type: 'event',
  event: {
    seq,
    type: 'CardClaimed',
    streamId,
    payload: {},
    actor: { kind: 'system', id: null },
    projectId: 'p1',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
});

describe('first ready', () => {
  it('does not invalidate everything: the page is already fetching its queries', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const s = new LiveSocket(qc);
    s.handle({ type: 'ready', seq: 10 });
    expect(spy).not.toHaveBeenCalled();
    expect(s.getState()).toBe('open');
  });

  it('a reconnect that missed little keeps the caches; one that missed a lot refetches everything', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const s = new LiveSocket(qc);
    s.handle({ type: 'ready', seq: 10 });
    s.handle({ type: 'ready', seq: 10 + RESYNC_THRESHOLD });
    expect(spy).not.toHaveBeenCalled();
    s.handle({ type: 'ready', seq: 10 + 2 * RESYNC_THRESHOLD + 5 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith();
  });
});

describe('coalesced invalidations', () => {
  it('a burst of events invalidates each affected query once', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const s = new LiveSocket(qc);
    for (let i = 1; i <= 20; i++) s.handle(event(i));
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS + 1);
    const boards = spy.mock.calls.filter(
      (c) => JSON.stringify(c[0]) === JSON.stringify({ queryKey: ['board', 'p1'] }),
    );
    expect(boards).toHaveLength(1);
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('a resync drops what was waiting and invalidates everything once', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const s = new LiveSocket(qc);
    s.handle(event(1));
    s.handle({ type: 'resync' });
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(INVALIDATE_WINDOW_MS + 1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
