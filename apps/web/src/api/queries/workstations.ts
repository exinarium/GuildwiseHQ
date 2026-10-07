import {
  type CreateInstallerRequest,
  type CreateInvitationRequest,
  type InstallerSession,
  InstallerSessionSchema,
  type InstallerStatus,
  InstallerStatusSchema,
  type PairingCodeResponse,
  PairingCodeResponseSchema,
  type PatchUserRequest,
  WorkstationsResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post } from '../client.ts';

export function useWorkstations() {
  return useQuery({
    queryKey: ['workstations'],
    queryFn: async () => (await get('/workstations', WorkstationsResponseSchema)).workstations,
    // Repo matching (workstation_repos) is an operational projection that emits no event, so poll lightly.
    refetchInterval: 5000,
  });
}

export function usePairingCode() {
  return useMutation({
    mutationFn: () => post<PairingCodeResponse>('/workstations/pairing-codes', {}, PairingCodeResponseSchema),
  });
}

export function useUnlinkWorkstation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/workstations/${id}/unlink`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workstations'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}

export function useRenameWorkstation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; name: string }) => patch(`/workstations/${v.id}`, { name: v.name }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workstations'] }),
  });
}

export function useCreateInstaller() {
  return useMutation({
    mutationFn: (v: CreateInstallerRequest) =>
      post<InstallerSession>('/workstations/installers', v, InstallerSessionSchema),
  });
}

/** Follows one wizard session until it is done or expired. */
export function useInstallerStatus(id: string | undefined) {
  return useQuery({
    queryKey: ['installer', id],
    enabled: !!id,
    queryFn: () => get<InstallerStatus>(`/workstations/installers/${id}`, InstallerStatusSchema),
    refetchInterval: (q) => {
      const s = q.state.data?.state;
      return s === 'done' || s === 'expired' ? false : 1500;
    },
  });
}
