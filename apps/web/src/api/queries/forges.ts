import { type ConnectableForge, type ForgeKind, type ForgeRepoList, ForgeRepoListSchema } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post } from '../client.ts';

/** "Check again": the workstation re-reads its git logins and reports them (the Workstations list refreshes). */
export function useRecheckGit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (workstationId: string) => post(`/workstations/${workstationId}/git/recheck`, {}),
    onSuccess: () => {
      // The runner answers within a moment; refresh a few times.
      for (const ms of [1500, 4000, 8000])
        setTimeout(() => qc.invalidateQueries({ queryKey: ['workstations'] }), ms);
    },
  });
}

/**
 * The repository picker: asks a workstation for the user's repositories on a connected provider and polls for the
 * answer. The list comes from the provider through the workstation; no credential reaches the server or the browser.
 */
export function useRepoPicker(workstationId: string | undefined, provider: ConnectableForge | undefined) {
  const start = useMutation({
    mutationFn: (search?: string) =>
      post<ForgeRepoList>(
        `/workstations/${workstationId}/git/repos`,
        { provider, ...(search?.trim() ? { search: search.trim() } : {}) },
        ForgeRepoListSchema,
      ),
  });
  const requestId = start.data?.requestId;
  const poll = useQuery({
    enabled: !!workstationId && !!requestId,
    queryKey: ['forge-repos', workstationId, requestId],
    queryFn: () => get(`/workstations/${workstationId}/git/repos/${requestId}`, ForgeRepoListSchema),
    refetchInterval: (q) => (q.state.data && q.state.data.state !== 'pending' ? false : 1500),
  });
  return { start, result: poll.data ?? start.data };
}

/** The owner picks (or clears) the git provider of a repository. */
export function useSetRepoForge(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { repoId: string; forge: ForgeKind | null }) =>
      patch(`/projects/${projectId}/repos/${v.repoId}`, { forge: v.forge }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });
}

/** The owner names (or clears, `null`: the repository's default branch) the main branch pull requests go to. */
export function useSetRepoMainBranch(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { repoId: string; mainBranch: string | null }) =>
      patch(`/projects/${projectId}/repos/${v.repoId}`, { mainBranch: v.mainBranch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });
}

/** Opens a pull request from the repository's working branch to its main branch (the workstation does it). */
export function useRequestReleasePr(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => post(`/projects/${projectId}/repos/${repoId}/release-pr`, {}),
    onSuccess: () => {
      // The workstation answers within a moment; refresh a few times.
      for (const ms of [500, 2000, 5000, 10000, 20000])
        setTimeout(() => qc.invalidateQueries({ queryKey: ['project', projectId] }), ms);
    },
  });
}

/** The owner sets (or clears, `null`) the folder of a repository the project lives in. */
export function useSetRepoProjectPath(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { repoId: string; projectPath: string | null }) =>
      patch(`/projects/${projectId}/repos/${v.repoId}`, { projectPath: v.projectPath }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });
}
