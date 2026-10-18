import {
  type ApplyRecommendationResponse,
  type DismissAllRecommendationsRequest,
  type DismissRecommendationResponse,
  HrBoardResponseSchema,
  MetricsResponseSchema,
  type PatchAgentRequest,
  type ResetRoleResponse,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post, qs } from '../client.ts';

/** The HR board: agents with stats against the role average, work quality, recommendations, role updates. */
export function useHrBoard(projectId?: string, department?: string) {
  return useQuery({
    queryKey: ['hr', 'board', projectId ?? 'all', department ?? 'any'],
    queryFn: () => get(`/hr/board${qs({ projectId, department })}`, HrBoardResponseSchema),
  });
}

export function useMetrics(projectId?: string, days = 30) {
  return useQuery({
    queryKey: ['metrics', projectId ?? 'all', days],
    queryFn: () => {
      // No `to`: the range ends at the server's now (its clock may differ from the browser's).
      const from = new Date(Date.now() - (days + 1) * 86_400_000);
      return get(`/metrics${qs({ projectId, from: from.toISOString() })}`, MetricsResponseSchema);
    },
  });
}

function useHrMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of ['hr', 'agents', 'desk', 'roles', 'board', 'card', 'metrics'])
        void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const useApplyRecommendation = () =>
  useHrMutation((id: string) =>
    post<ApplyRecommendationResponse>(`/hr/recommendations/${encodeURIComponent(id)}/apply`),
  );

export const useDismissRecommendation = () =>
  useHrMutation((v: { id: string; reason?: string }) =>
    post<DismissRecommendationResponse>(`/hr/recommendations/${encodeURIComponent(v.id)}/dismiss`, {
      ...(v.reason?.trim() ? { reason: v.reason.trim() } : {}),
    }),
  );

export const useDismissAllRecommendations = () =>
  useHrMutation((v: DismissAllRecommendationsRequest) =>
    post<DismissRecommendationResponse>('/hr/recommendations/dismiss-all', v),
  );

export const usePatchAgent = () =>
  useHrMutation((v: { id: string; changes: PatchAgentRequest }) => patch(`/agents/${v.id}`, v.changes));

export const useResetRole = () =>
  useHrMutation((roleKey: string) => post<ResetRoleResponse>(`/hr/roles/${roleKey}/reset`));
