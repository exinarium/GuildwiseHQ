import {
  type CommitAsResponse,
  CommitAsResponseSchema,
  type SetCommitAsRequest,
  type SetPostAsRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../client.ts';

/** "Commit as" of a project and the identity each workstation clone would commit with (backlog #65). */
export function useCommitAs(projectId: string | undefined) {
  return useQuery({
    enabled: !!projectId,
    queryKey: ['commit-as', projectId],
    queryFn: () => get<CommitAsResponse>(`/projects/${projectId}/commit-as`, CommitAsResponseSchema),
  });
}

export function useSaveCommitAs(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: SetCommitAsRequest) =>
      put<CommitAsResponse>(`/projects/${projectId}/commit-as`, v, CommitAsResponseSchema),
    onSuccess: (data) => qc.setQueryData(['commit-as', projectId], data),
  });
}

/** Ticks the apps a project posts as (organization Owner or Admin); answers with the whole Commit as response. */
export function useSavePostAs(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: SetPostAsRequest) =>
      put<CommitAsResponse>(`/projects/${projectId}/post-as`, v, CommitAsResponseSchema),
    onSuccess: (data) => qc.setQueryData(['commit-as', projectId], data),
  });
}

/** Re-runs the access checks of the selected apps. */
export function useRecheckPostAs(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<unknown>(`/projects/${projectId}/post-as/check`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['commit-as', projectId] }),
  });
}
