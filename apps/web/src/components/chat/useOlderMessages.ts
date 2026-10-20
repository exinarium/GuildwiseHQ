import type { ThreadMessageDto, ThreadMessagesResponse } from '@aom/shared';
import { useCallback, useEffect, useState } from 'react';
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

  const ids = new Set(latest.map((m) => m.id));
  const olderOnly = older.filter((m) => !ids.has(m.id));
  const all = [...olderOnly, ...latest];
  const hasMore = more ?? latestHasMore;
  const oldest = all[0]?.createdAt;

  const loadOlder = useCallback(async () => {
    if (loading || !hasMore || !oldest) return false;
    setLoading(true);
    setError(null);
    try {
      const r = await get<ThreadMessagesResponse>(
        `/threads/${threadId}/messages?limit=${PAGE}&before=${encodeURIComponent(oldest)}`,
      );
      setOlder((o) => [...r.messages, ...o]);
      setMore(r.hasMore);
      return true;
    } catch {
      setError('Could not load earlier messages.');
      return false;
    } finally {
      setLoading(false);
    }
  }, [threadId, loading, hasMore, oldest]);

  return { messages: all, hasMore, loading, error, loadOlder };
}
