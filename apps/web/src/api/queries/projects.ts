import {
  type AddRepoRequest,
  type CreateProjectRequest,
  type PatchProjectRequest,
  type ProjectDetailResponse,
  ProjectDetailResponseSchema,
  type ProjectDto,
  ProjectsResponseSchema,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, patch, post, put } from '../client.ts';

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: async () => (await get('/projects', ProjectsResponseSchema)).projects,
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
