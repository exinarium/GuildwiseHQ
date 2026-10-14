import { type ArchiveQuery, type ArchiveResponse, ArchiveResponseSchema } from '@aom/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { get, qs } from '../client.ts';

export type ArchiveFilters = Partial<Omit<ArchiveQuery, 'projectId'>>;

/** The archived (done or cancelled, finished more than a day ago) cards of a project, newest first. */
export function useArchive(projectId: string | undefined, filters: ArchiveFilters) {
  return useQuery({
    queryKey: ['archive', projectId, filters],
    enabled: !!projectId,
    placeholderData: keepPreviousData,
    queryFn: () => get<ArchiveResponse>(`/archive${qs({ projectId, ...filters })}`, ArchiveResponseSchema),
  });
}
