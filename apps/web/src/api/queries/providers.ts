import {
  backendDef,
  type ProviderKeyId,
  type SetProviderKeyRequest,
  sealLarge,
  type WorkstationProvidersResponse,
  WorkstationProvidersResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, put } from '../client.ts';

/** The direct API providers configured on a workstation (names and models only; the runner never reports a key). */
export function useWorkstationProviders(workstationId: string, opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: ['workstation-providers', workstationId],
    queryFn: (): Promise<WorkstationProvidersResponse> =>
      get(`/workstations/${workstationId}/providers`, WorkstationProvidersResponseSchema),
  });
}

/** The runner re-reports within a moment of a change: refresh a few times. */
function refreshSoon(qc: ReturnType<typeof useQueryClient>, workstationId: string): void {
  for (const ms of [800, 2000, 5000]) {
    setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ['workstation-providers', workstationId] });
      void qc.invalidateQueries({ queryKey: ['workstations'] });
    }, ms);
  }
}

/**
 * Stores a provider key on one workstation: the key is encrypted in the browser with the runner's public key (RSA-OAEP, the
 * same way as the sudo password) and only the ciphertext is sent. A keyless OpenAI-compatible endpoint sends no ciphertext.
 */
export function useSetProviderKey(workstationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { provider: ProviderKeyId; key: string; baseUrl?: string; models: string[] }) => {
      const sealed = await get<{ keyId: string; publicKey: string }>(
        `/workstations/${workstationId}/sudo-key`,
      );
      const body: SetProviderKeyRequest = {
        keyId: sealed.keyId,
        // Always hybrid (RSA-OAEP wrapped AES-GCM key): a credential of any length fits, a service-account JSON included. The
        // runner still opens the older RSA-only blobs it already stores.
        ...(v.key ? { ciphertext: await sealLarge(sealed.publicKey, v.key) } : {}),
        ...(v.baseUrl ? { baseUrl: v.baseUrl } : {}),
        models: v.models,
      };
      return put(`/workstations/${workstationId}/providers/${v.provider}`, body);
    },
    onSuccess: () => refreshSoon(qc, workstationId),
  });
}

export function useRemoveProviderKey(workstationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (provider: ProviderKeyId) => del(`/workstations/${workstationId}/providers/${provider}`),
    onSuccess: () => refreshSoon(qc, workstationId),
  });
}
