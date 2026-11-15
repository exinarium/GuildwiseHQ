import type { AddOrgAppRequest, OrgAppRequestDto, OrgAppsResponse } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post } from '../client.ts';

/** Settings > Automated apps: the organization's app integrations (metadata only; keys stay on the workstations). */
export function useOrgApps() {
  return useQuery({ queryKey: ['org-apps'], queryFn: () => get<OrgAppsResponse>('/org/apps') });
}

export function useAddOrgApp() {
  return useMutation({ mutationFn: (v: AddOrgAppRequest) => post<{ requestId: string }>('/org/apps', v) });
}

export function useOrgAppRequest(id: string | null) {
  return useQuery({
    enabled: !!id,
    queryKey: ['org-app-request', id],
    queryFn: () => get<OrgAppRequestDto>(`/org/apps/requests/${id}`),
    refetchInterval: (q) => (q.state.data && q.state.data.state !== 'pending' ? false : 1000),
  });
}

export function useTestOrgApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post<{ requestId: string }>(`/org/apps/${id}/test`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org-apps'] }),
  });
}

export function useRemoveOrgApp() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => del(`/org/apps/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['org-apps'] }),
  });
}
