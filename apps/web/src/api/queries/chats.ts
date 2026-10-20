import {
  type ChatDto,
  ChatsResponseSchema,
  type CreateChatRequest,
  CreateChatResponseSchema,
  type ThreadMessagesResponse,
  ThreadMessagesResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

/** Archive all: closes every chat in the list with the existing per-chat close (nothing is deleted; Restore undoes it). */
export function useCloseAllChats() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (threadIds: string[]) => {
      const results = await Promise.allSettled(threadIds.map((id) => post(`/chats/${id}/close`, {})));
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0)
        throw new Error(`${failed} of ${threadIds.length} chats could not be archived. Try again.`);
      return threadIds.length;
    },
    onSettled: () => refreshChats(qc),
  });
}
