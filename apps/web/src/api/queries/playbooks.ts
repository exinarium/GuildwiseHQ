import {
  type PlaybookGrantsDto,
  PlaybookGrantsDtoSchema,
  type PlaybookRunRequest,
  type SlashCommandsResponse,
  SlashCommandsResponseSchema,
  type SlashContext,
} from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, put } from '../client.ts';

/** The playbooks and skills the `/` menu offers in this place. Cheap and stable: kept for a minute. */
export function useSlashCommands(
  context: SlashContext,
  opts: { enabled?: boolean; projectId?: string; agentId?: string } = {},
) {
  return useQuery({
    enabled: opts.enabled ?? true,
    staleTime: 60_000,
    queryKey: ['slash-commands', context, opts.projectId ?? null, opts.agentId ?? null],
    queryFn: (): Promise<SlashCommandsResponse> =>
      get(
        `/slash-commands?context=${context}${opts.projectId ? `&projectId=${opts.projectId}` : ''}${opts.agentId ? `&agentId=${opts.agentId}` : ''}`,
        SlashCommandsResponseSchema,
      ),
  });
}

/** Starts a guided session on a playbook; the caller goes to `path`. */
export function useRunPlaybook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (req: PlaybookRunRequest) => post<{ threadId: string; path: string }>('/playbooks/run', req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
}

/** The playbooks an agent may start itself (off by default). */
export function usePlaybookGrants(agentId: string) {
  return useQuery({
    queryKey: ['playbook-grants', agentId],
    queryFn: (): Promise<PlaybookGrantsDto> =>
      get(`/agents/${agentId}/playbook-grants`, PlaybookGrantsDtoSchema),
  });
}

export function useSetPlaybookGrant(agentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { key: string; granted: boolean }) =>
      put<PlaybookGrantsDto>(`/agents/${agentId}/playbook-grants`, v),
    onSuccess: (data) => qc.setQueryData(['playbook-grants', agentId], data),
  });
}
