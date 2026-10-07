import {
  type DigestItemDto,
  type RateDigestItemRequest,
  type TranscriptResponse,
  TranscriptResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';

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

/** The stored transcript of a video or podcast (only fetched once the expander is opened). */
export function useTranscript(projectId: string, url: string, enabled: boolean) {
  return useQuery({
    queryKey: ['digest', 'transcript', projectId, url],
    enabled,
    retry: false,
    queryFn: () =>
      get<TranscriptResponse>(
        `/projects/${projectId}/transcript?url=${encodeURIComponent(url)}`,
        TranscriptResponseSchema,
      ),
  });
}
