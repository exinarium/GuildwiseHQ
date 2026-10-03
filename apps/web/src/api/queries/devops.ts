import {
  type CreateDevOpsRequest,
  type DevOpsRequestDetail,
  DevOpsRequestDetailSchema,
  DevOpsRequestsResponseSchema,
  type PatchDevOpsAccessRequest,
  type ResolveDevOpsApprovalRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post, qs } from '../client.ts';

export function useDevOpsRequests(workstationId?: string) {
  return useQuery({
    queryKey: ['devops', 'requests', workstationId ?? 'all'],
    queryFn: async () =>
      (await get(`/devops/requests${qs({ workstationId })}`, DevOpsRequestsResponseSchema)).requests,
    refetchInterval: 5000,
  });
}

export function useDevOpsRequest(id: string | null) {
  return useQuery({
    queryKey: ['devops', 'request', id],
    enabled: !!id,
    queryFn: () => get<DevOpsRequestDetail>(`/devops/requests/${id}`, DevOpsRequestDetailSchema),
    refetchInterval: 5000,
  });
}

export function useCreateDevOpsRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: CreateDevOpsRequest) => post<DevOpsRequestDetail>('/devops/requests', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devops'] }),
  });
}

export function useResolveDevOpsApproval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string } & ResolveDevOpsApprovalRequest) =>
      post<DevOpsRequestDetail>(`/devops/requests/${v.id}/resolve`, {
        resolution: v.resolution,
        ...(v.note ? { note: v.note } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['devops'] }),
  });
}

export function usePatchDevOpsAccess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { workstationId: string; body: PatchDevOpsAccessRequest }) =>
      patch(`/workstations/${v.workstationId}/devops-access`, v.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workstations'] }),
  });
}

export function useResetAgent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => post(`/agents/${agentId}/reset`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['agents'] }),
  });
}
