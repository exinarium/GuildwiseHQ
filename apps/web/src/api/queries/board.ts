import { type BoardResponse, BoardResponseSchema } from '@aom/shared';
import { useQuery } from '@tanstack/react-query';
import { get, qs } from '../client.ts';

export function useBoard(projectId: string | undefined) {
  return useQuery({
    queryKey: ['board', projectId],
    enabled: !!projectId,
    queryFn: () => get<BoardResponse>(`/board${qs({ projectId })}`, BoardResponseSchema),
  });
}
