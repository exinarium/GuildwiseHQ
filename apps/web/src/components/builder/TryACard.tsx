import type { SimulationResult } from '@aom/shared';
import { Badge } from '../ui.tsx';

export interface TryField {
  key: string;
  label: string;
}

/**
 * "Try a card": the path a card takes through the steps with the answers chosen here. Pure display: the builder
 * owns the simulation, the choices and the highlight on the diagram.
 */
export function TryACard({
  sim,
  yesNoFields,
  values,
  onValue,
  onChoice,
  roleName,
  hiredRoleKeys,
}: {
  /** null: the workflow is not complete enough to walk. */
  sim: SimulationResult | null;
  yesNoFields: readonly TryField[];
  values: Readonly<Record<string, boolean>>;
  onValue: (key: string, v: boolean) => void;
  onChoice: (visit: number, routeId: string | undefined) => void;
  roleName: (key: string) => string;
  hiredRoleKeys?: ReadonlySet<string>;
}) {
  let visit = -1;
  return (
    <section aria-labelledby="try-title" className="flex flex-col gap-2" data-testid="try-a-card">
      <div>
        <h2 id="try-title" className="text-base font-semibold">
          Try a card
        </h2>
        <p className="text-xs text-subtle">See which steps a card goes through and who works on each.</p>
      </div>
      {yesNoFields.length > 0 && (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">The card says</legend>
          {yesNoFields.map((f) => (
            <label key={f.key} className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={values[f.key] === true}
                onChange={(e) => onValue(f.key, e.target.checked)}
              />
              {f.label || f.key}
            </label>
          ))}
        </fieldset>
      )}
      {!sim ? (
        <p className="text-sm text-subtle">Fix the problems listed above to try a card.</p>
      ) : (
        <>
          <ol className="flex flex-col gap-2" data-testid="try-path">
            {sim.steps.map((s, i) => {
              if (!s.skipped) visit += 1;
              const v = visit;
              const picked = s.chosen;
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: a step can be visited more than once
                <li key={`${i}-${s.stageId}`} data-testid={`try-step-${i}`} className="text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{s.label || s.stageId}</span>
                    {s.skipped && <Badge tone="neutral">Skipped for this card</Badge>}
                    {s.kind === 'agent' && s.role && (
                      <span className="text-muted">
                        {roleName(s.role)}
                        {hiredRoleKeys && !hiredRoleKeys.has(s.role) && (
                          <Badge tone="amber" className="ml-1">
                            No one hired for this role
                          </Badge>
                        )}
                      </span>
                    )}
                    {s.kind === 'agent' && !s.role && <Badge tone="amber">No role yet</Badge>}
                    {s.kind === 'manual' && <span className="text-muted">you or the BA</span>}
                    {s.kind === 'terminal' && <Badge tone="green">Done</Badge>}
                  </div>
                  {!s.skipped && s.offered.length > 1 && (
                    <fieldset className="mt-1 flex flex-col gap-1 pl-3">
                      <legend className="sr-only">What happens after {s.label}</legend>
                      {s.offered.map((o) => (
                        <label key={o.id} className="inline-flex items-center gap-2">
                          <input
                            type="radio"
                            name={`try-visit-${i}`}
                            checked={picked === o.id}
                            onChange={() => onChoice(v, o.id)}
                          />
                          {o.kind === 'failure' ? 'Sent back: ' : 'Then: '}
                          {o.label}
                        </label>
                      ))}
                    </fieldset>
                  )}
                </li>
              );
            })}
          </ol>
          {sim.end !== 'finished' && (
            <p className="text-sm text-warning" role="status" data-testid="try-end">
              {sim.end === 'loop'
                ? 'The card keeps coming back to the same step. Choose "then" on a step to move on.'
                : sim.end === 'too_long'
                  ? 'This path is very long.'
                  : (sim.error ?? 'The path stops here.')}
            </p>
          )}
        </>
      )}
    </section>
  );
}
