import { McpServersResponseSchema } from '@aom/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../client.ts';

/** The plugin MCP servers the caller's own workstations report (the role builder's picker). */
export function useMcpServers() {
  return useQuery({
    queryKey: ['mcp-servers'],
    queryFn: async () => (await get('/mcp-servers', McpServersResponseSchema)).servers,
    staleTime: 60_000,
  });
}

/** The organization's Owner grants plugin MCP servers to a project (the whole list of names). */
export function useSetProjectMcpServers(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (servers: string[]) => put(`/projects/${id}/mcp-servers`, { servers }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', id] }),
  });
}
