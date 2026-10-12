import {
  type AddRepoRequest,
  type ConvertPreview,
  ConvertPreviewSchema,
  type ConvertProjectRequest,
  type ConvertResult,
  type CreateProjectRequest,
  type PatchProjectRequest,
  type ProjectDetailResponse,
  ProjectDetailResponseSchema,
  type ProjectDto,
  type ProjectImpact,
  ProjectImpactSchema,
  ProjectsResponseSchema,
  type PublicationDto,
  PublicationsResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { del, get, patch, post, put } from '../client.ts';

/** Active projects: what every picker, the sidebar and the board redirect use. Archived ones never appear here. */
export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: async () => (await get('/projects', ProjectsResponseSchema)).projects,
  });
}

/** Archived projects the user is a member of (the Projects page's Archived section). */
export function useArchivedProjects() {
  return useQuery({
    queryKey: ['projects', 'archived'],
    queryFn: async () => (await get('/projects?status=archived', ProjectsResponseSchema)).projects,
  });
}

/** What archiving the project would stop: shown in the archive confirmation. */
export function useProjectImpact(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['project', id, 'impact'],
    enabled,
    queryFn: () => get<ProjectImpact>(`/projects/${id}/impact`, ProjectImpactSchema),
  });
}

function invalidateAfterLifecycle(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: ['projects'] });
  qc.invalidateQueries({ queryKey: ['project', id] });
  for (const k of ['board', 'card', 'desk', 'schedules', 'agents']) qc.invalidateQueries({ queryKey: [k] });
}

export function useArchiveProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post(`/projects/${id}/archive`, {}),
    onSuccess: () => invalidateAfterLifecycle(qc, id),
  });
}

export function useRestoreProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => post(`/projects/${id}/restore`, {}),
    onSuccess: (_d, id) => invalidateAfterLifecycle(qc, id),
  });
}

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; confirmKey: string }) =>
      post(`/projects/${v.id}/delete`, { confirmKey: v.confirmKey }),
    onSuccess: (_d, v) => {
      invalidateAfterLifecycle(qc, v.id);
      qc.removeQueries({ queryKey: ['project', v.id] });
    },
  });
}

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ['project', id],
    enabled: !!id,
    queryFn: () => get<ProjectDetailResponse>(`/projects/${id}`, ProjectDetailResponseSchema),
    // While a DevOps engineer is cloning a repository or preparing the toolchain, watch it happen.
    refetchInterval: (query) => {
      const d = query.state.data;
      const busy =
        d?.repos?.some((r) => r.setup?.some((s) => s.state === 'cloning')) ||
        d?.environments?.some((e) => e.state === 'preparing');
      return busy ? 3000 : false;
    },
  });
}

/** Try again to put a repository on the project's workstations (clone it, or create it). */
export function useRetryRepoSetup(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => post(`/projects/${projectId}/repos/${repoId}/setup`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });
}

/** Check the development environment of the project on its workstations again. */
export function useCheckEnvironment(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post(`/projects/${projectId}/environment/check`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });
}

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: Partial<CreateProjectRequest> & Pick<CreateProjectRequest, 'key' | 'name'>) =>
      post<{ project: ProjectDto }>('/projects', b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['projects'] }),
  });
}

/** The cached project list in the order `projectIds` names (the other organizations' projects stay after them). */
function reordered(list: ProjectDto[], projectIds: string[]): ProjectDto[] {
  const place = new Map(projectIds.map((id, i) => [id, i + 1]));
  const ranked = list
    .filter((p) => place.has(p.id))
    .sort((a, b) => (place.get(a.id) ?? 0) - (place.get(b.id) ?? 0))
    .map((p) => ({ ...p, rank: place.get(p.id) ?? p.rank }));
  return [...ranked, ...list.filter((p) => !place.has(p.id))];
}

/**
 * Orders the organization's active projects (Owner and Admins). The cached list is reordered at once, in the same tick
 * as the call (so a second key press or drop works on the new order, not the old one), and the saves run one after the
 * other (`scope`). A failure puts the order from before the burst back, and a refetch shows what the server has.
 */
