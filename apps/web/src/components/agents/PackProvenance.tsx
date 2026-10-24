import type { AgentDto } from '@aom/shared';
import { Badge } from '../ui.tsx';

/** Where an agent hired from a pack persona came from (`ACME · analyst · v1.2.0`), and a warning when the pack lost its approval. */
export function PackProvenance({ agent }: { agent: Pick<AgentDto, 'provenance'> }) {
  const p = agent.provenance;
  if (!p) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid="pack-provenance">
      <Badge tone="violet" title={`Hired from the pack ${p.packName}`}>
        {p.label}
      </Badge>
      {p.warning && (
        <Badge
          tone="amber"
          data-testid="pack-provenance-warning"
          title="The agent keeps its role version and its work"
        >
          {p.warning === 'removed' ? 'pack removed' : 'pack no longer approved'}
        </Badge>
      )}
    </span>
  );
}
