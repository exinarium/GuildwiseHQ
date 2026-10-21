import type {
  ProbeRequest,
  PublishSetupRequest,
  SaveSetupDraftRequest,
  SetupPreviewDto,
  SetupScanRequest,
  SetupStateDto,
} from '@aom/shared';
import { SETUP_GENERATOR } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../client.ts';

/**
 * The guided deploy setup (docs/design/deploy-run-ux-design.md sections 3.2 and 7.3): the state of the wizard (draft, what
 * `delivery/` holds, probes, reachability, a running scan), previews of the generated files and the publish. The server
 * pushes changes over the socket (`deploy-setup` is invalidated by project events); the poll covers a command in flight.
 */
export const setupKey = (projectId: string) => ['deploy-setup', projectId] as const;

export function useSetupState(projectId: string | undefined, waiting = false) {
  return useQuery({
    enabled: !!projectId,
    queryKey: setupKey(projectId ?? ''),
    queryFn: async (): Promise<SetupStateDto> => {
      const d = await get<Partial<SetupStateDto>>(`/projects/${projectId}/delivery/setup`);
      // tolerate an older server that does not answer yet
      return {
        canEdit: d.canEdit ?? false,
        canApprove: d.canApprove ?? false,
        draft: d.draft ?? null,
        current: d.current ?? {
          setup: null,
          handEdited: [],
          recipePresent: false,
          recipeStatus: null,
          observedHash: null,
          approvedHash: null,
          lint: [],
          dryRunOk: [],
          dryRunMissing: [],
          custom: false,
        },
        publish: d.publish ?? null,
        targets: d.targets ?? [],
        workstations: d.workstations ?? [],
        probes: d.probes ?? [],
        writeBlocked: d.writeBlocked ?? null,
        scan: d.scan ?? null,
        scanProblem: d.scanProblem ?? null,
        proposal: d.proposal ?? null,
        generator: d.generator ?? SETUP_GENERATOR,
        improvedAvailable: d.improvedAvailable ?? false,
        ...(d.deliveryMode ? { deliveryMode: d.deliveryMode } : {}),
        releasesPaused: d.releasesPaused ?? false,
        modeHistory: d.modeHistory ?? [],
      };
    },
    refetchInterval: (q) =>
      waiting || q.state.data?.publish?.status === 'pending' || q.state.data?.scan ? 3000 : false,
    retry: false,
  });
}

function useSetupMutation<V, R>(projectId: string, fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: setupKey(projectId) });
      void qc.invalidateQueries({ queryKey: ['delivery', projectId] });
      void qc.invalidateQueries({ queryKey: ['places', projectId] });
      void qc.invalidateQueries({ queryKey: ['env-status', projectId] });
    },
  });
}

export const useSaveSetupDraft = (projectId: string) =>
  useSetupMutation(projectId, (v: SaveSetupDraftRequest) =>
    put<SetupStateDto>(`/projects/${projectId}/delivery/setup`, v),
  );

/** Compiles the setup on the server and answers with the files, the lint and Found / Will change / Will not touch. */
export const usePreviewSetup = (projectId: string) =>
  useMutation({
    mutationFn: (v: SaveSetupDraftRequest) =>
      post<SetupPreviewDto>(`/projects/${projectId}/delivery/setup/preview`, v),
  });

export const usePublishSetup = (projectId: string) =>
  useSetupMutation(projectId, (v: PublishSetupRequest) =>
    post<{ commandId: string; hash: string }>(`/projects/${projectId}/delivery/setup/publish`, v),
  );

/** "Try it without changing anything" for one environment of the saved version. */
export const useSetupDryRun = (projectId: string) =>
  useSetupMutation(projectId, (env: string) =>
    post<{ message: string; runs: Array<{ status: string; refusal?: string; detail?: string }> }>(
      `/projects/${projectId}/delivery/setup/dry-run`,
      { env },
    ),
  );

export const useUseDeployProposal = (projectId: string) =>
  useSetupMutation(projectId, (proposalId: string) =>
    post<SetupStateDto>(`/projects/${projectId}/delivery/setup/use-proposal`, { proposalId }),
  );

/** A read-only look at this computer's Docker, the servers it can reach, or one server. */
export const useProbe = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: ProbeRequest) =>
      post<{ commandId: string; workstationId: string }>(`/projects/${projectId}/delivery/probe`, v),
    onSuccess: () => qc.invalidateQueries({ queryKey: setupKey(projectId) }),
  });
};

export const useStartDeployScan = (projectId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: Omit<SetupScanRequest, 'area'>) =>
      post<{ requestId: string }>(`/projects/${projectId}/scan`, { area: 'deploy', ...v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: setupKey(projectId) }),
  });
};
