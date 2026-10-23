import { DISCOVERY_PHASE_LABEL, DISCOVERY_PHASES, type DiscoveryPhase, phaseIndex } from '@aom/shared';
import { Check } from 'lucide-react';
import { cx } from '../ui/cx.ts';

/**
 * The five phases of a discovery session. The facilitator moves the session on; the owner can click any phase to override
 * it (the facilitator is told). On a phone the labels shrink and the row scrolls.
 */
export function PhaseStepper({
  phase,
  onSelect,
  disabled,
}: {
  phase: DiscoveryPhase;
  onSelect?: (p: DiscoveryPhase) => void;
  disabled?: boolean;
}) {
  const cur = phaseIndex(phase);
  return (
    <nav aria-label="Phase" data-testid="phase-stepper" className="-mx-1 overflow-x-auto px-1">
      <ol className="flex min-w-max gap-1.5">
        {DISCOVERY_PHASES.map((p, i) => {
          const done = i < cur;
          const active = i === cur;
          return (
            <li key={p}>
              <button
                type="button"
                disabled={disabled || !onSelect || active}
                aria-current={active ? 'step' : undefined}
                aria-label={`${DISCOVERY_PHASE_LABEL[p]}${active ? ' (current phase)' : done ? ' (done)' : ''}`}
                data-testid={`phase-${p}`}
                onClick={() => onSelect?.(p)}
                className={cx(
                  'inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium whitespace-nowrap transition-colors md:text-sm [@media(pointer:coarse)]:h-10',
                  active
                    ? 'border-brand bg-brand-soft text-brand-soft-fg'
                    : done
                      ? 'border-line bg-sunken text-muted hover:text-fg'
                      : 'border-line bg-surface text-subtle hover:text-fg',
                )}
              >
                {done ? (
                  <Check aria-hidden="true" className="size-3.5" />
                ) : (
                  <span className="tnum text-[11px] opacity-70">{i + 1}</span>
                )}
                {DISCOVERY_PHASE_LABEL[p]}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
