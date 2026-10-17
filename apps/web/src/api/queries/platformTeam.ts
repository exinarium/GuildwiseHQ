import type {
  PlatformBugDto,
  PlatformDeployAuditDto,
  PlatformGrantDto,
  PlatformPauseDto,
  PlatformTeamSettings,
  RunnerPinDto,
  SetRunnerPinRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../client.ts';

export interface PlatformTeamOverview {
  team: PlatformTeamSettings;
  canManage: boolean;
  bugs: PlatformBugDto[];
  pauses: PlatformPauseDto[];
  grants: PlatformGrantDto[];
  pins: RunnerPinDto[];
  audit: PlatformDeployAuditDto[];
}

/** The designation (super admin). */
export function usePlatformTeamSettings() {
  return useQuery({
    queryKey: ['platform', 'team'],
    queryFn: () => get<PlatformTeamSettings>('/platform/team'),
  });
}

export function useSetPlatformTeam() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { orgId: string | null; projectId?: string | null }) =>
      put<PlatformTeamSettings>('/platform/team', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['platform'] }),
  });
}

/** Everything the platform page lists. 404 (no team, or not a member) leaves `data` empty and `error` set. */
export function usePlatformTeamOverview(enabled = true) {
  return useQuery({
    queryKey: ['platform', 'team-overview'],
    queryFn: () => get<PlatformTeamOverview>('/platform-team/overview'),
    enabled,
    retry: false,
    refetchInterval: 15_000,
  });
}

const refresh = (qc: ReturnType<typeof useQueryClient>) => {
  void qc.invalidateQueries({ queryKey: ['platform'] });
  void qc.invalidateQueries({ queryKey: ['platform-team'] });
  void qc.invalidateQueries({ queryKey: ['workstations'] });
};

export function useCreatePlatformPause() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      projectId?: string | null;
      workflowKey?: string | null;
      stageId?: string | null;
      workstationId?: string | null;
      reason: string;
    }) => post('/platform-team/pauses', body),
    onSuccess: () => refresh(qc),
  });
}

export function useResumePlatformPause() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/platform-team/pauses/${id}/resume`, {}),
    onSuccess: () => refresh(qc),
  });
}

export function useSetRunnerPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetRunnerPinRequest) => put<{ notified: number }>('/platform-team/runner-pin', body),
    onSuccess: () => refresh(qc),
  });
}

export function useRevokeGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/platform-team/grants/${id}/revoke`, {}),
    onSuccess: () => refresh(qc),
  });
}

/** The open pauses that touch the signed-in user (banner on their projects, badge on their workstations). */
export function useMyPlatformPauses() {
  return useQuery({
    queryKey: ['platform-team', 'my-pauses'],
    queryFn: async (): Promise<PlatformPauseDto[]> =>
      (await get<{ pauses: PlatformPauseDto[] }>('/platform-team/my-pauses')).pauses,
    refetchInterval: 30_000,
    retry: false,
  });
}
