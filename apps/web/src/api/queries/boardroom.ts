import type {
  BoardRoom,
  BoardStateDto,
  CapabilitiesResponse,
  CreateBoardRequest,
  PatchBoardRequest,
  SaveBoardRoomRequest,
  SessionDto,
  SessionTimeAction,
  StartBoardRequest,
  StickyColumn,
  SuggestCastRequest,
  ThreadMessageDto,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post } from '../client.ts';

/** Boardroom sessions of the active organization the user takes part in, newest first. */
export function useBoardSessions() {
  return useQuery({
    queryKey: ['sessions', 'boardroom'],
    queryFn: async () => (await get<{ sessions: SessionDto[] }>('/sessions?kind=boardroom')).sessions,
  });
}

/**
 * Everything the boardroom page shows besides the messages. The key starts with `['discovery', id]` so the socket's
 * `discovery.updated` (sent for boardrooms too) refetches it.
 */
export function useBoard(id: string | undefined) {
  return useQuery({
    queryKey: ['discovery', id, 'board'],
    enabled: !!id,
    queryFn: async () => (await get<{ state: BoardStateDto }>(`/board/${id}`)).state,
  });
}

type StateResponse = { state: BoardStateDto };

/** A mutation on one boardroom: the response is the fresh state, which replaces the cached one. */
function useBoardAction<V>(id: string, run: (v: V) => Promise<StateResponse>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (r) => {
      qc.setQueryData(['discovery', id, 'board'], r.state);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export function useCreateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: CreateBoardRequest) => (await post<StateResponse>('/board', b)).state,
    onSuccess: (state) => {
      qc.setQueryData(['discovery', state.threadId, 'board'], state);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

/** "Suggest a cast": creates a session in setup whose Chair proposes voices; the dialog follows it with `useBoard`. */
export function useSuggestCast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: SuggestCastRequest) => (await post<StateResponse>('/board/suggest', b)).state,
    onSuccess: (state) => {
      qc.setQueryData(['discovery', state.threadId, 'board'], state);
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

export const useStartBoard = (id: string) =>
  useBoardAction(id, (b: StartBoardRequest) => post<StateResponse>(`/board/${id}/start`, b));

/** The owner writes in the room; anyone @mentioned speaks next. */
export function useBoardSay(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) =>
      post<{ message: ThreadMessageDto; mentioned: string[]; state: BoardStateDto }>(`/board/${id}/say`, {
        body,
      }),
    onSuccess: (r) => {
      qc.setQueryData(['discovery', id, 'board'], r.state);
      void qc.invalidateQueries({ queryKey: ['thread', id] });
    },
  });
}

export const usePauseBoard = (id: string) =>
  useBoardAction(id, (_: void) => post<StateResponse>(`/board/${id}/pause`, {}));
export const useResumeBoard = (id: string) =>
  useBoardAction(id, (_: void) => post<StateResponse>(`/board/${id}/resume`, {}));
export const useContinueBoard = (id: string) =>
  useBoardAction(id, (_: void) => post<StateResponse>(`/board/${id}/continue`, {}));
export const useEndBoard = (id: string) =>
  useBoardAction(id, (_: void) => post<StateResponse>(`/board/${id}/end`, {}));
export const usePatchBoard = (id: string) =>
  useBoardAction(id, (b: PatchBoardRequest) => patch<StateResponse>(`/board/${id}`, b));
/** The creator's answer to "time is up": extend, or wrap up (write the minutes). */
export const useBoardTime = (id: string) =>
  useBoardAction(id, (b: SessionTimeAction) => post<StateResponse>(`/board/${id}/time`, b));
/** The budget ran out before the Chair's summary: write the minutes without it. */
export const useMinutesChoice = (id: string) =>
  useBoardAction(id, (_: void) =>
    post<StateResponse>(`/board/${id}/minutes-choice`, { choice: 'without_summary' }),
  );
export const useWriteMinutes = (id: string) =>
  useBoardAction(id, (_: void) => post<StateResponse>(`/board/${id}/minutes`, {}));
export const useResolveDecision = (id: string) =>
  useBoardAction(id, (v: { decisionId: string; answer: string; optionId?: string }) =>
    post<StateResponse>(`/board/${id}/decisions/${v.decisionId}/resolve`, {
      answer: v.answer,
      ...(v.optionId ? { optionId: v.optionId } : {}),
    }),
  );

export const useAddBoardNote = (id: string) =>
  useBoardAction(id, (v: { column: StickyColumn; text: string }) =>
    post<StateResponse>(`/board/${id}/notes`, v),
  );
export const usePatchBoardNote = (id: string) =>
  useBoardAction(id, (v: { noteId: string; column?: StickyColumn; text?: string }) =>
    patch<StateResponse>(`/board/${id}/notes/${v.noteId}`, {
      ...(v.column ? { column: v.column } : {}),
      ...(v.text ? { text: v.text } : {}),
    }),
  );
export const useRemoveBoardNote = (id: string) =>
  useBoardAction(id, (noteId: string) => del<StateResponse>(`/board/${id}/notes/${noteId}`));
export const useVoteBoardNote = (id: string) =>
  useBoardAction(id, (noteId: string) => post<StateResponse>(`/board/${id}/notes/${noteId}/vote`, {}));
export const useMergeBoardNotes = (id: string) =>
  useBoardAction(id, (v: { noteIds: string[]; text?: string }) =>
    post<StateResponse>(`/board/${id}/notes/merge`, v),
  );

/** "Pull into PRD": a Discovery session in the capture phase, seeded from the minutes. */
export function usePullIntoPrd(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (_: void) =>
      post<{ discoveryId: string; docId: string; state: BoardStateDto }>(`/board/${id}/pull-into-prd`, {}),
    onSuccess: (r) => {
      qc.setQueryData(['discovery', id, 'board'], r.state);
      void qc.invalidateQueries({ queryKey: ['documents'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

/** Saved casts ("rooms") of the organization. */
export function useBoardRooms(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['board-rooms'],
    queryFn: async () => (await get<{ rooms: BoardRoom[] }>('/board-rooms')).rooms,
  });
}
export function useSaveBoardRoom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (b: SaveBoardRoomRequest) => (await post<{ room: BoardRoom }>('/board-rooms', b)).room,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board-rooms'] }),
  });
}
export function useDeleteBoardRoom() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del(`/board-rooms/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['board-rooms'] }),
  });
}

/** The library personas (and organization-vault ones) a cast can draw from. */
export function usePersonas(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['capabilities', 'persona'],
    staleTime: 300_000,
    // personas of a pack that is not approved (or whose files changed) are never offered for a seat
    queryFn: async () =>
      (await get<CapabilitiesResponse>('/capabilities?kind=persona&usable=true')).items.filter(
        (i) => i.usable !== false,
      ),
  });
}
