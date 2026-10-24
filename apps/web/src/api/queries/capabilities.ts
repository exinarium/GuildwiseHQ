import type {
  AddPackRequest,
  CapabilitiesResponse,
  PackDetailDto,
  PackDto,
  PacksResponse,
  ProjectSkillsResponse,
  ReviewProjectSkillRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '../client.ts';

export type RegistryItem = CapabilitiesResponse['items'][number];

export interface CapabilityFilter {
  kind?: 'skill' | 'persona' | 'playbook';
  projectId?: string;
  /** Pickers pass true: what an untrusted or changed pack offers is left out. */
  usable?: boolean;
}

const queryString = (f: CapabilityFilter): string => {
  const p = new URLSearchParams();
  if (f.kind) p.set('kind', f.kind);
  if (f.projectId) p.set('projectId', f.projectId);
  if (f.usable) p.set('usable', 'true');
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** The effective registry of the organization (built-in, vault, project repository, imported packs). */
export function useCapabilities(filter: CapabilityFilter = {}, enabled = true) {
  return useQuery({
    enabled,
    queryKey: [
      'capabilities',
      filter.kind ?? 'all',
      filter.projectId ?? '',
      filter.usable ? 'usable' : 'any',
    ],
    staleTime: 60_000,
    queryFn: () => get<CapabilitiesResponse>(`/capabilities${queryString(filter)}`),
  });
}

/** Usable registry entries only (what a picker may offer). Defends against a server that ignored `usable`. */
export function usableOnly(items: readonly RegistryItem[] | undefined): RegistryItem[] {
  return (items ?? []).filter((i) => i.usable !== false);
}

export const packsKey = ['packs'] as const;

export function usePacks(enabled = true) {
  return useQuery({
    enabled,
    queryKey: packsKey,
    queryFn: () => get<PacksResponse>('/packs'),
    // a pack waiting for its first fetch is filled in by a workstation
    refetchInterval: (q) => (q.state.data?.packs.some((p) => p.status === 'pending') ? 8000 : false),
  });
}

export function usePackDetail(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: ['packs', 'detail', id],
    queryFn: async () => (await get<{ pack: PackDetailDto }>(`/packs/${id}`)).pack,
  });
}

function usePackMutation<V>(run: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: packsKey });
      void qc.invalidateQueries({ queryKey: ['capabilities'] });
    },
  });
}

export const projectSkillsKey = ['capabilities', 'project-skills'] as const;

/** Capabilities found in project repositories, with the owner's review decisions (Owners and Admins). */
export function useProjectSkills(enabled = true) {
  return useQuery({
    enabled,
    queryKey: projectSkillsKey,
    queryFn: async () => (await get<ProjectSkillsResponse>('/capabilities/project-skills')).items,
  });
}
export function useReviewProjectSkill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: ReviewProjectSkillRequest) =>
      post<ProjectSkillsResponse>('/capabilities/project-skills/review', b),
    onSuccess: (r) => {
      qc.setQueryData(projectSkillsKey, r.items);
      void qc.invalidateQueries({ queryKey: ['capabilities'] });
    },
  });
}

export const useAddPack = () =>
  usePackMutation((b: Partial<AddPackRequest> & Pick<AddPackRequest, 'url' | 'ref'>) =>
    post<{ pack: PackDto }>('/packs', b),
  );
export const useCheckPack = () =>
  usePackMutation((v: { id: string; ref?: string }) =>
    post(`/packs/${v.id}/check`, v.ref ? { ref: v.ref } : {}),
  );
export const useAcceptPackUpdate = () =>
  usePackMutation((v: { id: string; sha: string }) =>
    post<{ pack: PackDto }>(`/packs/${v.id}/accept-update`, { sha: v.sha }),
  );
export const useTrustPack = () =>
  usePackMutation((v: { id: string; sha: string; contentHash: string }) =>
    post<{ pack: PackDto }>(`/packs/${v.id}/trust`, { sha: v.sha, contentHash: v.contentHash }),
  );
export const useRevokePack = () =>
  usePackMutation((id: string) => post<{ pack: PackDto }>(`/packs/${id}/revoke`, {}));
export const usePackScripts = () =>
  usePackMutation((v: { id: string; enabled: boolean }) =>
    post<{ pack: PackDto }>(`/packs/${v.id}/scripts`, { enabled: v.enabled }),
  );
export const useRemovePack = () => usePackMutation((id: string) => del(`/packs/${id}`));
