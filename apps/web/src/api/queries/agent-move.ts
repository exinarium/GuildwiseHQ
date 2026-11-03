import {
  AgentHomesResponseSchema,
  type MoveAllAgentsRequest,
  MoveAllAgentsResponseSchema,
  MoveTargetsResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';

/** Workstations (any status) that hold the organization's agents; owners and admins only. */
export function useAgentHomes(enabled: boolean) {
  return useQuery({
    queryKey: ['agent-homes'],
    queryFn: async () => (await get('/agents/workstations', AgentHomesResponseSchema)).workstations,
    enabled,
  });
}

/** The workstations the agents of `sourceId` can move to; lazy: only while the dialog is open. */
export function useBulkMoveTargets(sourceId: string | undefined) {
  return useQuery({
    queryKey: ['move-targets', 'ws', sourceId],
    queryFn: () => get(`/workstations/${sourceId}/move-targets`, MoveTargetsResponseSchema),
    enabled: !!sourceId,
  });
}

/** What moving all agents would do (nothing is written). */
export function useMoveAllPreview(sourceId: string | undefined, targetId: string, ack: boolean) {
  return useQuery({
    queryKey: ['move-agents-preview', sourceId, targetId, ack],
    queryFn: () =>
      get(
        `/workstations/${sourceId}/move-agents/preview?targetWorkstationId=${targetId}${ack ? '&acknowledgeUnsandboxed=true' : ''}`,
        MoveAllAgentsResponseSchema,
      ),
    enabled: !!sourceId && !!targetId,
  });
}

export function useMoveAllAgents(sourceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: MoveAllAgentsRequest) =>
      post(`/workstations/${sourceId}/move-agents`, b, MoveAllAgentsResponseSchema),
    onSuccess: () => {
      for (const k of ['agents', 'hr', 'agent-homes', 'move-targets', 'workstations'])
        qc.invalidateQueries({ queryKey: [k] });
    },
  });
}
