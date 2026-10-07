import type { BudgetDto } from '@aom/shared';
import { money, percentText } from '../lib/money.ts';
import { cx } from './ui/cx.ts';

const TONE = {
  none: 'bg-line',
  ok: 'bg-accent',
  warning: 'bg-warning-fill',
  paused: 'bg-danger-fill',
  overridden: 'bg-warning-fill',
} as const;

/** The month's spend against its budget: a bar with the amounts, usable as a progress bar by assistive tech. */
export function BudgetMeter({ budget, className }: { budget: BudgetDto; className?: string }) {
  if (budget.monthlyMicros === null || budget.spentMicros === null)
    return budget.state === 'none' ? null : (
      <p className={cx('text-sm text-muted', className)} data-testid="budget-state-only">
        {budget.state === 'paused' ? 'Paused: the monthly budget is used up.' : 'Budget in use.'}
      </p>
    );
  const pct = budget.percent ?? 0;
  const width = Math.max(2, Math.min(100, pct));
  return (
    <div className={cx('flex flex-col gap-1.5', className)} data-testid="budget-meter">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="tnum font-medium text-fg" data-testid="budget-spent">
          {money(budget.spentMicros, budget.currency)}{' '}
          <span className="font-normal text-muted">of {money(budget.monthlyMicros, budget.currency)}</span>
        </span>
        <span className="tnum text-muted">{percentText(pct)}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Spent this month"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.min(100, Math.round(pct))}
        aria-valuetext={`${percentText(pct)} of the monthly budget`}
        className="relative h-2 overflow-hidden rounded-full bg-sunken"
      >
        <div className={cx('h-full rounded-full', TONE[budget.state])} style={{ width: `${width}%` }} />
        {/* the 80% warning mark */}
        <span aria-hidden="true" className="absolute top-0 bottom-0 left-[80%] w-px bg-surface/80" />
      </div>
    </div>
  );
}
