import {
  type CreateDevOpsRequest,
  type DevOpsRequestDetail,
  DevOpsRequestDetailSchema,
  DevOpsRequestsResponseSchema,
  type PatchDevOpsAccessRequest,
  type ResolveDevOpsApprovalRequest,
  type RunHygieneResponse,
  type SudoKeyResponse,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put, qs } from '../client.ts';

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

/** Repository hygiene (docs/design/phases.md addendum): the cadence of the scheduled job. */
export function useSetHygieneInterval() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { workstationId: string; intervalHours: number }) =>
      put(`/workstations/${v.workstationId}/hygiene`, { intervalHours: v.intervalHours }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workstations'] }),
  });
}

/** Check the rights ticked on the DevOps engineer on the machine itself. */
export function useVerifyRights() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workstationId: string) => post(`/workstations/${workstationId}/verify-rights`, {}),
    // The list now says "checking" (rightsCheck); it keeps polling until the runner's answer, an error or the timeout.
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workstations'] }),
  });
}

/**
 * Sends the sudo password: fetches the runner's public key, encrypts the password in the browser (RSA-OAEP, SHA-256)
 * and sends only the ciphertext. The password is never stored, logged or sent anywhere else.
 */
export function useSetSudoPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { workstationId: string; password: string }) => {
      const key = await get<SudoKeyResponse>(`/workstations/${v.workstationId}/sudo-key`);
      const ciphertext = await encryptForRunner(key.publicKey, v.password);
      return put(`/workstations/${v.workstationId}/sudo-password`, { ciphertext, keyId: key.keyId });
    },
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['workstations'] }), 2000),
  });
}

export function useClearSudoPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workstationId: string) => del(`/workstations/${workstationId}/sudo-password`),
    onSuccess: () => setTimeout(() => qc.invalidateQueries({ queryKey: ['workstations'] }), 1000),
  });
}

/** RSA-OAEP / SHA-256 with the runner's SPKI public key (base64); returns base64 ciphertext. */
export async function encryptForRunner(publicKeyB64: string, text: string): Promise<string> {
  const der = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, [
    'encrypt',
  ]);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(text)),
  );
  let bin = '';
  for (const b of ct) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** "Run hygiene now". */
export function useRunHygiene() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workstationId: string) =>
      post<RunHygieneResponse>(`/workstations/${workstationId}/hygiene/run`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['devops'] });
      qc.invalidateQueries({ queryKey: ['workstations'] });
    },
  });
}
