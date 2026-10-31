import { ENFORCED_BY_EXPLAIN, ENFORCED_BY_LABEL, type EnforcedBy } from '@aom/shared';
import { MessageSquare, ShieldCheck } from 'lucide-react';
import { Badge } from './ui.tsx';

/** How a rule is held: by a server check, or only as an instruction in the agents' brief. */
export function EnforcedByBadge({ value }: { value: EnforcedBy }) {
  const server = value === 'server_check';
  return (
    <Badge
      tone={server ? 'green' : 'neutral'}
      icon={server ? <ShieldCheck aria-hidden="true" /> : <MessageSquare aria-hidden="true" />}
      title={ENFORCED_BY_EXPLAIN[value]}
      data-testid="enforced-by"
    >
      {ENFORCED_BY_LABEL[value]}
    </Badge>
  );
}
