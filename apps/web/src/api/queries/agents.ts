import {
  AgentsResponseSchema,
  type HireAgentRequest,
  NameSuggestionsResponseSchema,
  RolesResponseSchema,
  WorkflowsResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, qs } from '../client.ts';

export function useAgents(projectId?: string) {
  return useQuery({
    queryKey: ['agents', projectId ?? 'all'],
    queryFn: async () => (await get(`/agents${qs({ projectId })}`, AgentsResponseSchema)).agents,
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

export function useRoles() {
  return useQuery({
    queryKey: ['roles'],
    staleTime: 300_000,
    queryFn: async () => (await get('/roles', RolesResponseSchema)).roles,
  });
}

export function useWorkflows() {
  return useQuery({
    queryKey: ['workflows'],
    staleTime: 300_000,
    queryFn: async () => (await get('/workflows', WorkflowsResponseSchema)).workflows,
  });
}

export function useHire() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: HireAgentRequest) => post('/agents', b),
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
