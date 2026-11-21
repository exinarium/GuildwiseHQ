import {
  type DevopsCommandLogEntry,
  type OwnershipTransfer,
  OwnershipTransferSchema,
  type TwoFactorRecoveryStatus,
  TwoFactorRecoveryStatusSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';

/** R17: the routes that replaced the super admin's direct powers (recovery, transfer consent, DevOps logs). */

// ------------------------------------------------------------------------------------ 2FA recovery (public)

export function useStartTwoFactorRecovery() {
  return useMutation({
    mutationFn: (challenge: string) =>
      post<TwoFactorRecoveryStatus>('/auth/2fa/recovery/start', { challenge }, TwoFactorRecoveryStatusSchema),
  });
}

export function useTwoFactorRecoveryStatus(token: string) {
  return useQuery({
    queryKey: ['two-factor-recovery', token],
    queryFn: () =>
      post<TwoFactorRecoveryStatus>('/auth/2fa/recovery/status', { token }, TwoFactorRecoveryStatusSchema),
    enabled: !!token,
    retry: false,
  });
}

export function useTwoFactorRecoveryAction(token: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: 'confirm' | 'cancel') =>
      post<TwoFactorRecoveryStatus>(`/auth/2fa/recovery/${action}`, { token }, TwoFactorRecoveryStatusSchema),
    onSuccess: (s) => qc.setQueryData(['two-factor-recovery', token], s),
  });
}

// ----------------------------------------------------------------------------- ownership transfer (Owner)

export function useOwnershipTransfer(id: string) {
  return useQuery({
    queryKey: ['ownership-transfer', id],
    queryFn: () => get<OwnershipTransfer>(`/org/ownership-transfers/${id}`, OwnershipTransferSchema),
    retry: false,
  });
}

export function useDecideOwnershipTransfer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (decision: 'approve' | 'veto') =>
      post<OwnershipTransfer>(`/org/ownership-transfers/${id}/${decision}`, {}, OwnershipTransferSchema),
    onSuccess: (t) => {
      qc.setQueryData(['ownership-transfer', id], t);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

// ------------------------------------------------------------------------------------------ DevOps logs

export function useOrgDevopsLog(enabled = true) {
  return useQuery({
    queryKey: ['devops-log', 'org'],
    queryFn: async () =>
      (await get<{ entries: DevopsCommandLogEntry[] }>('/org/devops-audit?limit=200')).entries,
    enabled,
  });
}

export function useWorkstationDevopsLog(workstationId: string, enabled = true) {
  return useQuery({
    queryKey: ['devops-log', 'workstation', workstationId],
    queryFn: async () =>
      (
        await get<{ entries: DevopsCommandLogEntry[] }>(
          `/workstations/${workstationId}/devops-audit?limit=200`,
        )
      ).entries,
    enabled,
  });
}
