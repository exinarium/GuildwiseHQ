import {
  AgentsResponseSchema,
  type HireAgentRequest,
  NameSuggestionsResponseSchema,
  RolesResponseSchema,
  WorkflowsResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put, qs } from '../client.ts';

export function useAgents(projectId?: string, department?: string) {
  return useQuery({
    queryKey: ['agents', projectId ?? 'all', department ?? 'any'],
    queryFn: async () => (await get(`/agents${qs({ projectId, department })}`, AgentsResponseSchema)).agents,
  });
}

export function useNameSuggestions(enabled: boolean, nonce: number, theme = 'default') {
  return useQuery({
    queryKey: ['name-suggestions', nonce, theme],
    enabled,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () =>
      (await get(`/agents/name-suggestions${qs({ count: 6, theme })}`, NameSuggestionsResponseSchema)).names,
  });
}

/** Active roles of the organization the work runs in: with `projectId`, the owner's catalogue of a shared project. */
export function useRoles(projectId?: string) {
  return useQuery({
    queryKey: ['roles', projectId ?? 'own'],
    staleTime: 300_000,
    queryFn: async () => (await get(`/roles${qs({ projectId })}`, RolesResponseSchema)).roles,
  });
}

export function useWorkflows(projectId?: string) {
  return useQuery({
    queryKey: ['workflows', projectId ?? 'own'],
    staleTime: 300_000,
    queryFn: async () => (await get(`/workflows${qs({ projectId })}`, WorkflowsResponseSchema)).workflows,
  });
}

export function useHire() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: HireAgentRequest) => post('/agents', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}

/** "Re-roll face": a new generated face for the agent. */
export function useRerollFace() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/agents/${id}/avatar/reroll`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}

export function useFire() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/agents/${id}/fire`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['board'] });
      qc.invalidateQueries({ queryKey: ['card'] });
    },
  });
}

/** "Allowed projects": a project list, or null for any project of the organization. */
export function useSetAllowedProjects() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, projectIds }: { id: string; projectIds: string[] | null }) =>
      put(`/agents/${id}/allowed-projects`, { projectIds }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['hr'] });
    },
  });
}

/** Focus projects: the projects the agent prefers inside its allow-list. */
export function useSetFocusProjects() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, projectIds }: { id: string; projectIds: string[] }) =>
      put(`/agents/${id}/focus-projects`, { projectIds }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['hr'] });
    },
  });
}
