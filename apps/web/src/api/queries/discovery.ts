import type {
  AnswerQuestionRequest,
  CreateDiscoveryRequest,
  DiscoveryPhase,
  DiscoveryStateDto,
  PanelSection,
  PatchDiscoveryRequest,
  ResolveDiscoveryProposalRequest,
  SessionDto,
  SessionTimeAction,
  ThreadMessageDto,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../client.ts';

/** Discovery sessions of the active organization the user takes part in, newest first. */
export function useDiscoverySessions() {
  return useQuery({
    queryKey: ['sessions', 'discovery'],
    queryFn: async () => (await get<{ sessions: SessionDto[] }>('/sessions?kind=discovery')).sessions,
  });
}

/** Everything the session page shows besides the messages. Kept fresh by `discovery.updated` over the socket. */
export function useDiscovery(id: string | undefined) {
  return useQuery({
    queryKey: ['discovery', id],
    enabled: !!id,
    queryFn: async () => (await get<{ state: DiscoveryStateDto }>(`/discovery/${id}`)).state,
  });
}

type StateResponse = { state: DiscoveryStateDto };

/** A mutation on one session: the response is the fresh state, which replaces the cached one. */
function useSessionAction<V>(id: string, run: (v: V) => Promise<StateResponse>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (r) => {
      qc.setQueryData(['discovery', id], r.state);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useCreateDiscovery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: CreateDiscoveryRequest) => (await post<StateResponse>('/discovery', b)).state,
    onSuccess: (state) => {
      qc.setQueryData(['discovery', state.threadId], state);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export const useAnswerQuestion = (id: string) =>
  useSessionAction(id, (v: { questionId: string; body: AnswerQuestionRequest }) =>
    post<StateResponse>(`/discovery/${id}/questions/${v.questionId}/answer`, v.body),
  );

/** The owner writes to the facilitator (`say`): the message appears in the thread, the facilitator replies. */
export function useSay(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      post<{ message: ThreadMessageDto; state: DiscoveryStateDto }>(`/discovery/${id}/say`, { body }),
    onSuccess: (r) => {
      qc.setQueryData(['discovery', id], r.state);
      void qc.invalidateQueries({ queryKey: ['thread', id] });
    },
  });
}

export const useAddNote = (id: string) =>
  useSessionAction(id, (v: { section: PanelSection; text: string }) =>
    post<StateResponse>(`/discovery/${id}/notes`, v),
  );
export const usePatchNote = (id: string) =>
  useSessionAction(id, (v: { noteId: string; section?: PanelSection; text?: string }) =>
    patch<StateResponse>(`/discovery/${id}/notes/${v.noteId}`, {
      ...(v.section ? { section: v.section } : {}),
      ...(v.text ? { text: v.text } : {}),
    }),
  );
export const useRemoveNote = (id: string) =>
  useSessionAction(id, (noteId: string) => del<StateResponse>(`/discovery/${id}/notes/${noteId}`));

export const useResolveProposal = (id: string) =>
  useSessionAction(id, (v: { proposalId: string; body: ResolveDiscoveryProposalRequest }) =>
    post<StateResponse>(`/discovery/${id}/proposals/${v.proposalId}/resolve`, v.body),
  );

export const useSetPhase = (id: string) =>
  useSessionAction(id, (phase: DiscoveryPhase) => post<StateResponse>(`/discovery/${id}/phase`, { phase }));
export const usePauseDiscovery = (id: string) =>
  useSessionAction(id, (_: void) => post<StateResponse>(`/discovery/${id}/pause`, {}));
export const useResumeDiscovery = (id: string) =>
  useSessionAction(id, (_: void) => post<StateResponse>(`/discovery/${id}/resume`, {}));
export const useContinueDiscovery = (id: string) =>
  useSessionAction(id, (_: void) => post<StateResponse>(`/discovery/${id}/continue`, {}));
export const usePatchDiscovery = (id: string) =>
  useSessionAction(id, (b: PatchDiscoveryRequest) => patch<StateResponse>(`/discovery/${id}`, b));
export const useRequestDraft = (id: string) =>
  useSessionAction(id, (kind: 'brief' | 'prd') => post<StateResponse>(`/discovery/${id}/draft`, { kind }));
export const useRequestValidation = (id: string) =>
  useSessionAction(id, (_: void) => post<StateResponse>(`/discovery/${id}/validate`, {}));

/** The creator's answer to "time is up": extend, or wrap up (capture). */
export const useDiscoveryTime = (id: string) =>
  useSessionAction(id, (b: SessionTimeAction) => post<StateResponse>(`/discovery/${id}/time`, b));

/** "Hand to BA": an approved PRD becomes an intake, or (no BA online) the hand-off is queued. */
export function useHandToBa(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (_: void) =>
      post<{ intakeId: string | null; queued?: boolean; state: DiscoveryStateDto }>(
        `/discovery/${id}/hand-to-ba`,
        {},
      ),
    onSuccess: (r) => {
      qc.setQueryData(['discovery', id], r.state);
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['intakes'] });
    },
  });
}
