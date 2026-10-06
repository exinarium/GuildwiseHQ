import type { DeskItemDto } from '@aom/shared';
import { ChevronRight } from 'lucide-react';
import { trailLabel } from '../lib/intake.ts';

/** Who looked at a question on its way to the desk (docs/ARCHITECTURE.md section 15): asker, senior peer, BA, desk. */
export function EscalationTrail({ item }: { item: Pick<DeskItemDto, 'escalationTrail'> }) {
  const steps = item.escalationTrail ?? [];
  if (steps.length < 2) return null;
  return (
    <div
      className="mt-3 rounded-control bg-sunken px-3 py-2 text-sm text-muted"
      data-testid="escalation-trail"
    >
      <p className="text-xs font-medium text-subtle">Escalation trail</p>
      <ol className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {steps.map((s, i) => (
          <li
            key={`${s.step}-${s.at}-${s.agentId ?? 'x'}-${s.note ?? ''}`}
            data-testid="trail-step"
            data-step={s.step}
            className="flex items-center gap-1"
          >
            {i > 0 && <ChevronRight aria-hidden="true" className="size-3.5 text-subtle" />}
            <span title={s.note}>
              {trailLabel(s)}
              {s.note ? <span className="text-subtle">: {s.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
