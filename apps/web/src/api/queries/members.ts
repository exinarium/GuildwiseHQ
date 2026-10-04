import {
  type DecisionPolicyRequest,
  type ProjectInvitationDto,
  ProjectInvitationsResponseSchema,
  type RehomeAgentRequest,
  type RemovalPreview,
  RemovalPreviewSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '../client.ts';

export const invitationsKey = ['project-invitations'] as const;

/** Pending project shares for the signed-in user. The invitee cannot see the project's events yet, so poll. */
export function useProjectInvitations() {
  return useQuery({
    queryKey: invitationsKey,
    queryFn: async (): Promise<ProjectInvitationDto[]> =>
      (await get('/project-invitations', ProjectInvitationsResponseSchema)).invitations,
    refetchInterval: 5000,
  });
}

export function useAnswerShare() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { projectId: string; accept: boolean }) =>
      post(`/projects/${v.projectId}/members/${v.accept ? 'accept' : 'decline'}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: invitationsKey });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useShareProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (email: string) => post(`/projects/${projectId}/members`, { email }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });
}

export function useRemovalPreview(projectId: string, userId: string | null) {
  return useQuery({
    queryKey: ['removal-preview', projectId, userId],
    enabled: !!userId,
    queryFn: () =>
      get<RemovalPreview>(`/projects/${projectId}/members/${userId}/removal-preview`, RemovalPreviewSchema),
  });
}

export function useRemoveMember(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => del(`/projects/${projectId}/members/${userId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['board'] });
    },
  });
}

export function useRehomeAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { agentId: string } & RehomeAgentRequest) =>
      post(`/agents/${v.agentId}/rehome`, {
        workstationId: v.workstationId,
        runtime: v.runtime,
        model: v.model,
        ...(v.acknowledgeUnsandboxed ? { acknowledgeUnsandboxed: true } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}

export function useDecisionPolicy(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: DecisionPolicyRequest) => post(`/cards/${cardId}/decision-policy`, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['card'] }),
  });
}

export function useRehomeCard(cardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post(`/cards/${cardId}/rehome`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['card'] });
      qc.invalidateQueries({ queryKey: ['board'] });
    },
  });
}
