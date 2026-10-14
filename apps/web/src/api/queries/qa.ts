import type { QaAssignRequest, QaPassRequest, QaSendBackRequest, QaSkipRequest } from '@aom/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from '../client.ts';

/** Manual QA actions on a card (docs/design/manual-qa.md). Each refreshes the card, the board and the desk. */
function useQaAction<V>(cardId: string, fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ['card', 'board', 'desk', 'agents']) void qc.invalidateQueries({ queryKey: [key] });
    },
    meta: { cardId },
  });
}

export const useQaPass = (cardId: string) =>
  useQaAction(cardId, (b: QaPassRequest) => post(`/cards/${cardId}/qa/pass`, b));
export const useQaSkip = (cardId: string) =>
  useQaAction(cardId, (b: QaSkipRequest) => post(`/cards/${cardId}/qa/skip`, b));
export const useQaSendBack = (cardId: string) =>
  useQaAction(cardId, (b: QaSendBackRequest) => post(`/cards/${cardId}/qa/send-back`, b));
export const useQaAssign = (cardId: string) =>
  useQaAction(cardId, (b: QaAssignRequest) => post(`/cards/${cardId}/qa/assign`, b));
