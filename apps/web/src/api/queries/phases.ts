import {
  type AssignCardPhaseRequest,
  type CardDetailResponse,
  type CreateDeployTargetRequest,
  type CreatePhaseRequest,
  type DeployTargetDto,
  type DeployTargetsResponse,
  DeployTargetsResponseSchema,
  type FollowupSpec,
  type PatchDeployTargetRequest,
  type PatchPhaseRequest,
  type PhaseDetailDto,
  PhaseDetailDtoSchema,
  type PhasesResponse,
  PhasesResponseSchema,
  type ProjectWorkstationsResponse,
  ProjectWorkstationsResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put } from '../client.ts';

export function usePhases(projectId: string | undefined) {
  return useQuery({
    queryKey: ['phases', projectId],
    enabled: !!projectId,
    queryFn: async () =>
      (await get<PhasesResponse>(`/projects/${projectId}/phases`, PhasesResponseSchema)).phases,
  });
}

/** A phase by project key and number (`/p/WEB/phases/2`). */
export function usePhaseByNumber(projectKey: string, number: number) {
  return useQuery({
    queryKey: ['phase', projectKey, number],
    enabled: !!projectKey && number > 0,
    queryFn: () => get<PhaseDetailDto>(`/phases/by-number/${projectKey}/${number}`, PhaseDetailDtoSchema),
  });
}

function useInvalidatePhases() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['phases', 'phase', 'board', 'card', 'desk']) qc.invalidateQueries({ queryKey: [k] });
  };
}

export function useCreatePhase(projectId: string) {
  const invalidate = useInvalidatePhases();
  return useMutation({
    mutationFn: (b: CreatePhaseRequest) => post<PhaseDetailDto>(`/projects/${projectId}/phases`, b),
    onSuccess: invalidate,
  });
}

export function usePatchPhase(phaseId: string) {
  const invalidate = useInvalidatePhases();
  return useMutation({
    mutationFn: (b: PatchPhaseRequest) => patch<PhaseDetailDto>(`/phases/${phaseId}`, b),
    onSuccess: invalidate,
  });
}

export function useSetPhaseFollowups(phaseId: string) {
  const invalidate = useInvalidatePhases();
  return useMutation({
    mutationFn: (followups: FollowupSpec[]) =>
      put<PhaseDetailDto>(`/phases/${phaseId}/followups`, { followups }),
    onSuccess: invalidate,
  });
}

export function useReopenPhase(phaseId: string) {
  const invalidate = useInvalidatePhases();
  return useMutation({
    mutationFn: (reason: string) => post<PhaseDetailDto>(`/phases/${phaseId}/reopen`, { reason }),
    onSuccess: invalidate,
  });
}

/** Puts a card in a phase or takes it out (`phaseId: null`). */
export function useAssignCardPhase() {
  const invalidate = useInvalidatePhases();
  return useMutation({
    mutationFn: (v: { cardId: string } & AssignCardPhaseRequest) =>
      put<CardDetailResponse>(`/cards/${v.cardId}/phase`, { phaseId: v.phaseId }),
    onSuccess: invalidate,
  });
}

export function useConfirmMerged() {
  const invalidate = useInvalidatePhases();
  return useMutation({
    mutationFn: (v: { cardId: string; note?: string }) =>
      post<CardDetailResponse>(`/cards/${v.cardId}/confirm-merged`, v.note ? { note: v.note } : {}),
    onSuccess: invalidate,
  });
}

export function useFollowupDefaults(projectId: string | undefined) {
  return useQuery({
    queryKey: ['followup-defaults', projectId],
    enabled: !!projectId,
    queryFn: async () =>
      (await get<{ followups: FollowupSpec[] }>(`/projects/${projectId}/followup-defaults`)).followups,
  });
}

export function useSetFollowupDefaults(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (followups: FollowupSpec[]) =>
      put<{ followups: FollowupSpec[] }>(`/projects/${projectId}/followup-defaults`, { followups }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['followup-defaults', projectId] }),
  });
}

export function useDeployTargets(projectId: string | undefined) {
  return useQuery({
    queryKey: ['deploy-targets', projectId],
    enabled: !!projectId,
    queryFn: async () =>
      (await get<DeployTargetsResponse>(`/projects/${projectId}/deploy-targets`, DeployTargetsResponseSchema))
        .targets,
  });
}

export function useProjectWorkstations(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project-workstations', projectId],
    enabled: !!projectId,
    queryFn: async () =>
      (
        await get<ProjectWorkstationsResponse>(
          `/projects/${projectId}/workstations`,
          ProjectWorkstationsResponseSchema,
        )
      ).workstations,
  });
}

export function useAddDeployTarget(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateDeployTargetRequest) =>
      post<DeployTargetDto>(`/projects/${projectId}/deploy-targets`, b),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['deploy-targets', projectId] });
      void qc.invalidateQueries({ queryKey: ['places', projectId] });
      void qc.invalidateQueries({ queryKey: ['deploy-setup', projectId] });
    },
  });
}

export function usePatchDeployTarget(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; body: PatchDeployTargetRequest }) =>
      patch<DeployTargetDto>(`/deploy-targets/${v.id}`, v.body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['deploy-targets', projectId] });
      void qc.invalidateQueries({ queryKey: ['places', projectId] });
      void qc.invalidateQueries({ queryKey: ['deploy-setup', projectId] });
    },
  });
}

export function useRemoveDeployTarget(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del(`/deploy-targets/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['deploy-targets', projectId] });
      void qc.invalidateQueries({ queryKey: ['places', projectId] });
      void qc.invalidateQueries({ queryKey: ['deploy-setup', projectId] });
    },
  });
}
