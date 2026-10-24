import type {
  AgentDraft,
  AgentDraftDto,
  AgentDraftRequest,
  AgentDraftStatus,
  FollowUpSettings,
  HireFromDraftRequest,
  MentionableAgentDto,
  MentionPolicy,
  StarterGalleryResponse,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../client.ts';

// ---- @agent in card comments

/** The agents the viewer may mention on this card (the comment box's autocomplete). */
export function useMentionable(cardId: string, enabled = true) {
  return useQuery({
    enabled,
    staleTime: 30_000,
    queryKey: ['mentionable', cardId],
    queryFn: () => get<{ agents: MentionableAgentDto[] }>(`/cards/${cardId}/mentionable`),
  });
}

export function useMentionPolicy(agentId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['agents', agentId, 'mention-policy'],
    queryFn: () => get<MentionPolicy>(`/agents/${agentId}/mention-policy`),
  });
}

export function useSetMentionPolicy(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: MentionPolicy) => put<MentionPolicy>(`/agents/${agentId}/mention-policy`, p),
    onSuccess: (data) => {
      qc.setQueryData(['agents', agentId, 'mention-policy'], data);
      void qc.invalidateQueries({ queryKey: ['mentionable'] });
    },
  });
}

// ---- describe-an-agent quick hire

export const useStartAgentDraft = () =>
  useMutation({ mutationFn: (b: AgentDraftRequest) => post<{ threadId: string }>('/agents/draft', b) });

/** The drafting turn's state; polls until it is ready or has failed. */
export function useAgentDraft(threadId: string | null) {
  return useQuery({
    enabled: !!threadId,
    queryKey: ['agent-draft', threadId],
    queryFn: () => get<AgentDraftStatus>(`/agents/draft/${threadId}`),
    refetchInterval: (q) => (q.state.data?.status === 'working' || !q.state.data ? 2000 : false),
  });
}

/** The draft as the hirer's authority allows it (asked again after every edit of the tools). */
export const useClampDraft = () =>
  useMutation({
    mutationFn: (draft: AgentDraft) => post<{ draft: AgentDraftDto }>('/agents/draft-clamp', { draft }),
  });

export function useHireFromDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: HireFromDraftRequest) => post('/agents/hire-from-draft', b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['hr'] });
      void qc.invalidateQueries({ queryKey: ['roles'] });
    },
  });
}

// ---- starter gallery

export function useStarterGallery(enabled = true) {
  return useQuery({
    enabled,
    staleTime: 60_000,
    queryKey: ['starter-gallery'],
    queryFn: () => get<StarterGalleryResponse>('/starter-gallery'),
  });
}

export const useStarterDraft = () =>
  useMutation({
    mutationFn: (key: string) =>
      get<{ draft: AgentDraftDto }>(`/starter-gallery/${encodeURIComponent(key)}/draft`),
  });

// ---- follow-up and chase

export function useFollowUpDays() {
  return useQuery({
    queryKey: ['org', 'follow-up'],
    queryFn: () => get<FollowUpSettings>('/org/follow-up'),
  });
}

export function useSetFollowUpDays() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (days: number) => put<FollowUpSettings>('/org/follow-up', { days }),
    onSuccess: (data) => qc.setQueryData(['org', 'follow-up'], data),
  });
}

export function useSnoozeDeskItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; days: number }) =>
      post<{ snoozedUntil: string }>(`/desk/${v.id}/snooze`, { days: v.days }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['desk'] }),
  });
}
