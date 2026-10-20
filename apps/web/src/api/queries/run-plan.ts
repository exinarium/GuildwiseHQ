import {
  type ProposalDto,
  type RunEnvironmentDto,
  type RunPlanOverview,
  RunPlanOverviewSchema,
  type SaveRunPlanRequest,
  type SetupScanRequest,
  type TestRunPlanRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../client.ts';

/**
 * The project's run steps as the guided editor sees them (docs/design/deploy-run-ux-design.md section 3.1): the
 * project-wide plan, the workstations' own plans, a running scan and the proposal that waits for a decision.
 * The server pushes the changes over the socket; the poll is the fallback while a scan is running.
 */
export function useRunPlanOverview(projectId: string | undefined) {
  return useQuery({
    enabled: !!projectId,
    queryKey: ['run-plan', projectId],
    queryFn: async (): Promise<RunPlanOverview> => {
      const d = await get<Partial<RunPlanOverview>>(`/projects/${projectId}/run-plan`, RunPlanOverviewSchema);
      // tolerate an older server that does not answer yet
      return {
        canEdit: d.canEdit ?? false,
        repos: d.repos ?? [],
        workstations: d.workstations ?? [],
        projectPlan: d.projectPlan ?? null,
        workstationPlans: d.workstationPlans ?? [],
        scan: d.scan ?? null,
        scanProblem: d.scanProblem ?? null,
        proposal: d.proposal ?? null,
        lastStart: d.lastStart ?? null,
      };
    },
    refetchInterval: (q) => (q.state.data?.scan ? 10_000 : false),
  });
}

export function useSaveRunPlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: SaveRunPlanRequest) =>
      put<RunPlanOverview>(`/projects/${projectId}/run-plan`, v, RunPlanOverviewSchema),
    onSuccess: (data) => {
      qc.setQueryData(['run-plan', projectId], data);
      qc.invalidateQueries({ queryKey: ['run-settings', projectId] });
    },
  });
}

/** "Use the project version here": drops a workstation's own plan. */
export function useDiscardWorkstationPlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (planId: string) => del<RunPlanOverview>(`/projects/${projectId}/run-plan/${planId}`),
    onSuccess: (data) => {
      qc.setQueryData(['run-plan', projectId], data);
      qc.invalidateQueries({ queryKey: ['run-settings', projectId] });
    },
  });
}

/** "Test these steps": starts the app once from the plan on a workstation. */
export function useTestRunPlan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: TestRunPlanRequest) =>
      (await post<{ environment: RunEnvironmentDto }>(`/projects/${projectId}/run-plan/test`, v)).environment,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['runs'] });
      qc.invalidateQueries({ queryKey: ['run-plan', projectId] });
    },
  });
}

/** "Scan with DevOps". */
export function useStartScan(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: SetupScanRequest) => post<{ requestId: string }>(`/projects/${projectId}/scan`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run-plan', projectId] }),
  });
}

export function useDismissProposal(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: ProposalDto) =>
      post(`/setup-proposals/${p.id}/resolve`, { outcome: 'dismissed' as const }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['run-plan', projectId] }),
  });
}
