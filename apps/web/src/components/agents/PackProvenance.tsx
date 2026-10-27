import type { AgentDto } from '@aom/shared';
import { Badge } from '../ui.tsx';

/**
 * Where an agent hired from a pack came from. A persona turned into a role reads `ACME · analyst · v1.2.0`; an agent hired onto
 * a seat reads `Amelia · BMAD agent` (the pack agent it works as; its seat is its role, shown with the agent). Either way a
 * warning shows when the pack lost its approval or was removed.
 */
export function PackProvenance({ agent }: { agent: Pick<AgentDto, 'provenance' | 'packAgent'> }) {
  const p = agent.provenance;
  const pa = agent.packAgent;
  if (!p && !pa) return null;
  const warning = p?.warning ?? null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="pack-provenance">
      {pa ? (
        <Badge
          tone="violet"
          data-testid="pack-agent-tag"
          title={`Works as ${pa.name}, an agent of the pack ${pa.packName}. Its role decides what it may do.`}
        >
          {pa.name} · {pa.packName} agent
        </Badge>
      ) : (
        p && (
          <Badge tone="violet" title={`Hired from the pack ${p.packName}`}>
            {p.label}
          </Badge>
        )
      )}
      {warning && (
        <Badge
          tone="amber"
          data-testid="pack-provenance-warning"
          title={
            warning === 'missing'
              ? 'A pack update dropped this agent. It keeps working as before, but the pack no longer describes it.'
              : 'The agent keeps its role version and its work'
          }
        >
          {warning === 'removed'
            ? 'pack removed'
            : warning === 'missing'
              ? 'no longer in the pack'
              : 'pack no longer approved'}
        </Badge>
      )}
    </span>
  );
}
