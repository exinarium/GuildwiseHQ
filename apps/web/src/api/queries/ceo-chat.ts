import type {
  CeoChatStateDto,
  CeoOrderTurnDto,
  CeoRepeatDto,
  CorrectCeoRequest,
  ModelChoice,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post, put } from '../client.ts';
import { ceoKey } from './ceo.ts';

/**
 * The CEO conversation as a full session (docs/design/ceo-front-door.md section 5): its state (model, queue, permission and
 * confirmation cards, corrections). While a reply is being written the state is refetched every few seconds, because a
 * permission question or a confirmation can appear mid-turn.
 */
export function useCeoChatState(threadId: string | undefined, enabled: boolean, busy: boolean) {
  return useQuery({
    queryKey: [...ceoKey, 'chat-state', threadId ?? null],
    enabled: enabled && !!threadId,
    refetchInterval: busy ? 3000 : 20_000,
    queryFn: () => get<CeoChatStateDto>('/ceo/chat/state'),
  });
}

function useChatStateMutation<V, R>(fn: (v: V) => Promise<R>, extra: string[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [...ceoKey, 'chat-state'] });
      void qc.invalidateQueries({ queryKey: ceoKey });
      for (const key of extra) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

/** The conversation's model (null: back to the default). */
export const useSetThreadModel = () =>
  useChatStateMutation((choice: ModelChoice | null) => put<{ ok: true }>('/ceo/chat/model', { choice }));

export const useDecideQueuedTurn = () =>
  useChatStateMutation((v: { turnId: string; decision: 'send' | 'drop' }) =>
    post(`/ceo/queue/${v.turnId}`, { decision: v.decision }),
  );

/** Authorize this execution (Owner or Admin): once, for the turn, or deny. */
export const useAnswerPermission = () =>
  useChatStateMutation(
    (v: { askId: string; decision: 'once' | 'turn' | 'deny' }) =>
      post(`/ceo/permissions/${v.askId}`, { decision: v.decision }),
    ['desk'],
  );

export const useConfirmTurn = () =>
  useChatStateMutation(
    (v: { turnId: string; actionId: string; approve: boolean }) =>
      post(`/ceo/turns/${v.turnId}/confirm`, { actionId: v.actionId, approve: v.approve }),
    ['desk', 'board', 'card', 'agents'],
  );

export const useCorrectCeo = () =>
  useChatStateMutation(
    (b: Partial<CorrectCeoRequest> & { text: string }) =>
      post<{
        correctionId: string;
        memoryId: string | null;
        message: string;
        remedyResult: string | null;
      }>('/ceo/corrections', b),
    ['desk', 'board', 'card', 'agents'],
  );

export const useEditCorrection = () =>
  useChatStateMutation((v: { id: string; rule: string }) =>
    patch(`/ceo/corrections/${v.id}`, { rule: v.rule }),
  );

export function useCeoOrderTurns(enabled = true) {
  return useQuery({
    queryKey: [...ceoKey, 'order-turns'],
    enabled,
    queryFn: () => get<{ turns: CeoOrderTurnDto[] }>('/ceo/order-turns'),
  });
}

export function useCeoRepeats(enabled = true) {
  return useQuery({
    queryKey: [...ceoKey, 'repeats'],
    enabled,
    queryFn: () => get<{ repeats: CeoRepeatDto[] }>('/ceo/repeats'),
  });
}

export const useResolveRepeat = () =>
  useChatStateMutation((v: { id: string; decision: 'dismissed' | 'feature' | 'skill' | 'automation' }) =>
    post(`/ceo/repeats/${v.id}/resolve`, { decision: v.decision }),
  );

/** Redo the corrected call (the Owner approved that exact call when he corrected the CEO). */
export const useCeoRedo = () =>
  useChatStateMutation(
    (correctionId: string) => post<{ message: string }>(`/ceo/corrections/${correctionId}/redo`, {}),
    ['desk', 'board', 'card', 'agents'],
  );
