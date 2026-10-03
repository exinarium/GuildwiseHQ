import {
  type PatchVaultRequest,
  type RegisterVaultRequest,
  type VaultDto,
  VaultsResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post } from '../client.ts';

export const vaultsKey = ['vaults'] as const;

export function useVaults() {
  return useQuery({
    queryKey: vaultsKey,
    queryFn: async () => (await get('/vaults', VaultsResponseSchema)).vaults,
    // Sync status is reported by runners and does not emit domain events: poll lightly.
    refetchInterval: 5000,
  });
}

export function useRegisterVault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: Omit<RegisterVaultRequest, 'syncIntervalSec'> & { syncIntervalSec?: number }) =>
      post<VaultDto>('/vaults', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: vaultsKey }),
  });
}

export function usePatchVault() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; body: PatchVaultRequest }) => patch<VaultDto>(`/vaults/${v.id}`, v.body),
    onSuccess: () => qc.invalidateQueries({ queryKey: vaultsKey }),
  });
}

export function useResolveVaultConflict() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; workstationId: string }) =>
      post<VaultDto>(`/vaults/${v.id}/resolve-conflict`, { workstationId: v.workstationId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: vaultsKey }),
  });
}
