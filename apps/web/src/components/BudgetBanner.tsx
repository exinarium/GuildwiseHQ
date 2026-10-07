import type { BudgetDto } from '@aom/shared';
import { Link } from 'react-router';
import { useOverrideBudget } from '../api/queries/costs.ts';
import { money, resetDay } from '../lib/money.ts';
import { Button, Callout } from './ui.tsx';

/**
 * The banner of a project whose month is nearly or fully spent. At 100% dispatching is paused (running shifts
 * finish): the manager sees why, when it resets, and (as Owner or Admin) the two ways out.
 */
export function BudgetBanner({
  budget,
  projectId,
  settingsTo,
  kind = 'projects',
  name,
}: {
  budget: BudgetDto | undefined;
  projectId: string;
  /** Where "Raise budget" goes (the budget panel of the project or interest settings). */
  settingsTo: string;
  kind?: 'projects' | 'interests';
  name?: string;
}) {
  const override = useOverrideBudget(kind, projectId);
  if (!budget || (budget.state !== 'paused' && budget.state !== 'warning' && budget.state !== 'overridden'))
    return null;
  const amounts =
    budget.monthlyMicros !== null && budget.spentMicros !== null
      ? `${money(budget.spentMicros, budget.currency)} of ${money(budget.monthlyMicros, budget.currency)}`
      : null;
  if (budget.state === 'paused')
    return (
      <Callout
        tone="danger"
        role="alert"
        data-testid="budget-banner"
        title={`${name ?? 'This project'} is paused: its monthly budget is used up`}
        className="mb-3"
        actions={
          budget.canEdit ? (
            <>
              <Link
                to={settingsTo}
                data-testid="budget-raise"
                className="inline-flex h-8 items-center rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken"
              >
                Raise budget
              </Link>
              <Button
                size="sm"
                variant="secondary"
                loading={override.isPending}
                data-testid="budget-override"
                onClick={() => override.mutate()}
              >
                Override for this month
              </Button>
            </>
          ) : undefined
        }
      >
        {amounts && <span className="tnum">{amounts} spent this month. </span>}
        Running shifts finish; nothing new starts until the budget is raised, overridden, or resets on{' '}
        {resetDay(budget.resetsAt)}.
      </Callout>
    );
  if (budget.state === 'overridden')
    return (
      <Callout tone="warning" role="status" data-testid="budget-banner" className="mb-3">
        The monthly budget is used up, but dispatching continues: it was overridden for this month.{' '}
        {amounts && <span className="tnum">{amounts}. </span>}It resets on {resetDay(budget.resetsAt)}.
      </Callout>
    );
  return (
    <Callout tone="warning" role="status" data-testid="budget-banner" className="mb-3">
      {amounts ? <span className="tnum">{amounts}</span> : 'Most of the monthly budget'} is spent. At 100%
      dispatching on this project pauses (running shifts finish). It resets on {resetDay(budget.resetsAt)}.
    </Callout>
  );
}
