import {
  type CreateMyPackRequest,
  type HireFromPackRequest,
  type MyPackDto,
  type MyPacksResponse,
  makeReplyKey,
  type PackAssignmentDto,
  type PackCredentialShares,
  type PackHireStatus,
  type PackPersonasResponse,
  type ReadMyPackResult,
  type RoleOfferReview,
  type RoleOffersResponse,
  type SessionDto,
  type StartPersonaChatRequest,
  sealLarge,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../client.ts';

export const myPacksKey = ['my-capabilities'] as const;

/** The packs I authored (private to my workstation, or for the organization) and my workstations. */
export function useMyPacks(enabled = true) {
  return useQuery({
    enabled,
    queryKey: myPacksKey,
    queryFn: () => get<MyPacksResponse>('/my-capabilities'),
    // a save is on its way to the workstation and back
    refetchInterval: (q) => (q.state.data?.packs.some((p) => p.saving) ? 3000 : false),
  });
}

function useMyPackMutation<V, R = unknown>(run: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: myPacksKey });
      void qc.invalidateQueries({ queryKey: ['capabilities'] });
      void qc.invalidateQueries({ queryKey: ['packs'] });
    },
  });
}

export const useCreateMyPack = () =>
  useMyPackMutation((b: CreateMyPackRequest) => post<{ pack: MyPackDto }>('/my-capabilities', b));
export const useSetMyPackVisibility = () =>
  useMyPackMutation((v: { id: string; visibility: 'org' | 'private' }) =>
    put(`/my-capabilities/${v.id}/visibility`, { visibility: v.visibility }),
  );
export const useRemoveMyPack = () => useMyPackMutation((id: string) => del(`/my-capabilities/${id}`));
export const useGrantPackAgent = () =>
  useMyPackMutation((v: { id: string; agentId: string; granted: boolean }) =>
    put(`/my-capabilities/${v.id}/agents`, { agentId: v.agentId, granted: v.granted }),
  );

interface RunnerKey {
  keyId: string;
  publicKey: string;
}

/**
 * Saves the editor's files: sealed in the browser to the runner key of the author's workstation (hybrid RSA + AES), so the server
 * relays ciphertext only. `tree` is the pack in the standard layout.
 */
export function useSaveMyPack() {
  return useMyPackMutation(
    async (v: { id: string; workstationId: string; tree: Record<string, string>; approve: boolean }) => {
      const key = await get<RunnerKey>(`/workstations/${v.workstationId}/sudo-key`);
      const ciphertext = await sealLarge(key.publicKey, JSON.stringify({ tree: v.tree }));
      return post(`/my-capabilities/${v.id}/save`, { keyId: key.keyId, ciphertext, approve: v.approve });
    },
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Reads the files of an authored pack for the editor: the browser makes a one-time key, the workstation seals the files to it, the
 * server relays ciphertext only. Resolves with the pack tree, or throws with the workstation's reason.
 */
export async function readMyPackTree(
  packId: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<Record<string, string>> {
  const key = await makeReplyKey();
  const { requestId } = await post<{ requestId: string }>(`/my-capabilities/${packId}/read`, {
    replyKey: key.publicKey,
  });
  for (let i = 0; i < (opts.attempts ?? 40); i++) {
    const r = await get<ReadMyPackResult>(`/my-capabilities/reads/${requestId}`);
    if (r.status === 'ready' && r.ciphertext)
      return (JSON.parse(await key.open(r.ciphertext)) as { tree: Record<string, string> }).tree;
    if (r.status === 'failed') throw new Error(r.error ?? 'the workstation could not read the pack');
    await sleep(opts.delayMs ?? 750);
  }
  throw new Error('the workstation did not answer: is it online?');
}

// ------------------------------------------------------------------------------------------------ opt-in

export const assignmentsKey = ['pack-assignments'] as const;
export function usePackAssignments() {
  return useQuery({
    queryKey: assignmentsKey,
    queryFn: async () => (await get<{ items: PackAssignmentDto[] }>('/pack-assignments')).items,
  });
}
export function useDecideAssignment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { packId: string; workstationId: string; accept: boolean }) =>
      post(`/pack-assignments/${v.packId}/decide`, { workstationId: v.workstationId, accept: v.accept }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: assignmentsKey });
      void qc.invalidateQueries({ queryKey: ['desk'] });
      void qc.invalidateQueries({ queryKey: ['packs'] });
    },
  });
}

