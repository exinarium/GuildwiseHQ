import { VALUE_CARD_TYPES, type ValueReport } from '@aom/shared';
import { Download } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { useUpdateValueSettings, useValueReport, valueCsvUrl } from '../api/queries/value.ts';
import { money } from '../lib/money.ts';
import { Button, Disclosure, ErrorBox, Panel, TextInput, useToast } from './ui.tsx';

/** `~12.5 hours`, without trailing noise. */
const hoursText = (h: number) => `${Number.isInteger(h) ? h : h.toFixed(1)} ${h === 1 ? 'hour' : 'hours'}`;

/** The month's cards, estimated hours, usage and return against the month before. */
export function valueHeadline(r: ValueReport): string {
  const c = r.current;
  const ret = c.returnX === null ? '' : `, ~${c.returnX}× return`;
  return `${c.cards} ${c.cards === 1 ? 'card' : 'cards'}, ~${hoursText(c.hours)} of work, ${money(c.usageMicros, r.currency)} usage${ret}`;
}

function trendText(r: ValueReport): string {
  const { current: c, previous: p } = r;
  if (p.cards === 0 && c.cards === 0) return 'Nothing finished this month or last month yet.';
  const diff = c.cards - p.cards;
  const hoursDiff = Math.round((c.hours - p.hours) * 10) / 10;
  const sign = (n: number) => (n > 0 ? `up ${n}` : n < 0 ? `down ${-n}` : 'the same');
  return `Against ${p.month}: cards ${sign(diff)} (${p.cards}), estimated hours ${sign(hoursDiff)} (${hoursText(p.hours)}), usage ${money(p.usageMicros, r.currency)}.`;
}

function SettingsForm({ report }: { report: ValueReport }) {
  const update = useUpdateValueSettings();
  const toast = useToast();
  const s = report.settings;
  const [hours, setHours] = useState<Record<string, string>>(() =>
    Object.fromEntries(VALUE_CARD_TYPES.map((t) => [t, String(s.hoursByType[t] ?? 0)])),
  );
  const [rate, setRate] = useState(s.hourlyValue === null ? '' : String(s.hourlyValue));
  const nums = VALUE_CARD_TYPES.map((t) => Number(hours[t]));
  const valid = nums.every((n) => Number.isFinite(n) && n >= 0) && (rate === '' || Number(rate) >= 0);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    update.mutate(
      {
        hoursByType: Object.fromEntries(VALUE_CARD_TYPES.map((t, i) => [t, nums[i] as number])),
        hourlyValue: rate === '' ? null : Number(rate),
      },
      { onSuccess: () => toast.success('Estimates saved') },
    );
  };
  return (
    <form onSubmit={submit} aria-label="Value estimates" className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        How many hours would a person need for a finished card of each type? These are rough, and the defaults
        are a starting point.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {VALUE_CARD_TYPES.map((t) => (
          <TextInput
            key={t}
            label={`Hours per ${t}`}
            type="number"
            step="0.5"
            min={0}
            value={hours[t] ?? ''}
            onChange={(e) => setHours((h) => ({ ...h, [t]: e.target.value }))}
            data-testid={`value-hours-${t}`}
          />
        ))}
      </div>
      <div className="w-60">
        <TextInput
          label={`Value of one hour (${report.currency})`}
          type="number"
          step="any"
          min={0}
          value={rate}
          placeholder={String(s.hourlyValueEffective)}
          onChange={(e) => setRate(e.target.value)}
          data-testid="value-rate"
        />
      </div>
      <div>
        <Button type="submit" disabled={!valid} loading={update.isPending} data-testid="value-save">
          Save estimates
        </Button>
      </div>
      <ErrorBox error={update.error} />
    </form>
  );
}

/** Costs page: "This month: N cards, ~X hours of work, $Y usage, ~Z× return", the trend, next best actions, CSV. */
export function ValuePanel() {
  const q = useValueReport();
  if (q.isPending) return null;
  if (q.isError) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  if (!r.current) return null;
  return (
    <Panel title="What the agents delivered">
      <div data-testid="value-panel">
        <p className="text-lg font-semibold text-fg" data-testid="value-headline">
          This month: {valueHeadline(r)}
        </p>
        <p className="mt-1 text-sm text-muted" data-testid="value-trend">
          {trendText(r)}
        </p>
        <p className="mt-1 text-xs text-subtle">
          Hours are an estimate of what a person would have needed, by card type. They are not measured.
        </p>
        {r.nextActions.length > 0 && (
          <div className="mt-4">
            <h3 className="text-sm font-semibold text-fg">Next best actions</h3>
            <ul className="mt-1 flex flex-col gap-1 text-sm" data-testid="value-actions">
              {r.nextActions.map((a) => (
                <li key={`${a.kind}-${a.ref ?? a.title}`}>
                  {a.kind === 'stuck_card' && a.ref ? (
                    <Link className="font-medium text-brand underline" to={`/cards/${a.ref}`}>
                      {a.title}
                    </Link>
                  ) : (
                    <span className="font-medium text-fg">{a.title}</span>
                  )}
                  <span className="text-muted"> · {a.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a
            href={valueCsvUrl({ month: r.current.month })}
            download
            data-testid="value-export"
            className="inline-flex h-9 items-center gap-2 rounded-control border border-control bg-surface px-3 text-sm font-medium text-fg hover:bg-sunken [@media(pointer:coarse)]:h-11"
          >
            <Download aria-hidden="true" className="size-4" />
            Export value report (CSV)
          </a>
        </div>
        {r.settings.canEdit && (
          <div className="mt-4">
            <Disclosure summary="Adjust the estimates">
              <SettingsForm report={r} />
            </Disclosure>
          </div>
        )}
      </div>
    </Panel>
  );
}
