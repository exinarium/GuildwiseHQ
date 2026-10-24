import {
  type OrgModelPrice,
  type OrgModelPricesResponse,
  OrgModelPricesResponseSchema,
  type OrgProvidersResponse,
  OrgProvidersResponseSchema,
  type ProviderKeyId,
  type ReshareOrgProviderKeyRequest,
  sealProviderKey,
  sealResealApproval,
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

/** What a sealed organization key is bound to: it opens only for this organization, provider, endpoint and key generation. */
export interface OrgSealBinding {
  orgId: string;
  provider: ProviderKeyId;
  /** The endpoint (base URL) the credential is for, as the server will store it; none for a hosted provider. */
  endpoint?: string | undefined;
  /** The generation the blob is bound to: a new key `current + 1`, a share of the current key `current`. */
  generation: number;
}

/**
 * Seals a key for each target with that workstation's own public key, in the browser (RSA-OAEP + AES-GCM, with the purpose as
 * associated data): the request carries one ciphertext per workstation and the plain key exists only in this function. `secret`
 * is the key, or the JSON of a credential's fields (a Bedrock, Vertex or gateway credential).
 */
export async function sealForTargets(
  secret: string,
  targets: readonly SealTarget[],
  binding: OrgSealBinding,
): Promise<Array<{ workstationId: string; keyId: string; ciphertext: string }>> {
  return Promise.all(
    targets.map(async (t) => ({
      workstationId: t.workstationId,
      keyId: t.keyId,
      ciphertext: await sealProviderKey(t.publicKey, secret, { scope: 'org', ...binding, keyId: t.keyId }),
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
      /** The organization, and the generation of the key now (from the list): the new key is bound to the next one. */
      orgId: string;
      currentGeneration: number;
    }) =>
      put(`/org/providers/${provider}`, {
        ...(v.detail ? { detail: v.detail } : {}),
        ...(v.baseUrl ? { baseUrl: v.baseUrl } : {}),
        models: v.models,
        generation: v.currentGeneration + 1,
        shares: await sealForTargets(v.secret, v.targets, {
          orgId: v.orgId,
          provider,
          endpoint: v.baseUrl,
          generation: v.currentGeneration + 1,
        }),
      }),
    onSuccess: refresh,
  });
}

/** The admin enters the key again for one workstation that joined later. */
export function useShareOrgProviderKey(provider: ProviderKeyId) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (v: {
      secret: string;
      target: SealTarget;
      orgId: string;
      /** The key's generation and endpoint as the list shows them: the copy is bound to both. */
      generation: number;
      baseUrl: string | null;
    }) => {
      const [share] = await sealForTargets(v.secret, [v.target], {
        orgId: v.orgId,
        provider,
        endpoint: v.baseUrl ?? undefined,
        generation: v.generation,
      });
      return put(`/org/providers/${provider}/shares`, { ...share, generation: v.generation });
    },
    onSuccess: refresh,
  });
}

/**
 * A runner that holds the key re-seals it to another workstation, on the admin's approval. The approval is made here: it names
 * the target runner's key as the admin was shown it and is sealed to the source runner, which seals the key to that key only.
 */
export function useReshareOrgProviderKey(provider: ProviderKeyId) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (v: {
      orgId: string;
      approvedBy: string;
      generation: number;
      source: SealTarget;
      target: SealTarget;
    }) => {
      const body: ReshareOrgProviderKeyRequest = {
        sourceWorkstationId: v.source.workstationId,
        targetWorkstationId: v.target.workstationId,
        generation: v.generation,
        approval: await sealResealApproval({
          source: v.source,
          target: v.target,
          orgId: v.orgId,
          provider,
          generation: v.generation,
          approvedBy: v.approvedBy,
        }),
      };
      return post(`/org/providers/${provider}/reshare`, body);
    },
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

/** The Owner's prices (USD per million tokens) for models the built-in tables do not price. */
export function useOrgModelPrices() {
  return useQuery({
    queryKey: ['org-model-prices'],
    queryFn: (): Promise<OrgModelPricesResponse> => get('/org/model-prices', OrgModelPricesResponseSchema),
  });
}

export function useSetOrgModelPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: OrgModelPrice) => put('/org/model-prices', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-model-prices'] }),
  });
}

export function useRemoveOrgModelPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { provider: string; model: string }) =>
      del(
        `/org/model-prices?provider=${encodeURIComponent(v.provider)}&model=${encodeURIComponent(v.model)}`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-model-prices'] }),
  });
}
