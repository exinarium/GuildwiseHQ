import type { DiscoveryStateDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { usePatchDiscovery } from '../../api/queries/discovery.ts';
import { formatUsd } from '../../lib/discovery.ts';
import { cx } from '../ui/cx.ts';
import { Button, TextInput } from '../ui.tsx';

/** The session's running cost, its time box and (if set) its budget. The budget is a stop: no turn starts past it. */
export function CostMeter({ state, canManage }: { state: DiscoveryStateDto; canManage: boolean }) {
  const { cost, progress, config } = state;
  const patch = usePatchDiscovery(state.threadId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(cost.budgetUsd ? String(cost.budgetUsd) : '');
  const ratio = cost.budgetUsd ? Math.min(1, cost.costUsd / cost.budgetUsd) : null;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    patch.mutate({ budgetUsd: value.trim() === '' ? null : n }, { onSuccess: () => setEditing(false) });
  };
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" data-testid="session-meters">
      <div className="min-w-[8rem]" data-testid="meter-cost">
        <p className="text-xs text-subtle">Cost so far</p>
        <p className="tnum font-medium text-fg">
          {formatUsd(cost.costUsd)}
          {cost.budgetUsd !== null && <span className="text-muted"> of {formatUsd(cost.budgetUsd)}</span>}
        </p>
        {cost.unpricedTurns > 0 && (
          <p className="text-xs text-warning" data-testid="cost-unknown">
            Cost unknown for {cost.unpricedTurns} {cost.unpricedTurns === 1 ? 'turn' : 'turns'} (no price for
            that model), not counted above.
          </p>
        )}
        {ratio !== null && (
          <div
            role="progressbar"
            aria-label="Budget used"
            aria-valuenow={Math.round(ratio * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-sunken"
          >
            <div
              className={cx(
                'h-full',
                ratio >= 1 ? 'bg-danger-fill' : ratio > 0.8 ? 'bg-warning-fill' : 'bg-brand',
              )}
              style={{ width: `${ratio * 100}%` }}
            />
          </div>
        )}
      </div>
      <div className="min-w-[8rem]" data-testid="meter-time">
        <p className="text-xs text-subtle">Time</p>
        <p className="tnum font-medium text-fg">
          {progress.elapsedMinutes} min
          {config.timeBoxMinutes !== null && <span className="text-muted"> of {config.timeBoxMinutes}</span>}
        </p>
        {progress.fraction !== null && (
          <div
            role="progressbar"
            aria-label="Time box used"
            aria-valuenow={Math.round(progress.fraction * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="mt-1 h-1.5 w-28 overflow-hidden rounded-full bg-sunken"
          >
            <div
              className={cx('h-full', progress.fraction >= 1 ? 'bg-warning-fill' : 'bg-brand')}
              style={{ width: `${progress.fraction * 100}%` }}
            />
          </div>
        )}
      </div>
      {canManage &&
        (editing ? (
          <form onSubmit={submit} className="flex items-end gap-2" aria-label="Session budget">
            <TextInput
              label="Budget (USD)"
              type="number"
              min="0.5"
              step="0.5"
              inputMode="decimal"
              placeholder="No limit"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="w-28"
            />
            <Button type="submit" variant="primary" size="md" loading={patch.isPending}>
              Save
            </Button>
            <Button size="md" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setEditing(true)} data-testid="set-budget">
            {cost.budgetUsd === null ? 'Set a budget' : 'Change budget'}
          </Button>
        ))}
    </div>
  );
}
