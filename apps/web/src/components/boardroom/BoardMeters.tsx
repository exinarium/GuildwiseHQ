import type { BoardStateDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { usePatchBoard } from '../../api/queries/boardroom.ts';
import { estimateText, formatUsd } from '../../lib/boardroom.ts';
import { SessionCountdown } from '../session/SessionCountdown.tsx';
import { cx } from '../ui/cx.ts';
import { Button, TextInput } from '../ui.tsx';

/** Live cost, the estimate for the next round, the round counter and (if set) the budget. The budget is a stop. */
export function BoardMeters({ state, canManage }: { state: BoardStateDto; canManage: boolean }) {
  const { cost, estimate, config } = state;
  const patch = usePatchBoard(state.threadId);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(cost.budgetUsd ? String(cost.budgetUsd) : '');
  const [limit, setLimit] = useState(state.time?.limitMinutes ? String(state.time.limitMinutes) : '');
  const ratio = cost.budgetUsd ? Math.min(1, cost.costUsd / cost.budgetUsd) : null;
  const over = config.stage !== 'ended' && config.stage !== 'setup';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    patch.mutate(
      {
        // only what changed
        ...(value.trim() === String(cost.budgetUsd ?? '')
          ? {}
          : { budgetUsd: value.trim() === '' ? null : Number(value) }),
        ...(limit.trim() === String(state.time?.limitMinutes ?? '')
          ? {}
          : { timeLimitMinutes: limit.trim() === '' ? null : Number(limit) }),
      },
      { onSuccess: () => setEditing(false) },
    );
  };
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm" data-testid="board-meters">
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
      <div className="min-w-[8rem]" data-testid="meter-round">
        <p className="text-xs text-subtle">Round</p>
        <p className="tnum font-medium text-fg">
          {Math.max(config.round, 0)} <span className="text-muted">of {config.roundCap}</span>
        </p>
      </div>
      {over && (
        <div className="min-w-[8rem]" data-testid="meter-estimate">
          <p className="text-xs text-subtle">Next round</p>
          <p className="font-medium text-fg">{estimateText(estimate)}</p>
        </div>
      )}
      <SessionCountdown time={state.time} />
      {canManage &&
        (editing ? (
          <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label="Session limits">
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
            <TextInput
              label="Time limit (minutes)"
              type="number"
              min="5"
              step="5"
              inputMode="numeric"
              placeholder="No limit"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
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
