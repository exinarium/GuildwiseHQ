import type {
  FindingMark,
  FindingMarkReplayResponse,
  HeldBackFindingsResponse,
  PostedFindingDto,
  PostedFindingsResponse,
  PrReviewDto,
  ReviewerPrecisionResponse,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../client.ts';

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

/** The findings the cap held back on a pull request's latest review. Fetched on request only (`enabled`), then cached. */
export function useHeldBackFindings(prReviewId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['pr-held-back', prReviewId],
    enabled,
    queryFn: () => get<HeldBackFindingsResponse>(`/pr-reviews/${prReviewId}/held-back`),
  });
}

/** The posted findings of a pull request, blind while unmarked. Fetched on request only. */
export function usePostedFindings(prReviewId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['pr-posted-findings', prReviewId],
    enabled,
    queryFn: () => get<PostedFindingsResponse>(`/pr-reviews/${prReviewId}/findings`),
  });
}

/** The owner's mark. No optimistic update: the reviewer comes back only in the server's answer. */
export function useMarkFinding(projectId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; mark: FindingMark }) =>
      put<PostedFindingDto>(`/pr-review-findings/${v.id}/mark`, { mark: v.mark }),
    onSuccess: (dto) => {
      qc.setQueryData<PostedFindingsResponse>(['pr-posted-findings', dto.prReviewId], (old) =>
        old ? { findings: old.findings.map((f) => (f.id === dto.id ? dto : f)) } : old,
      );
      void qc.invalidateQueries({ queryKey: ['pull-requests', projectId] });
      void qc.invalidateQueries({ queryKey: ['reviewer-precision', projectId] });
    },
  });
}

/** Useful findings out of posted findings per reviewer. Fetched when the panel is opened. */
export function useReviewerPrecision(projectId: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['reviewer-precision', projectId],
    enabled: enabled && !!projectId,
    queryFn: () => get<ReviewerPrecisionResponse>(`/projects/${projectId}/reviewer-precision`),
  });
}

/** The marks the 20-PR replay reads (API completeness; no screen shows them). */
export function usePrReviewMarks(projectId: string | undefined, enabled = false) {
  return useQuery({
    queryKey: ['pr-review-marks', projectId],
    enabled: enabled && !!projectId,
    queryFn: () => get<FindingMarkReplayResponse>(`/projects/${projectId}/pr-review-marks`),
  });
}
