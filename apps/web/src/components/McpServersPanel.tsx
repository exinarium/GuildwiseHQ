import { type McpServerCandidateDto, mcpServerWarning } from '@aom/shared';
import { useState } from 'react';
import { useSetProjectMcpServers } from '../api/queries/mcp.ts';
import { Badge, Button, Callout, ErrorBox, Panel, Select } from './ui.tsx';

const TRANSPORT: Record<string, string> = { stdio: 'runs on the workstation', http: 'remote', sse: 'remote' };

/**
 * "MCP servers": external tools from the Claude Code plugins on the Owner's workstations that this project's agents may
 * use. Two keys are needed: the organization's Owner grants the server to the project here, and a role must also have the
 * server in its tool permissions. Only the Owner changes the list; everyone on the project reads it. Servers whose tools
 * can write, send or delete carry a warning (judged from the tool names when known, else a general one).
 */
export function McpServersPanel({
  projectId,
  granted,
  candidates,
  canGrant,
}: {
  projectId: string;
  granted: readonly string[];
  candidates: readonly McpServerCandidateDto[];
  canGrant: boolean;
}) {
  const set = useSetProjectMcpServers(projectId);
  const [pick, setPick] = useState('');
  const byName = new Map(candidates.map((c) => [c.name, c]));
  const available = candidates.filter((c) => !granted.includes(c.name));
  const save = (servers: string[], onSuccess?: () => void) =>
    set.mutate(servers, onSuccess ? { onSuccess } : {});
  const describe = (name: string) => {
    const c = byName.get(name);
    return {
      title: c ? `${c.plugin} / ${c.server}` : name,
      detail: c
        ? `${c.transport === 'stdio' ? 'local server' : `remote, ${c.host ?? 'unknown host'}`}`
        : null,
      warning: mcpServerWarning(c?.tools ?? undefined),
    };
  };

  return (
    <Panel>
      <h2 className="mb-3 text-lg font-semibold text-fg">MCP servers</h2>
      <p className="text-sm text-muted">
        External tools this project's agents may use, such as Jira or Confluence, taken from the Claude Code
        plugins installed on your workstation. Two things are needed: you grant the server to this project
        here, and a role must also have it in its tool permissions (Organization, Roles). Agents work with the
        same access you have: they use your signed-in plugin, so what they can reach is what you can reach.
        Only the organization Owner can grant a server.
      </p>
      <Callout tone="warning" className="mt-3" data-testid="mcp-advice">
        Prefer read-only use. A server whose tools can write, send or delete lets an agent change data in the
        connected service as you. Grant such a server only to a project and roles you trust with that. The
        tools agents call are listed on each card.
      </Callout>
      {granted.length === 0 ? (
        <p className="mt-3 text-sm text-subtle" data-testid="mcp-servers-empty">
          No MCP servers granted: this project's agents have no external tools.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col gap-3" data-testid="mcp-servers">
          {granted.map((name) => {
            const d = describe(name);
            return (
              <li key={name} className="flex flex-col gap-1 text-sm" data-testid={`mcp-server-${name}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{d.title}</span>
                  <span className="font-mono text-xs text-subtle">mcp:{name}</span>
                  {d.detail && <span className="text-xs text-subtle">{d.detail}</span>}
                  <Badge tone={d.warning.level === 'read_only' ? 'success' : 'warning'}>
                    {d.warning.level === 'writes'
                      ? 'Can write'
                      : d.warning.level === 'unknown'
                        ? 'Tools unknown'
                        : 'Looks read-only'}
                  </Badge>
                  {canGrant && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={set.isPending}
                      aria-label={`Remove ${d.title}`}
                      onClick={() => save(granted.filter((n) => n !== name))}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted" data-testid={`mcp-warning-${name}`}>
                  {d.warning.text}
                </p>
              </li>
            );
          })}
        </ul>
      )}
      {canGrant &&
        (available.length === 0 ? (
          <p className="mt-3 text-xs text-subtle" data-testid="mcp-servers-none-left">
            {candidates.length === 0
              ? 'No plugin MCP servers found. Install and enable a Claude Code plugin that provides one on a connected workstation (the runner reports them every few minutes).'
              : 'Every server your workstations offer is already granted.'}
          </p>
        ) : (
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (pick) save([...granted, pick], () => setPick(''));
            }}
          >
            <Select label="Grant an MCP server" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Choose a server...</option>
              {available.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.plugin} / {c.server} ({TRANSPORT[c.transport] ?? c.transport}; on{' '}
                  {c.workstations.join(', ')})
                </option>
              ))}
            </Select>
            <Button type="submit" disabled={!pick || set.isPending}>
              Grant
            </Button>
          </form>
        ))}
      {!canGrant && (
        <p className="mt-3 text-xs text-subtle" data-testid="mcp-owner-only">
          Only the organization Owner can grant or remove MCP servers.
        </p>
      )}
      <ErrorBox error={set.error} />
    </Panel>
  );
}
