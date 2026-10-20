import { useCallback, useEffect, useState } from 'react';

const key = (threadId: string) => `aom.chatDraft.${threadId}`;

function read(threadId: string): string {
  try {
    return localStorage.getItem(key(threadId)) ?? '';
  } catch {
    return '';
  }
}

/** The composer text, kept per thread in localStorage so leaving the chat does not lose it. `initial` wins over a saved draft. */
export function useDraft(threadId: string, initial?: string) {
  const [draft, setDraftState] = useState(() => initial ?? read(threadId));
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the thread changes
  useEffect(() => {
    setDraftState(initial ?? read(threadId));
  }, [threadId]);
  const setDraft = useCallback(
    (v: string | ((d: string) => string)) => {
      setDraftState((d) => {
        const next = typeof v === 'function' ? v(d) : v;
        try {
          if (next) localStorage.setItem(key(threadId), next);
          else localStorage.removeItem(key(threadId));
        } catch {
          /* storage full or blocked: the draft just is not saved */
        }
        return next;
      });
    },
    [threadId],
  );
  return [draft, setDraft] as const;
}
