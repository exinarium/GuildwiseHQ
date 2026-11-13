import type { PrReviewDto, PrReviewQueueDto } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../client.ts';

/** The recorded pull requests of a PR-only project with their review state. Polls while a run or a post is open. */
export function usePullRequests(projectId: string | undefined) {
  return useQuery({
    queryKey: ['pull-requests', projectId],
    enabled: !!projectId,
    queryFn: () => get<{ pullRequests: PrReviewDto[] }>(`/projects/${projectId}/pull-requests`),
    refetchInterval: (query) =>
      query.state.data?.pullRequests.some(
        (p) => p.lastRun?.state === 'running' || p.lastRun?.state === 'completed',
      )
        ? 30_000
        : false,
  });
}

/** Today's used count and the queue of waiting pull requests in run order. */
export function usePrReviewQueue(projectId: string | undefined) {
  return useQuery({
    queryKey: ['pr-review-queue', projectId],
    enabled: !!projectId,
    queryFn: () => get<PrReviewQueueDto>(`/projects/${projectId}/pull-requests/queue`),
    refetchInterval: 30_000,
  });
}

/** The owner starts a review by hand: it goes past the daily cap and is not counted. */
export function useTriggerPrReview(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (prReviewId: string) => post(`/projects/${projectId}/pull-requests/${prReviewId}/review`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pull-requests', projectId] });
      qc.invalidateQueries({ queryKey: ['pr-review-queue', projectId] });
    },
  });
}

/** The project's daily cap on automatic reviews. */
export function useSetPrReviewCap(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cap: number) => put(`/projects/${projectId}/pr-review-cap`, { cap }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['project', projectId] });
      qc.invalidateQueries({ queryKey: ['projects'] });
      qc.invalidateQueries({ queryKey: ['pr-review-queue', projectId] });
    },
  });
}
