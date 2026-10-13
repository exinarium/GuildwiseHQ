import { type AgentDto, type McpServerCandidateDto, mcpServerWarning } from '@aom/shared';
import { Link } from 'react-router';
import { usePatchAgent } from '../../api/queries/hr.ts';
import { Callout, ErrorBox } from '../ui.tsx';

/**
 * "External tools (MCP)" of one hired agent: the plugin MCP servers (Jira, Confluence, ...) the agent may call. The
 * agent needs this permission AND the project must have the server granted (project settings). Everyone who sees the
 * agent reads the switches; only the organization Owner changes them. Servers that can write, send or delete carry the
 * same warning as the project panel. The list is what the Owner's workstations report plus whatever the agent has.
 */
export function AgentMcpSection({
  agent,
  candidates,
  canEdit,
  projectSettingsTo,
}: {
  agent: AgentDto;
  candidates: readonly McpServerCandidateDto[];
  canEdit: boolean;
  /** Where the project's MCP grant is changed. */
  projectSettingsTo?: string;
}) {
  const patch = usePatchAgent();
  const has = (agent.permissions.allowedTools ?? [])
    .filter((t) => t.startsWith('mcp:'))
    .map((t) => t.slice(4));
  const byName = new Map(candidates.map((c) => [c.name, c]));
  const names = [...new Set([...candidates.map((c) => c.name), ...has])].sort();
  if (names.length === 0 && !canEdit) return null;

  const toggle = (name: string, on: boolean) => {
    const rest = (agent.permissions.allowedTools ?? []).filter((t) => t !== `mcp:${name}`);
    patch.mutate({
      id: agent.id,
      changes: {
        permissions: {
          ...agent.permissions,
          allowedTools: on ? [...rest, `mcp:${name}`] : rest,
        },
      },
    });
  };

  return (
    <section className="rounded-control border border-line px-3 py-2" data-testid="agent-mcp">
      <h3 className="text-sm font-semibold text-fg">External tools (MCP)</h3>
      <p className="mt-1 text-xs text-muted">
        Tools from your Claude Code plugins, such as Jira or Confluence. {agent.name} can use a tool only when
        it is switched on here and the server is also granted to the project
        {projectSettingsTo ? (
          <>
            {' '}
            (
            <Link to={projectSettingsTo} className="text-brand-text hover:underline">
              project settings
            </Link>
            )
          </>
        ) : (
          ' (Project settings, MCP servers)'
        )}
        . {agent.name} works with the same access the Owner has in those tools.
      </p>
      {names.length === 0 ? (
        <p className="mt-2 text-xs text-subtle" data-testid="agent-mcp-none">
          No plugin MCP servers found. Install and enable a Claude Code plugin that provides one on a
          connected workstation.
        </p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {names.map((name) => {
            const c = byName.get(name);
            const on = has.includes(name);
            const w = mcpServerWarning(c?.tools ?? undefined);
            return (
              <li key={name} className="text-sm" data-testid={`agent-mcp-${name}`}>
                <label className="flex items-center gap-2.5 font-medium text-fg">
                  <input
                    type="checkbox"
                    role="switch"
                    aria-checked={on}
                    className="size-4"
                    checked={on}
                    disabled={!canEdit || patch.isPending}
                    onChange={(e) => toggle(name, e.target.checked)}
                  />
                  <span>{c ? `${c.plugin} / ${c.server}` : name}</span>
                </label>
                <p className="ml-6.5 text-xs text-muted" data-testid={`agent-mcp-warning-${name}`}>
                  {w.text}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {names.some((n) => mcpServerWarning(byName.get(n)?.tools ?? undefined).level !== 'read_only') && (
        <Callout tone="warning" className="mt-2" data-testid="agent-mcp-advice">
          Prefer read-only use. A server that can write, send or delete lets this agent change data in the
          connected service as you.
        </Callout>
      )}
      {!canEdit && (
        <p className="mt-2 text-xs text-subtle" data-testid="agent-mcp-owner-only">
          Only the organization Owner can change an agent's external tools.
        </p>
      )}
      <ErrorBox error={patch.error} />
    </section>
  );
}
