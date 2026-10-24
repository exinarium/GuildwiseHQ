import {
  type DelegateGrantsDto,
  DelegateGrantsDtoSchema,
  type DelegateOwnerKind,
  type DelegateTargetOption,
  DelegateTargetOptionsDtoSchema,
  type SetDelegateExclusionRequest,
  type SetDelegateGrantRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../client.ts';

/** An agent, a session, or (a role's grants, R3c) a role by its key. */
const base = (kind: DelegateOwnerKind, id: string) =>
  `/${kind === 'agent' ? 'agents' : kind === 'role' ? 'roles' : 'sessions'}/${encodeURIComponent(id)}`;

/** What an agent (or a session's facilitator and Chair) may delegate to. Off by default: an empty list. */
export function useDelegateGrants(kind: DelegateOwnerKind, id: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['delegate-grants', kind, id],
    queryFn: (): Promise<DelegateGrantsDto> =>
      get(`${base(kind, id)}/delegate-grants`, DelegateGrantsDtoSchema),
  });
}

/** The personas and agents a grant can name (only fetched once the picker is shown). */
export function useDelegateTargets(kind: DelegateOwnerKind, id: string, enabled = true) {
  return useQuery({
    enabled,
    staleTime: 30_000,
    queryKey: ['delegate-targets', kind, id],
    queryFn: async (): Promise<DelegateTargetOption[]> =>
      (await get(`${base(kind, id)}/delegate-targets`, DelegateTargetOptionsDtoSchema)).items,
  });
}

export function useSetDelegateGrant(kind: DelegateOwnerKind, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: SetDelegateGrantRequest) =>
      put<DelegateGrantsDto>(`${base(kind, id)}/delegate-grants`, v),
    onSuccess: (data) => {
      qc.setQueryData(['delegate-grants', kind, id], data);
      void qc.invalidateQueries({ queryKey: ['delegate-targets', kind, id] });
    },
  });
}

/** Q66: an Owner or Admin excludes one agent from a target its role grants (or takes the exclusion back). */
export function useSetDelegateExclusion(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: SetDelegateExclusionRequest) =>
      put<DelegateGrantsDto>(`${base('agent', agentId)}/delegate-exclusions`, v),
    onSuccess: (data) => {
      qc.setQueryData(['delegate-grants', 'agent', agentId], data);
    },
  });
}
