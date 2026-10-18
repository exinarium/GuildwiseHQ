import {
  type ApprovalApproveRequest,
  type ApprovalSendBackRequest,
  type CardDiffResponse,
  CardDiffResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';

/** The diff stored at the review handoff (lean team), loaded when the owner opens it. */
export const useCardDiff = (cardId: string, enabled: boolean, sha?: string | null) =>
  useQuery({
    queryKey: ['card-diff', cardId, sha ?? null],
    enabled: enabled && !!cardId,
    queryFn: () => get<CardDiffResponse>(`/cards/${cardId}/diff`, CardDiffResponseSchema),
  });

/** Approval-step actions on a card (backlog #16). Each refreshes the card, the board and the desk. */
function useApprovalAction<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ['card', 'board', 'desk', 'agents']) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const useApprove = (cardId: string) =>
  useApprovalAction((b: ApprovalApproveRequest) => post(`/cards/${cardId}/approval/approve`, b));
export const useApprovalSendBack = (cardId: string) =>
  useApprovalAction((b: ApprovalSendBackRequest) => post(`/cards/${cardId}/approval/send-back`, b));
