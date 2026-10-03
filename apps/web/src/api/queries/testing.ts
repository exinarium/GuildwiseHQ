import type {
  FinalizeCardRequest,
  FinalizeCardResponse,
  RegressionRequest,
  RegressionResponse,
} from '@aom/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { post } from '../client.ts';

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    for (const key of ['card', 'board', 'desk']) void qc.invalidateQueries({ queryKey: [key] });
  };
}

export function useFinalizeCard(cardId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (b: FinalizeCardRequest) => post<FinalizeCardResponse>(`/cards/${cardId}/finalize`, b),
    onSuccess: invalidate,
  });
}

export function useRegression(projectId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (b: RegressionRequest) => post<RegressionResponse>(`/projects/${projectId}/regression`, b),
    onSuccess: invalidate,
  });
}
