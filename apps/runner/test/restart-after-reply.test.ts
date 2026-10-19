import { describe, expect, it } from 'vitest';
import { RestartAfterReply } from '../src/restart-after-reply.ts';

function setup(over: { maxWaitMs?: number } = {}) {
  let t = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const state = { acked: false, idle: true, restarts: 0 };
  const r = new RestartAfterReply({
    replyAcked: () => state.acked,
    isIdle: () => state.idle,
    restart: () => {
      state.restarts++;
    },
    now: () => t,
    later: (fn, ms) => timers.push({ at: t + ms, fn }),
    pollMs: 1000,
    ...over,
  });
  const advance = (ms: number) => {
    const end = t + ms;
    for (;;) {
      const next = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      timers.splice(timers.indexOf(next), 1);
      t = next.at;
      next.fn();
    }
    t = end;
  };
  return { r, state, advance };
}

describe('restart after the reply', () => {
  it('does nothing before the turn finished, and waits for the server to acknowledge the reply', () => {
    const { r, state, advance } = setup();
    r.request('chat-1', 'new tools');
    advance(5000);
    expect(state.restarts).toBe(0);
    r.turnFinished('chat-1', 'frame-1');
    advance(3000);
    expect(state.restarts).toBe(0); // not acked yet
    state.acked = true;
    advance(1500);
    expect(state.restarts).toBe(1);
    advance(10_000);
    expect(state.restarts).toBe(1); // once
  });

  it('waits for an idle runner too', () => {
    const { r, state, advance } = setup();
    state.acked = true;
    state.idle = false;
    r.request('chat-1');
    r.turnFinished('chat-1', 'f');
    advance(30_000);
    expect(state.restarts).toBe(0);
    state.idle = true;
    advance(2000);
    expect(state.restarts).toBe(1);
  });

  it('restarts anyway after the longest wait', () => {
    const { r, state, advance } = setup({ maxWaitMs: 10 * 60_000 });
    state.idle = false;
    r.request('chat-1');
    r.turnFinished('chat-1');
    advance(9 * 60_000);
    expect(state.restarts).toBe(0);
    advance(2 * 60_000);
    expect(state.restarts).toBe(1);
  });

  it('only the turn that asked arms it', () => {
    const { r, state, advance } = setup();
    state.acked = true;
    r.request('chat-1');
    r.turnFinished('chat-2');
    advance(5000);
    expect(state.restarts).toBe(0);
    r.turnFinished('chat-1');
    advance(1000);
    expect(state.restarts).toBe(1);
  });
});
