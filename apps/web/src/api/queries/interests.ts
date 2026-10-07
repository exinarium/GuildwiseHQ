import {
  type CreateInterestRequest,
  type DigestItemDto,
  type EligibleAgentsResponse,
  type InterestDeliveriesResponse,
  type InterestDetailResponse,
  InterestDetailResponseSchema,
  type InterestRunDetailResponse,
  type InterestRunsResponse,
  type InterestsResponse,
  InterestsResponseSchema,
  type PatchInterestRequest,
  type RunInterestRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put, qs } from '../client.ts';

export interface InterestFilter {
  status?: 'active' | 'paused' | undefined;
  archived?: boolean | undefined;
}

export function useInterests(filter: InterestFilter = {}) {
  return useQuery({
    queryKey: ['interests', filter.status ?? 'any', filter.archived ? 'archived' : 'live'],
    queryFn: () =>
      get<InterestsResponse>(
        `/interests${qs({ status: filter.status, archived: filter.archived ? 'true' : undefined })}`,
        InterestsResponseSchema,
      ),
  });
}

export function useInterest(id: string | undefined) {
  return useQuery({
    queryKey: ['interest', id],
    enabled: !!id,
    queryFn: () => get<InterestDetailResponse>(`/interests/${id}`, InterestDetailResponseSchema),
  });
}

/** One page of the run log (newest first); `before` continues it. */
export function useInterestRuns(id: string | undefined, limit = 20) {
  return useQuery({
    queryKey: ['interest-runs', id, limit],
    enabled: !!id,
    queryFn: () => get<InterestRunsResponse>(`/interests/${id}/runs${qs({ limit })}`),
  });
}

export function useInterestRun(id: string, runId: string | null) {
  return useQuery({
    queryKey: ['interest-run', id, runId],
    enabled: !!runId,
    queryFn: () => get<InterestRunDetailResponse>(`/interests/${id}/runs/${runId}`),
  });
}

export function useInterestDeliveries(id: string | undefined) {
  return useQuery({
    queryKey: ['interest-deliveries', id],
    enabled: !!id,
    queryFn: () => get<InterestDeliveriesResponse>(`/interests/${id}/deliveries`),
  });
}

/** The interest's running list (what deliveries put on the desk), oldest first. */
export function useInterestDigest(id: string | undefined) {
  return useQuery({
    queryKey: ['digest', 'interest', id],
    enabled: !!id,
    queryFn: async () => (await get<{ items: DigestItemDto[] }>(`/interests/${id}/digest`)).items,
  });
}

export function useEligibleAgents(id: string | undefined) {
  return useQuery({
    queryKey: ['interest-agents', id],
    enabled: !!id,
    queryFn: () => get<EligibleAgentsResponse>(`/interests/${id}/agents/eligible`),
  });
}

function useInterestAction<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of [
        'interests',
        'interest',
        'interest-runs',
        'interest-run',
        'interest-deliveries',
        'interest-agents',
        'schedules',
        'projects',
        'card',
        'desk',
        'digest',
        'reporting',
      ])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const useCreateInterest = () =>
  useInterestAction((b: CreateInterestRequest) => post<{ id: string }>('/interests', b));
export const usePatchInterest = () =>
  useInterestAction((v: { id: string; body: PatchInterestRequest }) => patch(`/interests/${v.id}`, v.body));
export const useArchiveInterest = () =>
  useInterestAction((id: string) => post(`/interests/${id}/archive`, {}));
export const useRestoreInterest = () =>
  useInterestAction((id: string) => post(`/interests/${id}/restore`, {}));
export const useDeleteInterest = () =>
  useInterestAction((v: { id: string; confirmSlug: string }) =>
    del(`/interests/${v.id}${qs({ confirmSlug: v.confirmSlug })}`),
  );
/** "Run now" (a scan) and "Research this". */
export const useRunInterest = () =>
  useInterestAction((v: { id: string; body?: RunInterestRequest }) =>
    post<{ runId: string; cardId: string; ref: string }>(`/interests/${v.id}/run`, v.body ?? {}),
  );
export const useDeliverInterest = () =>
  useInterestAction((id: string) =>
    post<{ delivered: number; heldBack: number }>(`/interests/${id}/deliver`, {}),
  );
export const useSaveInterestTaste = () =>
  useInterestAction((v: { id: string; rules: string[] }) =>
    put(`/interests/${v.id}/taste`, { rules: v.rules }),
  );
export const useResyncInterestTaste = () =>
  useInterestAction((id: string) => post(`/interests/${id}/taste/resync`, {}));
export const useShareInterest = () =>
  useInterestAction((v: { id: string; userId: string }) =>
    post(`/interests/${v.id}/members`, { userId: v.userId }),
  );
export const useUnshareInterest = () =>
  useInterestAction((v: { id: string; userId: string }) => del(`/interests/${v.id}/members/${v.userId}`));
