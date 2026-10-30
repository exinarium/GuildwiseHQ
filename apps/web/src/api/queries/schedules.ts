import {
  type CreateScheduleRequest,
  type CreateScheduleResponse,
  CreateScheduleResponseSchema,
  type PatchScheduleRequest,
  RotateSecretResponseSchema,
  type RunScheduleResponse,
  type ScheduleDto,
  ScheduleRunsResponseSchema,
  SchedulesResponseSchema,
  type ScheduleTestResponse,
  ScheduleTestResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, qs } from '../client.ts';

export const schedulesKey = ['schedules'] as const;

/** The schedules the viewer may see, and the read-only system jobs (hygiene, the BA floor report). */
export function useScheduleList(projectId?: string) {
  return useQuery({
    queryKey: [...schedulesKey, projectId ?? 'all'],
    queryFn: () => get(`/schedules${qs({ projectId })}`, SchedulesResponseSchema),
  });
}

export function useSchedules(projectId?: string) {
  const q = useScheduleList(projectId);
  return { ...q, data: q.data?.schedules } as Omit<typeof q, 'data'> & { data: ScheduleDto[] | undefined };
}

/** The run history of a schedule (newest first), with the delivery log of each run. */
export function useScheduleRuns(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: [...schedulesKey, 'runs', id],
    queryFn: async () => (await get(`/schedules/${id}/runs`, ScheduleRunsResponseSchema)).runs,
    enabled: enabled && !!id,
    refetchInterval: 5000,
  });
}

function useScheduleAction<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ['schedules', 'board', 'card', 'desk', 'intakes'])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const useCreateSchedule = () =>
  useScheduleAction((b: CreateScheduleRequest) =>
    post<CreateScheduleResponse>('/schedules', b, CreateScheduleResponseSchema),
  );
export const usePatchSchedule = () =>
  useScheduleAction((v: { id: string; body: PatchScheduleRequest }) =>
    patch<CreateScheduleResponse>(`/schedules/${v.id}`, v.body),
  );
export const useDeleteSchedule = () => useScheduleAction((id: string) => del(`/schedules/${id}`));
export const useRunSchedule = () =>
  useScheduleAction((id: string) => post<RunScheduleResponse>(`/schedules/${id}/run`, {}));
export const useTestSchedule = () =>
  useScheduleAction((id: string) =>
    post<ScheduleTestResponse>(`/schedules/${id}/test`, {}, ScheduleTestResponseSchema),
  );
export const useRotateSecret = () =>
  useScheduleAction((id: string) =>
    post<{ webhookSecret: string; hookUrlWithSecret?: string | undefined }>(
      `/schedules/${id}/rotate-secret`,
      {},
      RotateSecretResponseSchema,
    ),
  );
export const useRevokeSecret = () =>
  useScheduleAction((id: string) => post<ScheduleDto>(`/schedules/${id}/revoke-secret`, {}));
