import {
  type ProjectWorkflowsResponse,
  ProjectWorkflowsResponseSchema,
  type SetProjectWorkflowsRequest,
  type SubmitResponse,
  type VariantDraftResponse,
  type WorkflowVariantRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { del, get, post, put } from '../client.ts';

/** The workflows a project has enabled and the ones it could (with its variants). */
export function useProjectWorkflows(projectId: string | undefined) {
  return useQuery({
    queryKey: ['project', projectId, 'workflows'],
    enabled: !!projectId,
    queryFn: () =>
      get<ProjectWorkflowsResponse>(`/projects/${projectId}/workflows`, ProjectWorkflowsResponseSchema),
  });
}

function useWorkflowsMutation<V, R>(projectId: string, fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['project', projectId, 'workflows'] });
      for (const k of ['workflows', 'board', 'desk', 'org']) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

export const useSetProjectWorkflows = (projectId: string) =>
  useWorkflowsMutation(projectId, (body: SetProjectWorkflowsRequest) =>
    put<ProjectWorkflowsResponse>(`/projects/${projectId}/workflows`, body, ProjectWorkflowsResponseSchema),
  );

/** Saves a variant draft: a new one, or (with `id`) a change to the open draft. The answer carries the issues. */
export const useSaveVariantDraft = (projectId: string) =>
  useWorkflowsMutation(projectId, (v: { id?: string; spec: WorkflowVariantRequest }) =>
    v.id
      ? put<VariantDraftResponse>(`/projects/${projectId}/workflow-variants/${v.id}`, v.spec)
      : post<VariantDraftResponse>(`/projects/${projectId}/workflow-variants`, v.spec),
  );

export const useSubmitVariant = (projectId: string) =>
  useWorkflowsMutation(projectId, (id: string) =>
    post<SubmitResponse>(`/projects/${projectId}/workflow-variants/${id}/submit`),
  );

export const useRebaseVariant = (projectId: string) =>
  useWorkflowsMutation(projectId, (id: string) =>
    post<VariantDraftResponse>(`/projects/${projectId}/workflow-variants/${id}/rebase`),
  );

export const useDiscardVariant = (projectId: string) =>
  useWorkflowsMutation(projectId, (id: string) => del(`/projects/${projectId}/workflow-variants/${id}`));
