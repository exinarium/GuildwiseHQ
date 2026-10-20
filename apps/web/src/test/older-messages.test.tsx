import type { ThreadMessageDto } from '@aom/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOlderMessages } from '../components/chat/useOlderMessages.ts';

const T = '0192f3a0-0000-7000-8000-0000000000d1';
const id = (n: number) => `0192f3a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const msg = (n: number): ThreadMessageDto => ({
  id: id(n),
  threadId: T,
  authorKind: 'agent',
  authorUserId: null,
  authorAgentId: null,
  authorName: 'Ada',
  kind: 'chat',
  body: `m${n}`,
  data: {},
  createdAt: new Date(Date.UTC(2026, 9, 3, 10, 0, n)).toISOString(),
});
afterEach(() => vi.unstubAllGlobals());

describe('useOlderMessages', () => {
  it('sends the stable cursor, drops a message repeated across pages, and ignores overlapping calls', async () => {
    const urls: string[] = [];
    let release: () => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(String(url));
        await new Promise<void>((r) => {
          release = r;
        });
        // the page repeats message 5 (a boundary tie) and has more
        return new Response(
          JSON.stringify({ threadId: T, kind: 'chat', hasMore: true, messages: [msg(3), msg(4), msg(5)] }),
          {
            status: 200,
          },
        );
      }),
    );
    const latest = [msg(5), msg(6)];
    const { result } = renderHook(() => useOlderMessages(T, latest, true));
    await act(async () => {
      void result.current.loadOlder();
      void result.current.loadOlder(); // overlapping: ignored
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`beforeId=${id(5)}`);
    await act(async () => release());
    await waitFor(() => expect(result.current.messages.map((m) => m.body)).toEqual(['m3', 'm4', 'm5', 'm6']));
    expect(result.current.hasMore).toBe(true);
  });

  it('keeps the list and reports an error when the page fails (a later call is allowed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 500 })),
    );
    const latest = [msg(5)];
    const { result } = renderHook(() => useOlderMessages(T, latest, true));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await result.current.loadOlder();
    });
    expect(ok).toBe(false);
    expect(result.current.error).toBeTruthy();
    expect(result.current.messages).toHaveLength(1);
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
