import {
  type AddRepoRequest,
  type CreateProjectRequest,
  type PatchProjectRequest,
  type ProjectDetailResponse,
  ProjectDetailResponseSchema,
  type ProjectDto,
  type ProjectImpact,
  ProjectImpactSchema,
  ProjectsResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
