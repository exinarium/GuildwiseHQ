import { FOLLOW_UP_DEFAULT_DAYS, FOLLOW_UP_MAX_DAYS } from '@aom/shared';
import { BellRing } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useFollowUpDays, useSetFollowUpDays } from '../../api/queries/agent-ux.ts';
import { Button, ErrorBox, Panel, TextInput, useToast } from '../ui.tsx';

/** Settings > General: after how many days an open Desk item or digest is chased. */
export function FollowUpPanel({ canChange }: { canChange: boolean }) {
  const q = useFollowUpDays();
  const set = useSetFollowUpDays();
  const toast = useToast();
  const current = q.data?.days ?? FOLLOW_UP_DEFAULT_DAYS;
  const [days, setDays] = useState(String(current));
  useEffect(() => setDays(String(current)), [current]);
  const n = Number(days);
  const valid = days.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= FOLLOW_UP_MAX_DAYS;
  return (
    <Panel data-testid="follow-up-settings">
      <div className="flex flex-wrap items-start gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-soft-fg">
          <BellRing aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-fg">Reminders for open items</h2>
          <p className="mt-1 text-sm text-muted">
            A decision, question or digest rating still open after this many days reminds the person it is
            waiting for, once per period. An item that sits with an agent is handed back to the agent once.
            Anyone can snooze an item. Set 0 to turn reminders off.
          </p>
          <form
            className="mt-3 flex flex-wrap items-end gap-3"
            aria-label="Reminder period"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) set.mutate(n, { onSuccess: () => toast.success('Reminder period saved') });
            }}
          >
            <div className="w-40">
              <TextInput
                label="Days"
                type="number"
                min={0}
                max={FOLLOW_UP_MAX_DAYS}
                value={days}
                readOnly={!canChange}
                onChange={(e) => setDays(e.target.value)}
                hint={`Default ${FOLLOW_UP_DEFAULT_DAYS}`}
              />
            </div>
            {canChange && (
              <Button
                type="submit"
                variant="primary"
                loading={set.isPending}
                disabled={!valid || n === current}
              >
                Save
              </Button>
            )}
          </form>
          <ErrorBox error={set.error} />
          {!canChange && <p className="mt-2 text-xs text-subtle">Only an Owner or Admin changes this.</p>}
        </div>
      </div>
    </Panel>
  );
}
