import type { CeoTopicAccept, CeoTopicCheckDto, CeoTopicEdit, CeoTopicsDto } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';
import { ceoKey } from './ceo.ts';

/** Research topics for the Guildwise blog (docs/design/ceo-blog-topics.md): the Topics tab and the report sections. */
export function useCeoTopics(enabled = true) {
  return useQuery({
    queryKey: [...ceoKey, 'topics'],
    enabled,
    queryFn: () => get<CeoTopicsDto>('/ceo/topics'),
  });
}

function useTopicMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ceoKey });
      void qc.invalidateQueries({ queryKey: ['desk'] });
    },
  });
}

export const useAcceptTopic = () =>
  useTopicMutation((v: { id: string } & CeoTopicAccept) => {
    const { id, ...body } = v;
    return post<{ ok: true }>(`/ceo/topics/${id}/accept`, body);
  });

export const useRejectTopic = () =>
  useTopicMutation((v: { id: string; reason?: string }) =>
    post<{ ok: true }>(`/ceo/topics/${v.id}/reject`, v.reason ? { reason: v.reason } : {}),
  );

/** The live check of an edited question: findings, nothing saved. */
export const checkTopic = (body: CeoTopicEdit) => post<CeoTopicCheckDto>('/ceo/topics/check', body);
