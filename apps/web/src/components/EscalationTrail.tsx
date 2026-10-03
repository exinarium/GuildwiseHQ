import type { DeskItemDto } from '@aom/shared';
import { trailLabel } from '../lib/intake.ts';

/** Who looked at a question on its way to the desk (docs/ARCHITECTURE.md section 15): asker, senior peer, BA, desk. */
export function EscalationTrail({ item }: { item: Pick<DeskItemDto, 'escalationTrail'> }) {
  const steps = item.escalationTrail ?? [];
  if (steps.length < 2) return null;
  return (
    <div className="mt-2 text-xs text-zinc-600 dark:text-zinc-400" data-testid="escalation-trail">
      <p className="font-medium">Escalation trail</p>
      <ol className="mt-1 flex flex-wrap items-baseline gap-x-1 gap-y-0.5">
        {steps.map((s, i) => (
          <li
            key={`${s.step}-${s.at}-${s.agentId ?? 'x'}-${s.note ?? ''}`}
            data-testid="trail-step"
            data-step={s.step}
            className="flex items-baseline gap-1"
          >
            {i > 0 && <span aria-hidden="true">→</span>}
            <span title={s.note}>
              {trailLabel(s)}
              {s.note ? <span className="text-zinc-500">: {s.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
