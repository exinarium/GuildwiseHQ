import { type BoardResponse, BoardResponseSchema } from '@aom/shared';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../client.ts';

export function useBoard(projectId: string | undefined) {
  return useQuery({
    queryKey: ['board', projectId],
    enabled: !!projectId,
    // workstations go offline without an event: keep the 'waiting' warnings honest
    refetchInterval: 30_000,
    queryFn: () => get<BoardResponse>(`/board${qs({ projectId })}`, BoardResponseSchema),
  });
}
