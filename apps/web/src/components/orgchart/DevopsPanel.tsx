import type { OrgChart, OrgChartAgent } from '@aom/shared';
import { Server } from 'lucide-react';
import { Badge, Panel } from '../ui.tsx';
import { AgentTile } from './AgentTile.tsx';

/** The DevOps engineer of each workstation: not part of the escalation tree, so shown apart (one per machine). */
export function DevopsPanel({ chart, onOpen }: { chart: OrgChart; onOpen: (a: OrgChartAgent) => void }) {
  const byId = new Map(chart.agents.map((a) => [a.id, a]));
  if (chart.workstations.length === 0) return null;
  return (
    <Panel title="Workstations and DevOps" data-testid="org-devops">
      <p className="mb-3 text-sm text-muted">
        Every workstation has its own DevOps engineer. It looks after that machine and reports to the
        manager's desk, not to the BA.
      </p>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {chart.workstations.map((w) => {
          const dev = w.devopsAgentId ? byId.get(w.devopsAgentId) : undefined;
          return (
            <li
              key={w.id}
              className="flex flex-col gap-2 rounded-card border border-line bg-sunken/50 p-3"
              data-testid="org-workstation"
            >
              <div className="flex items-center gap-2 text-sm">
                <Server aria-hidden="true" className="size-4 text-muted" />
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{w.name}</span>
                <Badge tone={w.online ? 'green' : 'neutral'}>{w.online ? 'Online' : 'Offline'}</Badge>
              </div>
              <p className="text-xs text-subtle">
                {w.ownerName}'s machine, {w.agentIds.length} agent{w.agentIds.length === 1 ? '' : 's'}
              </p>
              {dev ? (
                <AgentTile
                  agent={dev}
                  onOpen={onOpen}
                  escalation={`${chart.owner.name}, on the desk`}
                  className="w-full"
                />
              ) : (
                <p className="rounded-control border border-dashed border-control p-2.5 text-sm text-muted">
                  No DevOps engineer here yet.
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