/** Seals a deploy key or token separately to each workstation (the server never sees it in the clear). */
export async function sealPackCredential(
  kind: 'ssh' | 'token',
  secret: string,
  workstationIds: readonly string[],
  username?: string,
): Promise<PackCredentialShares> {
  const shares = [];
  for (const workstationId of workstationIds) {
    const key = await get<RunnerKey>(`/workstations/${workstationId}/sudo-key`);
    shares.push({ workstationId, keyId: key.keyId, ciphertext: await sealLarge(key.publicKey, secret) });
  }
  return { kind, ...(username ? { username } : {}), shares };
}

export function useSetPackWorkstations() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; workstationIds: string[]; credential?: PackCredentialShares }) =>
      put(`/packs/${v.id}/workstations`, {
        workstationIds: v.workstationIds,
        ...(v.credential ? { credential: v.credential } : {}),
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['packs'] }),
  });
}

// ------------------------------------------------------------------------------------------------ hire from pack

export function usePackPersonas(packId: string | null) {
  return useQuery({
    enabled: !!packId,
    queryKey: ['packs', 'personas', packId],
    queryFn: () => get<PackPersonasResponse>(`/packs/${packId}/personas`),
  });
}

export function useHireFromPack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { packId: string; body: HireFromPackRequest }) => {
      const { requestId } = await post<{ requestId: string }>(`/packs/${v.packId}/hire`, v.body);
      for (let i = 0; i < 60; i++) {
        const s = await get<PackHireStatus>(`/pack-hires/${requestId}`);
        if (s.status !== 'pending') {
          if (s.status === 'failed') throw new Error(s.error ?? 'the hire failed');
          return s;
        }
        await sleep(700);
      }
      throw new Error('the workstation did not answer: is it online?');
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['agents'] });
      void qc.invalidateQueries({ queryKey: ['packs', 'personas'] });
    },
  });
}

export const roleOffersKey = ['role-offers'] as const;
export function useRoleOffers(enabled = true) {
  return useQuery({
    enabled,
    queryKey: roleOffersKey,
    queryFn: async () => (await get<RoleOffersResponse>('/role-offers')).items,
  });
}
export function useReviewRoleOffer() {
  return useMutation({
    mutationFn: async (roleKey: string): Promise<RoleOfferReview> => {
      const { requestId } = await post<{ requestId: string }>(`/role-offers/${roleKey}/review`, {});
      for (let i = 0; i < 60; i++) {
        const r = await get<RoleOfferReview>(`/role-offers/${roleKey}/review/${requestId}`);
        if (r.status !== 'pending') {
          if (r.status === 'failed') throw new Error(r.error ?? 'the workstation could not read the pack');
          return r;
        }
        await sleep(700);
      }
      throw new Error('the workstation did not answer: is it online?');
    },
  });
}
export function useAcceptRoleOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { roleKey: string; requestId: string }) =>
      post<{ version: number; movedAgents: number }>(`/role-offers/${v.roleKey}/accept`, {
        requestId: v.requestId,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: roleOffersKey });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
export function useDismissRoleOffer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (roleKey: string) => post(`/role-offers/${roleKey}/dismiss`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: roleOffersKey }),
  });
}

// ------------------------------------------------------------------------------------------------ persona chat

export function useStartPersonaChat() {
  return useMutation({
    mutationFn: async (b: StartPersonaChatRequest) =>
      (await post<{ session: SessionDto }>('/persona-chats', b)).session,
  });
}
export function useSayToPersona(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: string) => post(`/persona-chats/${id}/say`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['thread', id] });
      void qc.invalidateQueries({ queryKey: ['persona-chat', id] });
    },
  });
}
export function usePersonaChat(id: string) {
  return useQuery({
    queryKey: ['persona-chat', id],
    queryFn: async () => {
      const s = (await get<{ session: SessionDto }>(`/sessions/${id}`)).session;
      const turns = (
        await get<{ turns: Array<{ id: string; status: string; error: string | null }> }>(
          `/sessions/${id}/turns`,
        )
      ).turns;
      return { session: s, turns };
    },
    refetchInterval: (q) =>
      q.state.data?.turns.some((t) => t.status === 'queued' || t.status === 'running') ? 2500 : false,
  });
}
