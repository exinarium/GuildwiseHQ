import {
  type PatchSecuritySettingsRequest,
  type SecuritySettingsResponse,
  SecuritySettingsResponseSchema,
  type SignedRunnersStatus,
  SignedRunnersStatusSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch } from '../client.ts';

/** `GET /api/platform/security-settings` (super admin): both settings, whether each is locked, and the counts. */
export function useSecuritySettings() {
  return useQuery({
    queryKey: ['platform', 'security-settings'],
    queryFn: () =>
      get<SecuritySettingsResponse>('/platform/security-settings', SecuritySettingsResponseSchema),
  });
}

/** `PATCH /api/platform/security-settings` (super admin, "Confirm it's you" first). */
export function usePatchSecuritySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: PatchSecuritySettingsRequest) =>
      patch<SecuritySettingsResponse>('/platform/security-settings', body, SecuritySettingsResponseSchema),
    onSuccess: (data) => {
      qc.setQueryData(['platform', 'security-settings'], data);
      void qc.invalidateQueries({ queryKey: ['workstations'] });
    },
  });
}

/** `GET /api/workstations/signed-runners`: "Only signed runners" here, and the caller's workstations to reinstall. */
export function useSignedRunnersStatus() {
  return useQuery({
    queryKey: ['workstations', 'signed-runners'],
    queryFn: () => get<SignedRunnersStatus>('/workstations/signed-runners', SignedRunnersStatusSchema),
  });
}
