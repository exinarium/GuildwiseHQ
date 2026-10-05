import { type BoardResponse, BoardResponseSchema } from '@aom/shared';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../client.ts';

/** `phaseId`: one phase's cards, or `none` for the cards without a phase. */
export function useBoard(projectId: string | undefined, phaseId?: string) {
  return useQuery({
    queryKey: ['board', projectId, phaseId ?? 'all'],
    enabled: !!projectId,
    // workstations go offline without an event: keep the 'waiting' warnings honest
    refetchInterval: 30_000,
    queryFn: () => get<BoardResponse>(`/board${qs({ projectId, phaseId })}`, BoardResponseSchema),
  });
}
