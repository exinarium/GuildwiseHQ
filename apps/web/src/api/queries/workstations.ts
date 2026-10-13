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
import { get, patch, post, put } from '../client.ts';

/** Organisation source folder: ask the workstation's runner to set (`path`) or clear (`null`) it; the runner decides. */
export function useSetOrgFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { workstationId: string; orgId: string; path: string | null }) =>
      put(`/workstations/${v.workstationId}/org-folder`, { orgId: v.orgId, path: v.path }),
    onSuccess: () => {
      // The runner answers within a moment: refresh a few times.
      for (const ms of [800, 2000, 5000])
        setTimeout(() => qc.invalidateQueries({ queryKey: ['workstations'] }), ms);
    },
  });
}

/** Agent toolchains: the owner removes one the DevOps engineer registered (the runner reports the new list). */
export function useRemoveToolchain() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { workstationId: string; name: string }) =>
      post(`/workstations/${v.workstationId}/toolchains/remove`, { name: v.name }),
    onSuccess: () => {
      for (const ms of [800, 2000, 5000])
        setTimeout(() => qc.invalidateQueries({ queryKey: ['workstations'] }), ms);
    },
  });
}

export function useWorkstations(opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
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
