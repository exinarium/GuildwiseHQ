import {
  type CreateScheduleRequest,
  type PatchScheduleRequest,
  type RunScheduleResponse,
  type ScheduleDto,
  SchedulesResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, qs } from '../client.ts';

export const schedulesKey = ['schedules'] as const;

export function useSchedules(projectId?: string) {
  return useQuery({
    queryKey: [...schedulesKey, projectId ?? 'all'],
    queryFn: async () => (await get(`/schedules${qs({ projectId })}`, SchedulesResponseSchema)).schedules,
  });
}

function useScheduleAction<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ['schedules', 'board', 'card', 'desk'])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const useCreateSchedule = () =>
  useScheduleAction(
    (
      b: Partial<CreateScheduleRequest> & Pick<CreateScheduleRequest, 'projectId' | 'name' | 'cardTemplate'>,
    ) => post<ScheduleDto>('/schedules', b),
  );
export const usePatchSchedule = () =>
  useScheduleAction((v: { id: string; body: PatchScheduleRequest }) =>
    patch<ScheduleDto>(`/schedules/${v.id}`, v.body),
  );
export const useDeleteSchedule = () => useScheduleAction((id: string) => del(`/schedules/${id}`));
export const useRunSchedule = () =>
  useScheduleAction((id: string) => post<RunScheduleResponse>(`/schedules/${id}/run`, {}));
/** "Run now" on a feed project: uses its schedule's template, or a default one. */
export const useRunFeed = () =>
  useScheduleAction((projectId: string) => post<RunScheduleResponse>(`/projects/${projectId}/feed/run`, {}));
