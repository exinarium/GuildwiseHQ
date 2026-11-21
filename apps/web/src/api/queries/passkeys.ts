import {
  type AddPasskeyRequest,
  type PasskeyApprovalRequest,
  type PasskeyApprovalResponse,
  PasskeyApprovalResponseSchema,
  type PasskeyRegistrationOptionsResponse,
  PasskeyRegistrationOptionsResponseSchema,
  type WorkstationApprovalsResponse,
  WorkstationApprovalsResponseSchema,
  type WorkstationPasskeyDto,
  WorkstationPasskeyDtoSchema,
  type WorkstationPasskeysResponse,
  WorkstationPasskeysResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '../client.ts';

/*
 * Passkey approvals of one workstation (R22). The server verifies registrations and relays assertions; the runner trusts a
 * passkey only after `guildwise-runner passkey trust` on the machine and decides every approval itself.
 */

const passkeysKey = (id: string) => ['workstation', id, 'passkeys'] as const;
const approvalsKey = (id: string) => ['workstation', id, 'approvals'] as const;

export function useWorkstationPasskeys(id: string | undefined) {
  return useQuery({
    queryKey: passkeysKey(id ?? ''),
    enabled: !!id,
    queryFn: () =>
      get<WorkstationPasskeysResponse>(`/workstations/${id}/passkeys`, WorkstationPasskeysResponseSchema),
  });
}

/** The held list as the runner last reported it; refreshed often because a challenge lives five minutes. */
export function useWorkstationApprovals(id: string | undefined) {
  return useQuery({
    queryKey: approvalsKey(id ?? ''),
    enabled: !!id,
    queryFn: () =>
      get<WorkstationApprovalsResponse>(`/workstations/${id}/approvals`, WorkstationApprovalsResponseSchema),
    refetchInterval: 5_000,
  });
}

export const passkeyRegistrationOptions = (id: string) =>
  post<PasskeyRegistrationOptionsResponse>(
    `/workstations/${id}/passkeys/options`,
    undefined,
    PasskeyRegistrationOptionsResponseSchema,
  );

export function useAddPasskey(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AddPasskeyRequest) =>
      post<WorkstationPasskeyDto>(`/workstations/${id}/passkeys`, body, WorkstationPasskeyDtoSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: passkeysKey(id) }),
  });
}

export function useRemovePasskey(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (passkeyId: string) => del<{ ok: true }>(`/workstations/${id}/passkeys/${passkeyId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: passkeysKey(id) }),
  });
}

export function useRelayPasskeyApproval(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: PasskeyApprovalRequest }) =>
      post<PasskeyApprovalResponse>(
        `/workstations/${id}/approvals/${encodeURIComponent(itemId)}/passkey`,
        body,
        PasskeyApprovalResponseSchema,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: approvalsKey(id) }),
  });
}
