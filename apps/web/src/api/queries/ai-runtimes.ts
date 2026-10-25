import {
  type AccountScope,
  type AiRuntimesResponse,
  AiRuntimesResponseSchema,
  type ProjectProviderAccountsView,
  ProjectProviderAccountsViewSchema,
  type SetProviderAccountRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../client.ts';

/**
 * Integrations > AI runtime (S-A): the runtimes and providers of one workstation with their accounts, built by the server from
 * what its runner reported. Refreshed while the page is open: a sign-in or a key shows within a report.
 */
export function useAiRuntimes(workstationId: string | undefined) {
  return useQuery({
    queryKey: ['ai-runtimes', workstationId ?? ''],
    enabled: !!workstationId,
    queryFn: (): Promise<AiRuntimesResponse> =>
      get(`/workstations/${workstationId}/ai-runtimes`, AiRuntimesResponseSchema),
    refetchInterval: 15_000,
  });
}

/** "Make main": the named account and the main account swap places on the workstation. */
export function usePromoteAccount(workstationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { scope: AccountScope; key: string }) =>
      post(`/workstations/${workstationId}/accounts/promote`, v),
    onSuccess: () => {
      for (const ms of [800, 2500, 6000])
        setTimeout(() => void qc.invalidateQueries({ queryKey: ['ai-runtimes', workstationId] }), ms);
    },
  });
}

/** "Allow projects to use my accounts" (per workstation, off by default). */
export function useSetAccountSharing(workstationId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (allow: boolean) => put(`/workstations/${workstationId}/account-sharing`, { allow }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ai-runtimes', workstationId] }),
  });
}

/** The project's account for one provider or runtime and how it stands on each workstation that can serve it. */
export function useProviderAccounts(
  projectId: string,
  scope: AccountScope,
  opts: { enabled?: boolean } = {},
) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: ['provider-accounts', projectId, scope],
    queryFn: (): Promise<ProjectProviderAccountsView> =>
      get(`/projects/${projectId}/provider-accounts/${scope}`, ProjectProviderAccountsViewSchema),
    refetchInterval: 15_000,
  });
}

export function useSetProviderAccount(projectId: string, scope: AccountScope) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: SetProviderAccountRequest) => put(`/projects/${projectId}/provider-accounts/${scope}`, b),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['provider-accounts', projectId, scope] });
    },
  });
}
