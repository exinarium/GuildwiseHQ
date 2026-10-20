import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveSocket } from '../ws/socket.ts';

/** A dropped connection must not leave a chat "working" for good: listeners hear it, the working set clears, and a
 * reconnect refetches the chats and threads. */
class FakeWs {
  static last: FakeWs;
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeWs.last = this;
  }
  send() {}
  close() {
    this.onclose?.();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeWs);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const T = '0192f3a0-0000-7000-8000-0000000000d1';

describe('socket drop mid-stream', () => {
  it('emits disconnected, clears working, and refetches chats and threads after the reconnect', () => {
    const qc = new QueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    const s = new LiveSocket(qc);
    s.start();
    FakeWs.last.onopen?.();
    s.handle({ type: 'ready', seq: 1 });
    const events: string[] = [];
    s.listenChat(T, (e) => events.push(e.type));
    s.handle({ type: 'chat.delta', threadId: T, text: 'x' });
    expect(events).toContain('delta');
    expect(s.getWorking().has(T)).toBe(true);
    FakeWs.last.onclose?.();
    expect(events).toContain('disconnected');
    expect(s.getWorking().size).toBe(0);
    expect(s.getState()).toBe('closed');
    vi.advanceTimersByTime(1000);
    FakeWs.last.onopen?.();
    spy.mockClear();
    s.handle({ type: 'ready', seq: 2 });
    const keys = spy.mock.calls.map((c) => JSON.stringify((c[0] as any)?.queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["chats"]', '["thread"]']));
    s.stop();
  });
});
