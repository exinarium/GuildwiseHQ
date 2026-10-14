import type { IntegrationWorkstationSummary } from '@aom/shared';
import { Link } from 'react-router';
import { Badge, ConnectionDot, Panel } from '../ui.tsx';

/** Several workstations: pick the one whose integrations to manage. The last choice comes first. */
export function WorkstationChooser({
  workstations,
  lastId,
  search,
  onChoose,
}: {
  workstations: IntegrationWorkstationSummary[];
  lastId: string | null;
  /** Kept on the link (`?focus=...`). */
  search: string;
  onChoose: (id: string) => void;
}) {
  const sorted = [...workstations].sort((a, b) => Number(b.id === lastId) - Number(a.id === lastId));
  return (
    <ul className="flex flex-col gap-3" data-testid="workstation-chooser">
      {sorted.map((w) => (
        <li key={w.id}>
          <Panel>
            <Link
              to={`/workstations/${w.id}/integrations${search}`}
              onClick={() => onChoose(w.id)}
              className="flex flex-wrap items-center gap-3 rounded-control focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
              data-testid={`choose-${w.id}`}
            >
              <span className="min-w-0 flex-1 text-lg font-semibold text-fg">{w.name}</span>
              {w.id === lastId && <span className="text-xs text-subtle">Last used</span>}
              <ConnectionDot connected={w.connected} label={w.connected ? 'Online' : 'Offline'} />
              {w.needsAttention > 0 ? (
                <Badge tone="amber" data-testid="needs-attention">
                  {w.needsAttention} need{w.needsAttention === 1 ? 's' : ''} attention
                </Badge>
              ) : (
                <Badge tone="green">All fine</Badge>
              )}
            </Link>
          </Panel>
        </li>
      ))}
    </ul>
  );
}
