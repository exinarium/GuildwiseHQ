import type {
  BacklogFilter,
  BacklogItemDto,
  BacklogSendResult,
  CreateBacklogItemRequest,
  PatchBacklogItemRequest,
} from '@aom/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, patch, post, qs } from '../client.ts';

/** What the page asks for: the server filters and sorts (the rules live there), the page shows what comes back. */
export type BacklogQuery = Partial<{
  status: string[];
  priority: string[];
  tag: string[];
  flagged: boolean;
  source: 'owner' | 'agent';
  q: string;
  sort: BacklogFilter['sort'];
}>;

export interface BacklogList {
  items: BacklogItemDto[];
  tags: string[];
}

export function backlogQueryString(f: BacklogQuery): string {
  return qs({
    status: f.status?.length ? f.status.join(',') : undefined,
    priority: f.priority?.length ? f.priority.join(',') : undefined,
    tag: f.tag?.length ? f.tag.join(',') : undefined,
    flagged: f.flagged ? 'true' : undefined,
    source: f.source,
    q: f.q?.trim() || undefined,
    sort: f.sort,
  });
}

export function useBacklog(projectId: string | undefined, filter: BacklogQuery) {
  return useQuery({
    queryKey: ['backlog', projectId, filter],
    enabled: !!projectId,
    placeholderData: keepPreviousData,
    queryFn: () => get<BacklogList>(`/projects/${projectId}/backlog${backlogQueryString(filter)}`),
  });
}

function useBacklogMutation<V, R>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    // A send makes a card: the board and the desk change too.
    onSettled: () => {
      for (const key of ['backlog', 'board', 'card', 'desk']) void qc.invalidateQueries({ queryKey: [key] });
    },
  });
}

export const useAddBacklogItem = (projectId: string | undefined) =>
  useBacklogMutation((req: Partial<CreateBacklogItemRequest> & { title: string }) =>
    post<{ item: BacklogItemDto }>(`/projects/${projectId}/backlog`, req),
  );

export const useEditBacklogItem = () =>
  useBacklogMutation((v: { id: string; patch: PatchBacklogItemRequest }) =>
    patch<{ item: BacklogItemDto }>(`/backlog/${v.id}`, v.patch),
  );

export const useDropBacklogItem = () =>
  useBacklogMutation((id: string) => post<{ item: BacklogItemDto }>(`/backlog/${id}/drop`));

/** One item or several: always the bulk endpoint's shape, one result per item. */
export const useSendBacklog = () =>
  useBacklogMutation(async (itemIds: string[]) => {
    if (itemIds.length === 1) {
      const id = itemIds[0] as string;
      const r = await post<{ result: BacklogSendResult }>(`/backlog/${id}/send`);
      return { results: [r.result] };
    }
    return post<{ results: BacklogSendResult[] }>('/backlog/send', { itemIds });
  });
