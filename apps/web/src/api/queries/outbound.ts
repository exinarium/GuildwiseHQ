import {
  type CreateOutboundDraftRequest,
  type OutboundDraftDto,
  OutboundListResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../client.ts';

/** The updates of one card to its ticket (`GET /api/outbound?card=`): drafts, approvals, results, failures. */
export function useOutbound(card: string | undefined) {
  return useQuery({
    queryKey: ['outbound', card ?? 'all'],
    queryFn: async (): Promise<OutboundDraftDto[]> =>
      (await get(`/outbound${qs({ card })}`, OutboundListResponseSchema)).drafts,
  });
}

function useOutboundAction<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ['outbound', 'desk', 'card']) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const useCreateOutboundDraft = (cardId: string) =>
  useOutboundAction((body: CreateOutboundDraftRequest) => post(`/cards/${cardId}/outbound`, body));
export const useRetryOutbound = () => useOutboundAction((id: string) => post(`/outbound/${id}/retry`, {}));
