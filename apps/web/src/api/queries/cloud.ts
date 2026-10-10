import {
  type CloudWorkstation,
  CloudWorkstationListSchema,
  CloudWorkstationSchema,
  type CreateCodespaceRequest,
  type CreateVpsRequest,
  type GithubConnection,
  GithubConnectionSchema,
  type PatchCloudWorkstationRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, qs } from '../client.ts';

const KEY = ['cloud-workstations'];

/** The organization's cloud workstations (VPS and Codespaces). Polled while any is installing, starting or stopping. */
export function useCloudWorkstations(opts: { enabled?: boolean } = {}) {
  return useQuery({
    enabled: opts.enabled ?? true,
    queryKey: KEY,
    queryFn: () => get('/cloud-workstations', CloudWorkstationListSchema),
    refetchInterval: (q) => {
      const busy = q.state.data?.cloudWorkstations?.some((c) =>
        ['installing', 'starting', 'stopping'].includes(c.state),
      );
      return busy ? 3000 : 20000;
    },
  });
}

const useInvalidating = <V, R>(fn: (v: V) => Promise<R>) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['workstations'] });
    },
  });
};

export const useCreateVps = () =>
  useInvalidating((v: CreateVpsRequest) =>
    post<CloudWorkstation>('/cloud-workstations/vps', v, CloudWorkstationSchema),
  );

export const useCreateCodespace = () =>
  useInvalidating((v: CreateCodespaceRequest) =>
    post<CloudWorkstation>('/cloud-workstations/codespaces', v, CloudWorkstationSchema),
  );

export const useWakeCloud = () =>
  useInvalidating((id: string) =>
    post<CloudWorkstation>(`/cloud-workstations/${id}/wake`, {}, CloudWorkstationSchema),
  );

export const useStopCloud = () =>
  useInvalidating((id: string) =>
    post<CloudWorkstation>(`/cloud-workstations/${id}/stop`, {}, CloudWorkstationSchema),
  );

export const useRemoveCloud = () => useInvalidating((id: string) => del(`/cloud-workstations/${id}`));

export const usePatchCloud = () =>
  useInvalidating((v: { id: string; patch: PatchCloudWorkstationRequest }) =>
    patch<CloudWorkstation>(`/cloud-workstations/${v.id}`, v.patch, CloudWorkstationSchema),
  );

export function useGithubConnection(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['cloud-github'],
    queryFn: () => get<GithubConnection>('/cloud-workstations/github/connection', GithubConnectionSchema),
  });
}

export function useConnectGithub() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      post<GithubConnection>('/cloud-workstations/github/connect', { token }, GithubConnectionSchema),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cloud-github'] }),
  });
}

export function useCodespaceMachines(repo: string, enabled: boolean) {
  return useQuery({
    enabled: enabled && /^[\w.-]+\/[\w.-]+$/.test(repo),
    queryKey: ['cloud-machines', repo],
    retry: false,
    queryFn: async () =>
      (
        await get<{ machines: Array<{ name: string; displayName: string }> }>(
          `/cloud-workstations/github/machines${qs({ repo })}`,
        )
      ).machines,
  });
}

export function useDevcontainer(stacks: string, enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ['cloud-devcontainer', stacks],
    queryFn: () =>
      get<{ path: string; content: string }>(`/cloud-workstations/devcontainer${qs({ stacks })}`),
  });
}
