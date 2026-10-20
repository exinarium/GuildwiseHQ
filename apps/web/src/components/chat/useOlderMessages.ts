import type { ThreadMessageDto, ThreadMessagesResponse } from '@aom/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from '../../api/client.ts';

const PAGE = 50;

/**
 * Earlier messages than the newest page the thread query returns: `GET /threads/:id/messages?before=` pages them in as the
 * reader scrolls up. Returns the merged, oldest-first list (older ones first, no duplicates).
 */
export function useOlderMessages(threadId: string, latest: ThreadMessageDto[], latestHasMore: boolean) {
  const [older, setOlder] = useState<ThreadMessageDto[]>([]);
  const [more, setMore] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the thread changes
  useEffect(() => {
    setOlder([]);
    setMore(null);
    setError(null);
  }, [threadId]);

  // One copy of each message, whichever page it arrived in (a page boundary can repeat one).
  const seen = new Set<string>();
  const all = [...older, ...latest].filter((m) => {
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  all.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const hasMore = more ?? latestHasMore;
  const oldest = all[0];
  const busy = useRef(false);

  const loadOlder = useCallback(async () => {
    if (busy.current || !hasMore || !oldest) return false;
    busy.current = true;
    setLoading(true);
    setError(null);
    try {
      const r = await get<ThreadMessagesResponse>(
        `/threads/${threadId}/messages?limit=${PAGE}&before=${encodeURIComponent(oldest.createdAt)}&beforeId=${oldest.id}`,
      );
      setOlder((o) => [...r.messages, ...o]);
      setMore(r.hasMore);
      return true;
    } catch {
      setError('Could not load earlier messages.');
      return false;
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [threadId, hasMore, oldest]);

  return { messages: all, hasMore, loading, error, loadOlder };
}
