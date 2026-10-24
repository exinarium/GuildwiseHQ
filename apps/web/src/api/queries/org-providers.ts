import {
  type OrgProvidersResponse,
  OrgProvidersResponseSchema,
  type ProviderKeyId,
  type ReshareOrgProviderKeyRequest,
  sealLarge,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../client.ts';

/** The organization's provider keys and caps (Owner and Admins): facts and per-workstation status, never a key. */
export function useOrgProviders(opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: ['org-providers'],
    queryFn: (): Promise<OrgProvidersResponse> => get('/org/providers', OrgProvidersResponseSchema),
    // The runners answer a moment after a key is sent: refresh lightly while the page is open.
    refetchInterval: 5000,
  });
}

function useRefresh() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['org-providers'] });
    for (const ms of [800, 2500, 6000])
      setTimeout(() => qc.invalidateQueries({ queryKey: ['org-providers'] }), ms);
  };
}

/** A workstation a key can be sealed to: its runner's public key as the server knows it. */
export interface SealTarget {
  workstationId: string;
  keyId: string;
  publicKey: string;
}

/**
 * Seals a key for each target with that workstation's own public key, in the browser (RSA-OAEP + AES-GCM): the request carries
 * one ciphertext per workstation and the plain key exists only in this function. `secret` is the key, or the JSON of a
 * credential's fields (a Bedrock, Vertex or gateway credential).
 */
export async function sealForTargets(
  secret: string,
  targets: readonly SealTarget[],
): Promise<Array<{ workstationId: string; keyId: string; ciphertext: string }>> {
  return Promise.all(
    targets.map(async (t) => ({
      workstationId: t.workstationId,
      keyId: t.keyId,
      ciphertext: await sealLarge(t.publicKey, secret),
    })),
  );
}

export function useSetOrgProviderKey(provider: ProviderKeyId) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (v: {
      secret: string;
      targets: SealTarget[];
      detail?: string;
      baseUrl?: string;
      models: string[];
    }) =>
      put(`/org/providers/${provider}`, {
        ...(v.detail ? { detail: v.detail } : {}),
        ...(v.baseUrl ? { baseUrl: v.baseUrl } : {}),
        models: v.models,
        shares: await sealForTargets(v.secret, v.targets),
      }),
    onSuccess: refresh,
  });
}

/** The admin enters the key again for one workstation that joined later. */
export function useShareOrgProviderKey(provider: ProviderKeyId) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (v: { secret: string; target: SealTarget }) => {
      const [share] = await sealForTargets(v.secret, [v.target]);
      return put(`/org/providers/${provider}/shares`, share);
    },
    onSuccess: refresh,
  });
}

/** A runner that holds the key re-seals it to another workstation, on the admin's approval. */
export function useReshareOrgProviderKey(provider: ProviderKeyId) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (v: ReshareOrgProviderKeyRequest) => post(`/org/providers/${provider}/reshare`, v),
    onSuccess: refresh,
  });
}

export function useRevokeOrgProviderKey(provider: ProviderKeyId) {
  const refresh = useRefresh();
  return useMutation({ mutationFn: () => del(`/org/providers/${provider}`), onSuccess: refresh });
}

export function useSetOrgProviderCap(provider: ProviderKeyId) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (monthlyUsd: number | null) => put(`/org/providers/${provider}/cap`, { monthlyUsd }),
    onSuccess: refresh,
  });
}

export function useOverrideOrgProviderCap(provider: ProviderKeyId) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: () => post(`/org/providers/${provider}/cap/override`, {}),
    onSuccess: refresh,
  });
}
