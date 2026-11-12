import type { PrReviewDto } from '@aom/shared';
import { useQuery } from '@tanstack/react-query';
import { get } from '../client.ts';

/** The recorded pull requests of a PR-only project with their review state. Polls while a run or a post is open. */
export function usePullRequests(projectId: string | undefined) {
  return useQuery({
    queryKey: ['pull-requests', projectId],
    enabled: !!projectId,
    queryFn: () => get<{ pullRequests: PrReviewDto[] }>(`/projects/${projectId}/pull-requests`),
    refetchInterval: (query) =>
      query.state.data?.pullRequests.some((p) => p.lastRun?.state === 'running' || p.lastRun?.state === 'completed')
        ? 30_000
        : false,
  });
}
