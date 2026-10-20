import {
  type ChatDto,
  ChatsResponseSchema,
  type CreateChatRequest,
  CreateChatResponseSchema,
  type ThreadMessagesResponse,
  ThreadMessagesResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { del, get, post } from '../client.ts';

export function useChats() {
  return useQuery({
    queryKey: ['chats'],
    queryFn: async () => (await get('/chats', ChatsResponseSchema)).chats,
  });
}

export function useChat(threadId: string | undefined) {
  const chats = useChats();
  return { ...chats, data: chats.data?.find((c) => c.threadId === threadId) as ChatDto | undefined };
}

export function useCreateChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: CreateChatRequest) =>
      (await post('/chats', b, CreateChatResponseSchema)).chat as ChatDto,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['chats'] }),
  });
}

const refreshChats = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ queryKey: ['chats'] });

/** Close: hides the chat from the user's list (it stays under Archived). */
export function useCloseChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => post(`/chats/${threadId}/close`, {}),
    onSuccess: () => refreshChats(qc),
  });
}

export function useRestoreChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => post(`/chats/${threadId}/restore`, {}),
    onSuccess: () => refreshChats(qc),
  });
}

/** Delete for good (not for a chat linked to a card: the server refuses, close it instead). */
export function useDeleteChat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) => del(`/chats/${threadId}`),
    onSuccess: () => refreshChats(qc),
  });
}

export function useThreadMessages(threadId: string | undefined) {
  return useQuery({
    queryKey: ['thread', threadId],
    enabled: !!threadId,
    queryFn: () =>
      get<ThreadMessagesResponse>(`/threads/${threadId}/messages?limit=200`, ThreadMessagesResponseSchema),
  });
}

/**
 * Archive all: one request (`POST /chats/archive-all`). The server never archives the live CEO chat; `exceptThreadIds`
 * keeps any other chat the caller wants to leave open. Nothing is deleted; Restore undoes it per chat.
 */
export function useArchiveAllChats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (exceptThreadIds: string[] = []) =>
      (
        await post<{ archived: number }>(
          '/chats/archive-all',
          exceptThreadIds.length > 0 ? { exceptThreadIds } : {},
        )
      ).archived,
    onSettled: () => refreshChats(qc),
  });
}

/** Total unread agent messages over the chats in the user's list (closed chats do not count), for the tab and top bar badges. */
export function useUnreadChatTotal(): number {
  const chats = useChats().data;
  return (chats ?? []).reduce((n, c) => (c.archived ? n : n + (c.unreadCount ?? 0)), 0);
}

/** Quiet time before an open chat is marked read, so a burst of messages makes one request. */
export const MARK_READ_DEBOUNCE_MS = 1000;

/**
 * Marks the open chat read on the server (`POST /chats/:id/read`, which also clears it on the user's other devices) while
 * it has unread agent messages AND the page is visible: debounced, and again when the tab becomes visible. A hidden tab
 * never marks anything read.
 */
export function useMarkChatRead(threadId: string, unreadCount: number, newestAt: string | undefined) {
  const qc = useQueryClient();
  const inflight = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `newestAt` re-arms the timer when a message arrives
  useEffect(() => {
    if (!unreadCount) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      if (document.visibilityState !== 'visible' || inflight.current) return;
      inflight.current = true;
      post(`/chats/${threadId}/read`, {})
        .catch(() => undefined)
        .finally(() => {
          inflight.current = false;
          void qc.invalidateQueries({ queryKey: ['chats'] });
        });
    };
    const arm = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'visible') timer = setTimeout(run, MARK_READ_DEBOUNCE_MS);
    };
    arm();
    document.addEventListener('visibilitychange', arm);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', arm);
    };
  }, [threadId, unreadCount, newestAt, qc]);
}
