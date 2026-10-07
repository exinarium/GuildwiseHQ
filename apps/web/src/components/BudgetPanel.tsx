import { type BudgetDto, fromMicros } from '@aom/shared';
import { useState } from 'react';
import { useOverrideBudget, useSetBudget } from '../api/queries/costs.ts';
import { money, resetDay } from '../lib/money.ts';
import { BudgetMeter } from './BudgetMeter.tsx';
import { Badge, Button, ErrorBox, Panel, TextInput } from './ui.tsx';

const STATE_LABEL = {
  none: 'No budget',
  ok: 'On track',
  warning: 'Near the limit',
  paused: 'Paused',
  overridden: 'Overridden this month',
} as const;
const STATE_TONE = {
  none: 'neutral',
  ok: 'green',
  warning: 'amber',
  paused: 'red',
  overridden: 'amber',
} as const;

/**
 * "Monthly budget" of a project or of an interest's backing project (project and interest settings). Owner and Admin
 * set it; at 80% the BA and the desk are told, at 100% dispatching pauses until it is raised or overridden. The
 * month starts again on the 1st in the organization's time zone.
 */
export function BudgetPanel({
  kind,
  id,
  budget,
  what = 'project',
}: {
  kind: 'projects' | 'interests';
  /** The project id, or the interest id for `kind: 'interests'`. */
  id: string;
  budget: BudgetDto | undefined;
  what?: 'project' | 'interest';
}) {
  const set = useSetBudget(kind, id);
  const override = useOverrideBudget(kind, id);
  const current = budget?.monthlyMicros ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  if (!budget) return null;
  const text = draft ?? (current === null ? '' : String(fromMicros(current)));
  const parsed = Number(text);
  const valid = text !== '' && Number.isFinite(parsed) && parsed > 0;
  const dirty = valid && (current === null || Math.abs(parsed - fromMicros(current)) > 1e-9);
  const paused = budget.state === 'paused';

  return (
    <Panel
      title="Monthly budget"
      actions={
        <Badge tone={STATE_TONE[budget.state]} data-testid="budget-state">
          {STATE_LABEL[budget.state]}
        </Badge>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Agents' work on this {what} is priced at list prices and added up per month ({budget.month}). At 80%
        your BA and the desk are warned; at 100% nothing new starts on it (running shifts finish) until you
        raise the budget or override it for the month. It starts again on {resetDay(budget.resetsAt)}.
      </p>
      {budget.spentMicros !== null && (
        <p className="mb-3 text-sm text-muted tnum" data-testid="budget-spend-line">
          Spent this month:{' '}
          <span className="font-medium text-fg">{money(budget.spentMicros, budget.currency)}</span>
        </p>
      )}
      <BudgetMeter budget={budget} className="mb-4" />
      {budget.canEdit ? (
        <form
          aria-label="Monthly budget"
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty) set.mutate(parsed, { onSuccess: () => setDraft(null) });
          }}
        >
          <div className="w-48">
            <TextInput
              label={`Budget per month (${budget.currency})`}
              type="number"
              inputMode="decimal"
              min={0.01}
              step="any"
              placeholder="No budget"
              value={text}
              onChange={(e) => setDraft(e.target.value)}
              error={text !== '' && !valid ? 'Enter an amount above zero' : undefined}
              data-testid="budget-input"
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            disabled={!dirty || set.isPending}
            data-testid="budget-save"
          >
            Save budget
          </Button>
          {current !== null && (
            <Button
              disabled={set.isPending}
              data-testid="budget-clear"
              onClick={() => set.mutate(null, { onSuccess: () => setDraft(null) })}
            >
              Remove budget
            </Button>
          )}
          {paused && (
            <Button
              variant="secondary"
              loading={override.isPending}
              data-testid="budget-override-settings"
              onClick={() => override.mutate()}
            >
              Override for this month
            </Button>
          )}
        </form>
      ) : (
        <p className="text-sm text-subtle">Only the organization's Owner and Admins can change the budget.</p>
      )}
      <ErrorBox error={set.error ?? override.error} />
    </Panel>
  );
}
