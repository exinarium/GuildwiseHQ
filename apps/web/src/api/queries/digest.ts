import {
  type DigestItemDto,
  type FeedListResponse,
  FeedListResponseSchema,
  type RateDigestItemRequest,
  type TasteResponse,
  TasteResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';

export function useFeedList(projectId: string | undefined) {
  return useQuery({
    queryKey: ['digest', 'feed', projectId],
    enabled: !!projectId,
    queryFn: () => get<FeedListResponse>(`/projects/${projectId}/feed`, FeedListResponseSchema),
  });
}

/** `taste.md` as the ratings wrote it. */
export function useTaste(projectId: string | undefined) {
  return useQuery({
    queryKey: ['digest', 'taste', projectId],
    enabled: !!projectId,
    queryFn: () => get<TasteResponse>(`/projects/${projectId}/taste`, TasteResponseSchema),
  });
}

export function useRateDigestItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; body: RateDigestItemRequest }) =>
      post<DigestItemDto>(`/digest-items/${v.id}/rate`, v.body),
    onSuccess: () => {
      for (const key of ['desk', 'digest']) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}
