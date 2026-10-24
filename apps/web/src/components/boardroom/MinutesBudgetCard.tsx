import type { BoardStateDto } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useMinutesChoice, usePatchBoard } from '../../api/queries/boardroom.ts';
import { formatUsd } from '../../lib/boardroom.ts';
import { Button, Callout, ErrorBox, TextInput } from '../ui.tsx';

/**
 * The cost limit ran out before the Chair could write the summary of the minutes. The session waits for its creator: write the
 * minutes without the summary, or raise the limit (which retries the summary). Nothing is written silently.
 */
export function MinutesBudgetCard({ state, canManage }: { state: BoardStateDto; canManage: boolean }) {
  const choose = useMinutesChoice(state.threadId);
  const patch = usePatchBoard(state.threadId);
  const [raising, setRaising] = useState(false);
  const [value, setValue] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const n = Number(value);
    if (!(n > 0)) return;
    patch.mutate({ budgetUsd: n }, { onSuccess: () => setRaising(false) });
  };
  return (
    <Callout
      tone="warning"
      role="alert"
      title="The budget is used up before the Chair could write the minutes summary"
      data-testid="minutes-budget-card"
    >
      <p>
        {`It has spent ${formatUsd(state.cost.costUsd)}${state.cost.budgetUsd ? ` of ${formatUsd(state.cost.budgetUsd)}` : ''}. The minutes wait for the session creator.`}
      </p>
      {canManage ? (
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={choose.isPending}
              onClick={() => choose.mutate()}
              data-testid="minutes-without-summary"
            >
              Write minutes without the Chair's summary
            </Button>
            <Button size="sm" onClick={() => setRaising(true)} disabled={raising} data-testid="raise-limit">
              Raise the limit
            </Button>
          </div>
          {raising && (
            <form onSubmit={submit} className="flex items-end gap-2" aria-label="Raise the limit">
              <TextInput
                label="New cost limit (USD)"
                type="number"
                min="0.5"
                step="0.5"
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="w-32"
              />
              <Button
                type="submit"
                variant="primary"
                loading={patch.isPending}
                disabled={!(Number(value) > 0)}
              >
                Raise
              </Button>
              <Button onClick={() => setRaising(false)}>Cancel</Button>
            </form>
          )}
          <ErrorBox error={choose.error ?? patch.error} />
        </div>
      ) : (
        <p className="mt-1">Waiting for the session creator to choose.</p>
      )}
    </Callout>
  );
}
