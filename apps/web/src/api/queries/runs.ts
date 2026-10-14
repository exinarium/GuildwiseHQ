import {
  type ExtendRunRequest,
  isLiveRunState,
  type RestartRunRequest,
  type RunEnvironmentDto,
  RunEnvironmentResponseSchema,
  RunEnvironmentsResponseSchema,
  type RunSettingsResponse,
  RunSettingsResponseSchema,
  type SetRunSettingsRequest,
  type StartRunRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put, qs } from '../client.ts';

export interface RunsFilter {
  projectId?: string;
  cardId?: string;
  workstationId?: string;
  /** Only environments that still run (default). */
  live?: boolean;
}

/**
 * Run environments (backlog #58). The server pushes `run.changed` over the socket when the runner reports; the poll is
 * the fallback while one is moving (starting, stopping) or has an expiry to show.
 */
export function useRuns(filter: RunsFilter, opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: ['runs', filter],
    queryFn: async () =>
      (
        await get(
          `/runs${qs({
            projectId: filter.projectId,
            cardId: filter.cardId,
            workstationId: filter.workstationId,
            live: filter.live === false ? 'false' : undefined,
          })}`,
          RunEnvironmentsResponseSchema,
        )
      ).environments ?? [],
    refetchInterval: (q) => (q.state.data?.some((e) => isLiveRunState(e.state)) ? 10_000 : false),
  });
}

export function useRun(id: string | undefined) {
  return useQuery({
    enabled: !!id,
    queryKey: ['runs', 'one', id],
    queryFn: async () => (await get(`/runs/${id}`, RunEnvironmentResponseSchema)).environment,
    refetchInterval: (q) => (q.state.data && isLiveRunState(q.state.data.state) ? 10_000 : false),
  });
}

function useRunAction<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['runs'] }),
  });
}

export const useStartRun = () =>
  useRunAction(
    async (v: StartRunRequest) => (await post<{ environment: RunEnvironmentDto }>('/runs', v)).environment,
  );
export const useStopRun = () => useRunAction((id: string) => post(`/runs/${id}/stop`, {}));
export const useExtendRun = () =>
  useRunAction((v: { id: string } & ExtendRunRequest) =>
    post(`/runs/${v.id}/extend`, v.hours ? { hours: v.hours } : {}),
  );

/** Restart (same commit) or Update & restart (`update`): also revives a manual environment stopped less than a day ago. */
export const useRestartRun = () =>
  useRunAction((v: { id: string } & RestartRunRequest) =>
    post(`/runs/${v.id}/restart`, v.update ? { update: true } : {}),
  );

export function useRunSettings(projectId: string | undefined) {
  return useQuery({
    enabled: !!projectId,
    queryKey: ['run-settings', projectId],
    queryFn: async (): Promise<RunSettingsResponse> => {
      const d = await get<Partial<RunSettingsResponse>>(
        `/projects/${projectId}/run-settings`,
        RunSettingsResponseSchema,
      );
      // tolerate an older server that does not answer yet
      return {
        runInstructions: d.runInstructions ?? '',
        repos: d.repos ?? [],
        settings: {
          ttlHours: d.settings?.ttlHours ?? 8,
          allowDocker: d.settings?.allowDocker ?? false,
          services: d.settings?.services ?? [],
        },
        plans: d.plans ?? [],
      };
    },
  });
}

export function useSaveRunSettings(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: SetRunSettingsRequest) =>
      put<RunSettingsResponse>(`/projects/${projectId}/run-settings`, v, RunSettingsResponseSchema),
    onSuccess: (data) => {
      qc.setQueryData(['run-settings', projectId], data);
      qc.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
}
