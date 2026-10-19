import {
  type AcknowledgeAllCeoDecisionsResponse,
  type AnswerDeskItemRequest,
  type AnswerDeskItemResponse,
  type CorrectCeoDecisionRequest,
  type DeskListResponse,
  DeskListResponseSchema,
  type ResolveDeskItemRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../client.ts';

export function useDesk(opts: { projectId?: string; status?: 'open' | 'closed' | 'all' } = {}) {
  const status = opts.status ?? 'open';
  return useQuery({
    queryKey: ['desk', opts.projectId ?? 'all', status],
    queryFn: () =>
      get<DeskListResponse>(`/desk${qs({ projectId: opts.projectId, status })}`, DeskListResponseSchema),
  });
}

function useDeskAction<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ['desk', 'board', 'card', 'ledger']) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const useAnswerDeskItem = () =>
  useDeskAction((v: { id: string; body: AnswerDeskItemRequest }) =>
    post<AnswerDeskItemResponse>(`/desk/${v.id}/answer`, v.body),
  );
export const useResolveDeskItem = () =>
  useDeskAction((v: { id: string; body: ResolveDeskItemRequest }) => post(`/desk/${v.id}/resolve`, v.body));
export const useDismissDeskItem = () => useDeskAction((id: string) => post(`/desk/${id}/dismiss`, {}));

/** CEO decisions: acknowledge one, acknowledge all, or correct one (the CEO learns from the correction). */
export const useAcknowledgeCeoDecision = () =>
  useDeskAction((id: string) => post(`/desk/${id}/ceo-decision/acknowledge`, {}));
export const useAcknowledgeAllCeoDecisions = () =>
  useDeskAction<void, AcknowledgeAllCeoDecisionsResponse>(() =>
    post<AcknowledgeAllCeoDecisionsResponse>('/desk/ceo-decisions/acknowledge-all', {}),
  );
export const useCorrectCeoDecision = () =>
  useDeskAction((v: { id: string; body: CorrectCeoDecisionRequest }) =>
    post<{ applied: string | null }>(`/desk/${v.id}/ceo-decision/correct`, v.body),
  );
