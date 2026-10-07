import {
  type CostSettings,
  type CostsQuery,
  type CostsReport,
  CostsReportSchema,
  OrgChartSchema,
  type UpdateCostSettingsRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put, qs } from '../client.ts';

/** The org-level cost breakdown (Owner and Admin). */
export function useCosts(q: CostsQuery) {
  return useQuery({
    queryKey: ['costs', q.from ?? '', q.to ?? '', q.projectId ?? ''],
    queryFn: () => get(`/costs${qs({ ...q })}`, CostsReportSchema) as Promise<CostsReport>,
  });
}

/** The export link of the same range (the browser downloads it with the session cookie). */
export const costsCsvUrl = (q: CostsQuery): string => `/api/costs/export.csv${qs({ ...q })}`;

export function useCostSettings() {
  return useQuery({ queryKey: ['costs', 'settings'], queryFn: () => get<CostSettings>('/costs/settings') });
}

const KEYS = [
  'costs',
  'projects',
  'project',
  'interests',
  'interest',
  'desk',
  'hr',
  'board',
  'phase',
  'phases',
];
function useBudgetMutation<V>(fn: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const key of KEYS) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export function useUpdateCostSettings() {
  return useBudgetMutation((v: UpdateCostSettingsRequest) => put('/costs/settings', v));
}

/** A budget of a project (`kind: 'projects'`) or of an interest's backing project (`kind: 'interests'`). */
export function useSetBudget(kind: 'projects' | 'interests', id: string) {
  return useBudgetMutation((monthly: number | null) => put(`/${kind}/${id}/budget`, { monthly }));
}
export function useOverrideBudget(kind: 'projects' | 'interests', id: string) {
  return useBudgetMutation(() => post(`/${kind}/${id}/budget/override`, {}));
}

/** The organization chart: agents, the escalation lines and the reporting line (members of the organization). */
export function useOrgChart() {
  return useQuery({
    queryKey: ['org-chart'],
    queryFn: () => get('/org-chart', OrgChartSchema),
  });
}