export function useRankProjects() {
  const qc = useQueryClient();
  const before = useRef<ProjectDto[] | undefined>(undefined);
  const inFlight = useRef(0);
  const m = useMutation({
    scope: { id: 'project-ranking' },
    mutationFn: (projectIds: string[]) =>
      put<{ projects: ProjectDto[] }>('/projects/ranking', { projectIds }),
    onError: () => {
      if (before.current) qc.setQueryData(['projects'], before.current);
    },
    onSettled: () => {
      inFlight.current -= 1;
      if (inFlight.current <= 0) {
        before.current = undefined;
        return qc.invalidateQueries({ queryKey: ['projects'] });
      }
    },
  });
  /** Reorders the cached list now and saves; resolves when the save is done, rejects when it failed. */
  const rank = (projectIds: string[]): Promise<unknown> => {
    const current = qc.getQueryData<ProjectDto[]>(['projects']);
    if (current) {
      if (inFlight.current === 0) before.current = current;
      qc.setQueryData<ProjectDto[]>(['projects'], reordered(current, projectIds));
    }
    inFlight.current += 1;
    return m.mutateAsync(projectIds);
  };
  return { rank, isPending: m.isPending, error: m.error };
}

export function usePatchProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: PatchProjectRequest) => patch(`/projects/${id}`, b),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useSetFullSuite(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => put(`/projects/${id}/full-suite`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useSetMergePolicy(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mergeLargeWithoutApproval: boolean) =>
      put(`/projects/${id}/merge-policy`, { mergeLargeWithoutApproval }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['desk'] });
      qc.invalidateQueries({ queryKey: ['card'] });
    },
  });
}

/** The owner picks the reference repositories (the whole list); the project's agents read them read-only. */
export function useSetReferenceRepos(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoIds: string[]) => put(`/projects/${id}/reference-repos`, { repoIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', id] }),
  });
}

/** The optional cap on shifts running at once on a project (null removes it). */
export function useSetConcurrencyCap(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cap: number | null) => put(`/projects/${id}/concurrency-cap`, { cap }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', id] });
      qc.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useAddRepo(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: AddRepoRequest) => post(`/projects/${projectId}/repos`, b),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });
}

export function useRemoveRepo(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => del(`/projects/${projectId}/repos/${repoId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });
}

/** The owner confirms or changes a repository's working branch. */
export function useSetWorkingBranch(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { repoId: string; branch: string }) =>
      put(`/projects/${projectId}/repos/${v.repoId}/working-branch`, { branch: v.branch }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      qc.invalidateQueries({ queryKey: ['desk'] });
    },
  });
}

/** What converting to `toWorkflowKey` would do (the open cards that need a decision, the repositories needed). */
export function useConvertPreview(projectId: string, toWorkflowKey: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['project', projectId, 'convert-preview', toWorkflowKey],
    enabled: enabled && !!toWorkflowKey,
    queryFn: () =>
      get<ConvertPreview>(
        `/projects/${projectId}/convert-preview?toWorkflowKey=${encodeURIComponent(toWorkflowKey ?? '')}`,
        ConvertPreviewSchema,
      ),
  });
}

/** Converts the project (Owner and Admins). The board, desk and project queries all change with it. */
export function useConvertProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: ConvertProjectRequest) => post<ConvertResult>(`/projects/${projectId}/convert`, b),
    onSuccess: () => {
      for (const k of ['projects', 'project', 'board', 'desk', 'card', 'phases', 'workflows'])
        qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

/** Cancels a conversion that waits for its new repositories. */
export function useCancelConversion(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => del(`/projects/${projectId}/convert`),
    onSuccess: () => {
      for (const k of ['projects', 'project', 'desk']) qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

/** The published research notes of a project, newest first (the Research tab). */
export function useProjectPublications(projectId: string | undefined) {
  return useQuery({
    queryKey: ['publications', projectId],
    enabled: !!projectId,
    queryFn: async (): Promise<PublicationDto[]> =>
      (await get(`/research/publications?projectId=${projectId}`, PublicationsResponseSchema)).publications,
  });
}
