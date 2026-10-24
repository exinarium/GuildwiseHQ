import {
  BACKEND_IDS,
  backendDef,
  normalizeEndpoint,
  type ProviderKeyId,
  type SetProviderKeyRequest,
  sealProviderKey,
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
      void qc.invalidateQueries({ queryKey: ['ai-runtimes', workstationId] });
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
    mutationFn: async (v: {
      provider: ProviderKeyId;
      key: string;
      baseUrl?: string;
      models: string[];
      /** A NAMED account of the workstation's own key (S-A); absent: the main key. The name is bound into the sealed blob. */
      account?: string;
    }) => {
      // Q73: the key's version (seconds since the epoch: a later entry is always higher), bound into the sealed blob; the runner
      // refuses an older one, so a removed or replaced key cannot be put back by replaying its blob
      const generation = Math.floor(Date.now() / 1000);
      const sealed = await get<{ keyId: string; publicKey: string }>(
        `/workstations/${workstationId}/sudo-key`,
      );
      // The endpoint the key is bound to: an OpenAI-compatible provider's base URL, or the endpoint inside a backend credential.
      const endpoint = (BACKEND_IDS as readonly string[]).includes(v.provider)
        ? backendEndpointOf(v.key)
        : (v.baseUrl ?? '');
      const body: SetProviderKeyRequest = {
        keyId: sealed.keyId,
        // Always hybrid (RSA-OAEP wrapped AES-GCM key) with the purpose as associated data: a credential of any length fits, a
        // service-account JSON included, and the blob opens only for this provider and endpoint on this runner key.
        ...(v.key
          ? {
              ciphertext: await sealProviderKey(sealed.publicKey, v.key, {
                scope: 'workstation',
                provider: v.provider,
                endpoint,
                generation,
                keyId: sealed.keyId,
                ...(v.account ? { account: v.account } : {}),
              }),
            }
          : {}),
        ...(v.key ? { generation } : {}),
        ...(v.account ? { account: v.account } : {}),
        ...(endpoint ? { baseUrl: endpoint } : {}),
        models: v.models,
      };
      return put(`/workstations/${workstationId}/providers/${v.provider}`, body);
    },
    onSuccess: () => refreshSoon(qc, workstationId),
  });
}

/** Replaces the workstation's private-endpoint allow-list (exact host:port entries; only its owner may). */
export function useSetPrivateEndpoints(workstationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (endpoints: string[]) =>
      put(`/workstations/${workstationId}/private-endpoints`, { endpoints }),
    onSuccess: () => refreshSoon(qc, workstationId),
  });
}

/** Removes the workstation's key of a provider: the main key, or a named account (`{ provider, account }`). */
export function useRemoveProviderKey(workstationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: ProviderKeyId | { provider: ProviderKeyId; account?: string }) => {
      const provider = typeof v === 'string' ? v : v.provider;
      const account = typeof v === 'string' ? undefined : v.account;
      return del(
        `/workstations/${workstationId}/providers/${provider}${account ? `?account=${encodeURIComponent(account)}` : ''}`,
      );
    },
    onSuccess: () => refreshSoon(qc, workstationId),
  });
}

/** The endpoint (`baseUrl` field) of a backend credential's JSON, normalised; empty when it has none. */
function backendEndpointOf(json: string): string {
  try {
    const f = JSON.parse(json) as Record<string, unknown>;
    return typeof f.baseUrl === 'string' ? normalizeEndpoint(f.baseUrl) : '';
  } catch {
    return '';
  }
}
