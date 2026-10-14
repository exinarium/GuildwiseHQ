import { type CommitAsResponse, CommitAsResponseSchema, type SetCommitAsRequest } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../client.ts';

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
