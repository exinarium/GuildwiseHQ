import type { ApprovalApproveRequest, ApprovalSendBackRequest } from '@aom/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from '../client.ts';

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
