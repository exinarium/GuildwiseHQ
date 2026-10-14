import type {
  AppointCeoRequest,
  CeoActionsResponse,
  CeoMemoryDtoApi,
  CeoPolicy,
  CeoPolicyDto,
  CeoSettings,
  CeoSettingsDto,
  CeoStatusDto,
  CeoTaskDtoApi,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put, qs } from '../client.ts';

export const ceoKey = ['ceo'] as const;

/** `GET /api/ceo/status` (Admin or Owner: fetch it only for them). A long staleTime: mutations refetch it. */
export function useCeoStatus(enabled = true) {
  return useQuery({
    queryKey: [...ceoKey, 'status'],
    enabled,
    staleTime: 60_000,
    queryFn: () => get<CeoStatusDto>('/ceo/status'),
  });
}

export function useCeoSettings(enabled = true) {
  return useQuery({
    queryKey: [...ceoKey, 'settings'],
    enabled,
    queryFn: () => get<CeoSettingsDto>('/ceo/settings'),
  });
}

export function useCeoPolicy(enabled = true) {
  return useQuery({
    queryKey: [...ceoKey, 'policy'],
    enabled,
    queryFn: () => get<CeoPolicyDto>('/ceo/policy'),
  });
}

export interface CeoActionFilters {
  class?: string;
  mode?: string;
  subject?: string;
  from?: string;
  to?: string;
}

export function useCeoActions(filters: CeoActionFilters, before?: string) {
  return useQuery({
    queryKey: [...ceoKey, 'actions', filters, before ?? null],
    queryFn: () => get<CeoActionsResponse>(`/ceo/actions${qs({ ...filters, before, limit: 50 })}`),
  });
}

export const ceoActionsCsvUrl = (filters: CeoActionFilters): string =>
  `/api/ceo/actions/export.csv${qs({ ...filters })}`;

export function useCeoMemories(enabled = true) {
  return useQuery({
    queryKey: [...ceoKey, 'memories'],
    enabled,
    queryFn: () => get<{ memories: CeoMemoryDtoApi[]; canView: boolean }>('/ceo/memories'),
  });
}

export function useCeoTasks(enabled = true) {
  return useQuery({
    queryKey: [...ceoKey, 'tasks'],
    enabled,
    queryFn: () => get<{ tasks: CeoTaskDtoApi[] }>('/ceo/tasks'),
  });
}

function useCeoMutation<V, R>(fn: (v: V) => Promise<R>, extra: string[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ceoKey });
      for (const key of extra) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const useAppointCeo = () =>
  useCeoMutation((b: AppointCeoRequest) => post('/ceo/appoint', b), ['agents', 'org-chart', 'hr', 'setup']);
export const usePauseCeo = () =>
  useCeoMutation((v: { reason?: string }) => post('/ceo/pause', v), ['org-chart']);
export const useResumeCeo = () => useCeoMutation(() => post('/ceo/resume', {}), ['org-chart']);
export const useDisableCeo = () =>
  useCeoMutation(() => post('/ceo/disable', {}), ['agents', 'org-chart', 'hr', 'setup']);
export const useMoveCeo = () =>
  useCeoMutation((v: { workstationId: string; acknowledgeUnsandboxed?: boolean }) =>
    post('/ceo/workstation', v),
  );
export const useCeoTraining = () =>
  useCeoMutation((action: 'graduate' | 'extend' | 'restart') => post('/ceo/training', { action }));
export const useSaveCeoSettings = () =>
  useCeoMutation((b: Partial<CeoSettings>) => put<CeoSettingsDto>('/ceo/settings', b));
export const useSaveCeoPolicy = () =>
  useCeoMutation((b: { policy: CeoPolicy; confirmDelegation?: boolean; note?: string }) =>
    put<CeoPolicyDto>('/ceo/policy', b),
  );
export const useResetCeoPolicy = () => useCeoMutation(() => post<CeoPolicyDto>('/ceo/policy/reset', {}));

/** Undo an action of the CEO; refreshes the desk too. */
export const useUndoCeoAction = () =>
  useCeoMutation(
    (id: string) =>
      post<{ kind: 'inverse' | 'compensating'; message: string }>(`/ceo/actions/${id}/undo`, {}),
    ['desk', 'board', 'card', 'agents'],
  );

export const useAddCeoMemory = () =>
  useCeoMutation((b: { text: string; scope: string }) => post<CeoMemoryDtoApi>('/ceo/memories', b));
export const usePatchCeoMemory = () =>
  useCeoMutation((v: { id: string; text?: string; scope?: string; confirm?: boolean }) => {
    const { id, ...body } = v;
    return patch<CeoMemoryDtoApi>(`/ceo/memories/${id}`, body);
  });
export const useConfirmCeoMemory = () =>
  useCeoMutation((id: string) => post<CeoMemoryDtoApi>(`/ceo/memories/${id}/confirm`, {}));
export const useRetireCeoMemory = () =>
  useCeoMutation((id: string) => post<CeoMemoryDtoApi>(`/ceo/memories/${id}/retire`, {}));
export const useForgetCeoMemory = () => useCeoMutation((id: string) => del(`/ceo/memories/${id}`));

export const useCreateCeoTask = () =>
  useCeoMutation((b: { title: string; request?: string }) => post<CeoTaskDtoApi>('/ceo/tasks', b));
export const usePatchCeoTask = () =>
  useCeoMutation((v: { id: string; status?: string; note?: string }) => {
    const { id, ...body } = v;
    return patch<CeoTaskDtoApi>(`/ceo/tasks/${id}`, body);
  });

/** Opens the Owner's standing chat with the CEO. */
export const useCeoChat = () =>
  useMutation({ mutationFn: () => post<{ threadId: string }>('/ceo/chat', {}) });
