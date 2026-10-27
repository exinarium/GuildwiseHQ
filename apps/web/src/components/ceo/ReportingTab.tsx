import type { CeoSettings, NotifyChannels, NotifyKind } from '@aom/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { useCeoSettings, useSaveCeoSettings } from '../../api/queries/ceo.ts';
import { fromMicros, toMicros } from '../../lib/ceo.ts';
import { Button, Callout, ErrorBox, Panel, Spinner, TextInput, useToast } from '../ui.tsx';

const KINDS: Array<{ id: NotifyKind; label: string; hint: string }> = [
  { id: 'needs_you', label: 'It needs you', hint: 'A decision the CEO may not take.' },
  { id: 'urgent', label: 'Something urgent', hint: 'A loop, a budget, a hygiene problem.' },
  { id: 'task_done', label: 'A task is done', hint: 'A task you gave the CEO finished.' },
];
const CHANNELS: Array<{ id: keyof NotifyChannels; label: string }> = [
  { id: 'desk', label: 'Desk' },
  { id: 'email', label: 'E-mail' },
  { id: 'automation', label: 'Automation' },
];
const SIGNALS = [
  'loop',
  'repeated_approval',
  'blocked',
  'unclaimed',
  'rework',
  'finalize_failures',
  'repo_hygiene',
  'budget',
  'high_risk_waiting',
] as const;
const SIGNAL_LABEL: Record<(typeof SIGNALS)[number], string> = {
  loop: 'A card keeps failing (loop)',
  repeated_approval: 'The same approval over and over',
  blocked: 'A card blocked for a long time',
  unclaimed: 'A card nobody claims',
  rework: 'Rework piling up',
  finalize_failures: 'Finalize keeps failing',
  repo_hygiene: 'Repository hygiene',
  budget: 'A budget warning',
  high_risk_waiting: 'A high-risk card waiting for approval',
};

type Draft = Pick<
  CeoSettings,
  | 'reportAt'
  | 'notify'
  | 'quietHours'
  | 'urgentSignals'
  | 'blockedHours'
  | 'wakeWindowMinutes'
  | 'spendNoticeMicros'
  | 'orgBudgetMonthlyMicros'
>;

const pick = (s: CeoSettings): Draft => ({
  reportAt: s.reportAt,
  notify: s.notify,
  quietHours: s.quietHours,
  urgentSignals: s.urgentSignals,
  blockedHours: s.blockedHours,
  wakeWindowMinutes: s.wakeWindowMinutes,
  spendNoticeMicros: s.spendNoticeMicros,
  orgBudgetMonthlyMicros: s.orgBudgetMonthlyMicros,
});

