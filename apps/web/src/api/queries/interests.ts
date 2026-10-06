import {
  type AdoptResponse,
  AdoptResponseSchema,
  type CreateInterestRequest,
  type DigestItemDto,
  type InterestDetailResponse,
  InterestDetailResponseSchema,
  InterestsResponseSchema,
  type PatchInterestRequest,
  type RunScheduleResponse,
  type TasteSeedLine,
  type TasteSeedResponse,
  TasteSeedResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put, qs } from '../client.ts';

export interface InterestFilter {
  projectId?: string | undefined;
  status?: 'active' | 'paused' | undefined;
}

export function useInterests(filter: InterestFilter = {}) {
  return useQuery({
    queryKey: ['interests', filter.projectId ?? 'all', filter.status ?? 'any'],
    queryFn: () => get(`/interests${qs({ ...filter })}`, InterestsResponseSchema),
  });
}

export function useInterest(id: string | undefined) {
  return useQuery({
    queryKey: ['interest', id],
    enabled: !!id,
    queryFn: () => get<InterestDetailResponse>(`/interests/${id}`, InterestDetailResponseSchema),
  });
}

function useInterestAction<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ['interests', 'interest', 'schedules', 'projects', 'board', 'card', 'digest'])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const useCreateInterest = () =>
  useInterestAction((b: CreateInterestRequest) => post<{ id: string }>('/interests', b));
export const usePatchInterest = () =>
  useInterestAction((v: { id: string; body: PatchInterestRequest }) => patch(`/interests/${v.id}`, v.body));
export const useDeleteInterest = () =>
  useInterestAction((v: { id: string; keepSchedule: boolean }) =>
    del(`/interests/${v.id}${qs({ keepSchedule: v.keepSchedule ? 'true' : 'false' })}`),
  );
export const useRunInterest = () =>
  useInterestAction((id: string) => post<RunScheduleResponse>(`/interests/${id}/run`, {}));
export const useSaveInterestTaste = () =>
  useInterestAction((v: { id: string; rules: string[] }) =>
    put(`/interests/${v.id}/taste`, { rules: v.rules }),
  );

export function useAdoptable(enabled: boolean) {
  return useQuery({
    queryKey: ['interests', 'adoptable'],
    enabled,
    queryFn: async () =>
      (
        await get<{
          schedules: Array<{
            id: string;
            name: string;
            projectKey: string;
            cron: string;
            timezone: string;
            enabled: boolean;
            topic: string | null;
          }>;
        }>('/interests/adoptable')
      ).schedules,
  });
}

export const useAdopt = () =>
  useInterestAction((scheduleIds: string[]) =>
    post<AdoptResponse>('/interests/adopt', { scheduleIds }, AdoptResponseSchema),
  );

/** The explicit taste rules of a feed project (project-wide and interest-tagged). */
export function useTasteSeed(projectId: string | undefined) {
  return useQuery({
    queryKey: ['taste', projectId],
    enabled: !!projectId,
    queryFn: () => get<TasteSeedResponse>(`/projects/${projectId}/taste-seed`, TasteSeedResponseSchema),
  });
}

export function useSaveTasteSeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { projectId: string; rules: TasteSeedLine[] }) =>
      put<TasteSeedResponse>(`/projects/${v.projectId}/taste-seed`, { rules: v.rules }),
    onSuccess: () => {
      for (const key of ['taste', 'interests', 'interest', 'digest'])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function useResyncTasteSeed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      post<TasteSeedResponse>(`/projects/${projectId}/taste-seed/resync`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['taste'] }),
  });
}

/** The running list of a feed project, limited to the scans of one interest. */
export function useInterestDigestItems(projectId: string | undefined, interestId: string | null) {
  return useQuery({
    queryKey: ['digest', 'interest', projectId, interestId],
    enabled: !!projectId && !!interestId,
    queryFn: async () =>
      (await get<{ items: DigestItemDto[] }>(`/digest-items${qs({ projectId, interestId, status: 'all' })}`))
        .items,
  });
}
