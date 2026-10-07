import { money } from '../lib/money.ts';
import { cx } from './ui/cx.ts';

/**
 * Spend per day as bars (CSS, no chart library): one hue, a value label on hover/focus, the whole chart described
 * in words, and the numbers repeated in a table for screen readers.
 */
export function DayBars({
  days,
  currency,
}: {
  days: Array<{ date: string; costMicros: number }>;
  currency: string;
}) {
  const max = Math.max(1, ...days.map((d) => d.costMicros));
  const total = days.reduce((s, d) => s + d.costMicros, 0);
  if (days.length === 0) return <p className="text-sm text-muted">No spend in this range.</p>;
  const peak = days.reduce((a, b) => (b.costMicros > a.costMicros ? b : a));
  return (
    <figure data-testid="cost-days" className="m-0">
      <div
        role="img"
        aria-label={`Spend per day, ${days.length} days with spend, ${money(total, currency)} in total, highest on ${peak.date} at ${money(peak.costMicros, currency)}`}
        className="flex h-40 items-end gap-1 border-b border-line pb-px"
      >
        {days.map((d) => (
          <div
            key={d.date}
            className="group relative flex h-full min-w-1 flex-1 items-end"
            title={`${d.date}: ${money(d.costMicros, currency)}`}
          >
            <div
              className={cx('w-full rounded-t-[3px] bg-brand/80 group-hover:bg-brand')}
              style={{ height: `${Math.max(2, (d.costMicros / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-xs text-subtle tnum" aria-hidden="true">
        <span>{days[0]?.date}</span>
        <span>{days.at(-1)?.date}</span>
      </div>
      <table className="sr-only">
        <caption>Spend per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <td>{d.date}</td>
              <td>{money(d.costMicros, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** A thin share bar for a table cell: how much of the total this row is. */
export function ShareBar({ part, whole, label }: { part: number; whole: number; label: string }) {
  const pct = whole > 0 ? Math.min(100, (part / whole) * 100) : 0;
  return (
    <span
      className="flex items-center gap-2"
      role="img"
      aria-label={`${label}: ${Math.round(pct)}% of the total`}
    >
      <span className="h-1.5 w-24 overflow-hidden rounded-full bg-sunken" aria-hidden="true">
        <span className="block h-full rounded-full bg-brand/80" style={{ width: `${pct}%` }} />
      </span>
      <span className="tnum w-9 text-right text-xs text-muted" aria-hidden="true">
        {Math.round(pct)}%
      </span>
    </span>
  );
}
