import { ProjectGraphStatusSchema } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../client.ts';

/**
 * The status of a project's code graph (counts and the indexed commit). There is no graph view and nothing derived from
 * code reaches the browser (docs/design/project-graphs.md owner decision 5).
 */
export const projectGraphKey = (id: string) => ['project-graph', id] as const;

export function useProjectGraph(id: string) {
  return useQuery({
    queryKey: projectGraphKey(id),
    queryFn: () => get(`/projects/${id}/graph`, ProjectGraphStatusSchema),
    retry: false,
    // an index takes seconds to minutes: look again while one is waiting
    refetchInterval: (q) => (q.state.data?.repos.some((r) => r.status === 'requested') ? 4000 : false),
  });
}

export function useReindexProjectGraph(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<{ queued: number }>(`/projects/${id}/graph/index`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectGraphKey(id) }),
  });
}