export function ReportingTab({ owner, currency }: { owner: boolean; currency: string }) {
  const q = useCeoSettings();
  const save = useSaveCeoSettings();
  const toast = useToast();
  const [d, setD] = useState<Draft | null>(null);
  const [spendText, setSpendText] = useState('');
  const [budgetText, setBudgetText] = useState('');
  useEffect(() => {
    if (!q.data) return;
    setD(pick(q.data.settings));
    setSpendText(fromMicros(q.data.settings.spendNoticeMicros));
    setBudgetText(fromMicros(q.data.settings.orgBudgetMonthlyMicros));
  }, [q.data]);

  if (q.isPending) return <Spinner label="Loading the settings" />;
  if (!q.data || !d) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const edit = owner && q.data.canEdit;

  const toggleChannel = (k: NotifyKind, c: keyof NotifyChannels, on: boolean) =>
    setD({ ...d, notify: { ...d.notify, [k]: { ...d.notify[k], [c]: on } } });
  const toggleSignal = (s: string, on: boolean) =>
    setD({
      ...d,
      urgentSignals: on ? [...new Set([...d.urgentSignals, s])] : d.urgentSignals.filter((x) => x !== s),
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(
      { ...d, spendNoticeMicros: toMicros(spendText), orgBudgetMonthlyMicros: toMicros(budgetText) },
      { onSuccess: () => toast.success('Saved') },
    );
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" aria-label="Reporting and alerts">
      {!edit && (
        <Callout tone="info" role="note">
          Only the Owner can change these settings.
        </Callout>
      )}
      <Panel title="Daily report">
        <div className="max-w-xs">
          <TextInput
            label="Report time"
            type="time"
            disabled={!edit}
            value={d.reportAt ?? ''}
            onChange={(e) => setD({ ...d, reportAt: e.target.value || null })}
            hint="Empty follows the organization's reporting time."
          />
        </div>
      </Panel>

      <Panel title="When the CEO tells you">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Channels per kind of notification</caption>
            <thead>
              <tr className="text-xs text-muted">
                <th scope="col" className="py-1 pr-3 font-medium">
                  Kind
                </th>
                {CHANNELS.map((c) => (
                  <th key={c.id} scope="col" className="px-3 py-1 font-medium">
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {KINDS.map((k) => (
                <tr key={k.id}>
                  <th scope="row" className="py-2 pr-3 font-medium text-fg">
                    {k.label}
                    <span className="block text-xs font-normal text-subtle">{k.hint}</span>
                  </th>
                  {CHANNELS.map((c) => (
                    <td key={c.id} className="px-3 py-2">
                      <input
                        type="checkbox"
                        className="size-4"
                        disabled={!edit}
                        checked={d.notify[k.id][c.id]}
                        onChange={(e) => toggleChannel(k.id, c.id, e.target.checked)}
                        aria-label={`${k.label} by ${c.label}`}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-subtle">
          The automation channel can be forwarded to Slack or Teams: create an automation triggered by "The
          CEO notifies you".
        </p>
      </Panel>

      <Panel title="Quiet hours">
        <div className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              className="size-4"
              disabled={!edit}
              checked={d.quietHours !== null}
              onChange={(e) =>
                setD({ ...d, quietHours: e.target.checked ? { from: '22:00', to: '07:00' } : null })
              }
            />
            Hold e-mails that are not urgent until the daily report
          </label>
          {d.quietHours && (
            <div className="grid max-w-md grid-cols-2 gap-3">
              <TextInput
                label="From"
                type="time"
                disabled={!edit}
                value={d.quietHours.from}
                onChange={(e) =>
                  d.quietHours && setD({ ...d, quietHours: { ...d.quietHours, from: e.target.value } })
                }
              />
              <TextInput
                label="To"
                type="time"
                disabled={!edit}
                value={d.quietHours.to}
                onChange={(e) =>
                  d.quietHours && setD({ ...d, quietHours: { ...d.quietHours, to: e.target.value } })
                }
              />
            </div>
          )}
        </div>
      </Panel>

      <Panel title="What wakes the CEO at once">
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">Urgent signals</legend>
          {SIGNALS.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm text-fg">
              <input
                type="checkbox"
                className="size-4"
                disabled={!edit}
                checked={d.urgentSignals.includes(s)}
                onChange={(e) => toggleSignal(s, e.target.checked)}
              />
              {SIGNAL_LABEL[s]}
            </label>
          ))}
        </fieldset>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <TextInput
            label="Blocked for (hours)"
            type="number"
            min={1}
            max={72}
            disabled={!edit}
            value={String(d.blockedHours)}
            onChange={(e) => setD({ ...d, blockedHours: Number(e.target.value) })}
            hint="A blocked card counts after this long."
          />
          <TextInput
            label="Wake window (minutes)"
            type="number"
            min={1}
            max={60}
            disabled={!edit}
            value={String(d.wakeWindowMinutes)}
            onChange={(e) => setD({ ...d, wakeWindowMinutes: Number(e.target.value) })}
            hint="Normal wakes are batched for this long."
          />
        </div>
      </Panel>

      <Panel title="Spend">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label={`Daily spend notice (${currency})`}
            type="number"
            min={0}
            step="0.01"
            disabled={!edit}
            value={spendText}
            onChange={(e) => setSpendText(e.target.value)}
            hint="A soft notice when the CEO's own spend passes this in a day. Empty or 0: off."
          />
          <TextInput
            label={`Organization budget per month (${currency})`}
            type="number"
            min={0}
            step="0.01"
            disabled={!edit}
            value={budgetText}
            onChange={(e) => setBudgetText(e.target.value)}
            hint="Optional. At 80% you are told; at 100% the CEO continues in minimal mode (the daily report and the chat) and hires and model upgrades stop. Projects keep their own budgets. Empty or 0: no budget."
          />
        </div>
      </Panel>

      <ErrorBox error={save.error} />
      {edit && (
        <div>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
        </div>
      )}
    </form>
  );
}
