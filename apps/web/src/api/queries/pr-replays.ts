import type {
  FindingMark,
  PostedFindingDto,
  ProjectDetailResponse,
  ReplayDto,
  ReplayFindingStep,
  SetReviewTargetsRequest,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../client.ts';

const active = (r: ReplayDto | undefined) => r?.state === 'listing' || r?.state === 'reviewing';

export function useReplays(projectId: string | undefined) {
  return useQuery({
    queryKey: ['pr-replays', projectId],
    enabled: !!projectId,
    queryFn: () => get<{ replays: ReplayDto[] }>(`/projects/${projectId}/pr-replays`),
  });
}

/** One replay. Refetches every 30 s while the reviews run. */
export function useReplay(replayId: string | undefined) {
  return useQuery({
    queryKey: ['pr-replay', replayId],
    enabled: !!replayId,
    queryFn: () => get<ReplayDto>(`/pr-replays/${replayId}`),
    refetchInterval: (q) => (active(q.state.data) ? 30_000 : false),
  });
}

export function useStartReplay(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repoId: string) => post<ReplayDto>(`/projects/${projectId}/pr-replays`, { repoId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pr-replays', projectId] }),
  });
}

export function useNextReplayFinding(replayId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['pr-replay-next', replayId],
    enabled,
    queryFn: () => get<{ next: ReplayFindingStep | null }>(`/pr-replays/${replayId}/next-finding`),
  });
}

export function useReplayFindings(replayId: string, enabled: boolean, held = false) {
  return useQuery({
    queryKey: ['pr-replay-findings', replayId, held],
    enabled,
    queryFn: () =>
      get<{ findings: PostedFindingDto[] }>(`/pr-replays/${replayId}/findings${held ? '?held=1' : ''}`),
  });
}

/** The owner's mark. No optimistic update: the next finding is loaded from the server. */
export function useMarkReplayFinding(replayId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; mark: FindingMark }) =>
      put<{ finding: PostedFindingDto; replay: ReplayDto }>(`/pr-replay-findings/${v.id}/mark`, {
        mark: v.mark,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['pr-replay', replayId] });
      void qc.invalidateQueries({ queryKey: ['pr-replay-next', replayId] });
      void qc.invalidateQueries({ queryKey: ['pr-replay-findings', replayId] });
    },
  });
}

/** Tells the server the finding is on screen (the effort clock). */
export function useRecordShown() {
  return useMutation({
    mutationFn: (findingId: string) => post<void>(`/pr-replay-findings/${findingId}/shown`),
  });
}

export function useCancelReplay(replayId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<ReplayDto>(`/pr-replays/${replayId}/cancel`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pr-replay', replayId] }),
  });
}

export function useRetryReplay(replayId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => post<ReplayDto>(`/pr-replays/${replayId}/retry-failed`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['pr-replay', replayId] }),
  });
}

export function useSetReviewTargets(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: SetReviewTargetsRequest) =>
      put<ProjectDetailResponse>(`/projects/${projectId}/review-targets`, v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['project', projectId] }),
  });
}
