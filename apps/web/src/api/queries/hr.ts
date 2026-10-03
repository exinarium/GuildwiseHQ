import {
  type ApplyRecommendationResponse,
  HrBoardResponseSchema,
  MetricsResponseSchema,
  type PatchAgentRequest,
  type ResetRoleResponse,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post, qs } from '../client.ts';

/** The HR board: agents with stats against the role average, work quality, recommendations, role updates. */
export function useHrBoard(projectId?: string) {
  return useQuery({
    queryKey: ['hr', 'board', projectId ?? 'all'],
    queryFn: () => get(`/hr/board${qs({ projectId })}`, HrBoardResponseSchema),
  });
}

export function useMetrics(projectId?: string, days = 30) {
  return useQuery({
    queryKey: ['metrics', projectId ?? 'all', days],
    queryFn: () => {
      const to = new Date();
      const from = new Date(to.getTime() - days * 86_400_000);
      return get(
        `/metrics${qs({ projectId, from: from.toISOString(), to: to.toISOString() })}`,
        MetricsResponseSchema,
      );
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

export const usePatchAgent = () =>
  useHrMutation((v: { id: string; changes: PatchAgentRequest }) => patch(`/agents/${v.id}`, v.changes));

export const useResetRole = () =>
  useHrMutation((roleKey: string) => post<ResetRoleResponse>(`/hr/roles/${roleKey}/reset`));
